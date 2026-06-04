import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_MODEL, MAX_HISTORY_LENGTH, WEB_SEARCH_ENABLED, DATA_DIR } from "./config.js";
import { formatChineseDateTime, loadJsonFile, saveJsonFile, createDebouncedSave } from "./utils.js";
import { needsSearch, buildSearchContext } from "./search.js";

const client = new OpenAI({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL || undefined,
});

interface ConversationEntry {
  role: "user" | "assistant" | "system";
  content: string | OpenAI.ChatCompletionContentPart[];
}

const SYSTEM_PROMPT_BASE = "你是一个 helpful assistant，通过微信与用户对话。回复简洁友好，使用中文。当用户询问天气时，建议用户访问 https://www.msn.cn/zh-cn/weather/forecast/ 查看详细天气预报。";

// Mimo 服务端搜索工具定义
const MIMO_WEB_SEARCH_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "搜索互联网获取最新信息",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
      },
      required: ["query"],
    },
  },
};

function getSystemPromptWithTime(): string {
  const { dateStr, timeStr } = formatChineseDateTime();
  return `[当前时间] ${dateStr} ${timeStr}\n\n${SYSTEM_PROMPT_BASE}`;
}

// 持久化存储路径
const STORAGE_FILE = path.join(DATA_DIR, "weixin-claude-conversations.json");

// 内存中的对话历史
const conversations = new Map<string, ConversationEntry[]>();

// 防抖保存
const debouncedSave = createDebouncedSave(() => saveConversations(), 5);

function loadConversations(): void {
  const data = loadJsonFile<Record<string, ConversationEntry[]>>(STORAGE_FILE, {});
  for (const [userId, history] of Object.entries(data)) {
    if (Array.isArray(history)) {
      conversations.set(userId, history);
    }
  }
  if (conversations.size > 0) {
    console.log(`已加载 ${conversations.size} 个用户的对话历史`);
  }
}

export function saveConversations(): void {
  try {
    const data: Record<string, ConversationEntry[]> = {};
    for (const [userId, history] of conversations.entries()) {
      data[userId] = history;
    }
    saveJsonFile(STORAGE_FILE, data);
  } catch (err) {
    console.warn(`保存对话历史失败: ${err}`);
  }
}

loadConversations();

function getHistory(userId: string): ConversationEntry[] {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId)!;
}

function trimHistory(userId: string): void {
  if (MAX_HISTORY_LENGTH <= 0) return;
  const hist = getHistory(userId);
  if (hist.length > MAX_HISTORY_LENGTH) {
    hist.splice(0, hist.length - MAX_HISTORY_LENGTH);
  }
}

// ─── 对话功能 ───

function formatMessages(history: ConversationEntry[]): OpenAI.ChatCompletionMessageParam[] {
  return history.map((entry): OpenAI.ChatCompletionMessageParam => {
    if (entry.role === "system") {
      return { role: "system", content: entry.content as string };
    } else if (entry.role === "assistant") {
      return { role: "assistant", content: entry.content as string };
    } else {
      return { role: "user", content: entry.content };
    }
  });
}

/** 注入搜索上下文到消息列表 */
async function injectSearchContext(messages: OpenAI.ChatCompletionMessageParam[], userText: string): Promise<void> {
  if (!WEB_SEARCH_ENABLED || !needsSearch(userText)) return;

  const searchContext = await buildSearchContext(userText);
  if (!searchContext) return;

  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role === "user") {
    if (typeof lastMsg.content === "string") {
      lastMsg.content = lastMsg.content + searchContext;
    } else if (Array.isArray(lastMsg.content)) {
      lastMsg.content.push({ type: "text", text: searchContext });
    }
  }
  console.log(`[搜索] 已注入搜索结果`);
}

/** 尝试 Mimo 服务端搜索 */
async function tryMimoSearch(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string | null> {
  try {
    console.log(`[搜索] 尝试 Mimo 服务端搜索...`);
    const response = await client.chat.completions.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages,
      tools: [MIMO_WEB_SEARCH_TOOL],
      tool_choice: "auto",
    });

    let message = response.choices[0].message;

    // 如果返回了 tool_calls，需要完成工具调用协议
    if (message.tool_calls && message.tool_calls.length > 0 && !message.content) {
      console.log(`[搜索] Mimo 返回工具调用，正在完成协议...`);
      const toolMessages: OpenAI.ChatCompletionMessageParam[] = [
        ...messages,
        message as OpenAI.ChatCompletionAssistantMessageParam,
        ...message.tool_calls.map((tc): OpenAI.ChatCompletionToolMessageParam => ({
          role: "tool" as const,
          tool_call_id: tc.id,
          content: "搜索已完成，请根据搜索结果回答用户的问题。",
        })),
      ];

      const secondResponse = await client.chat.completions.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        messages: toolMessages,
      });

      message = secondResponse.choices[0].message;
    }

    if (message.content) {
      console.log(`[搜索] Mimo 服务端搜索成功`);
      return message.content;
    }
  } catch (err) {
    console.warn(`[搜索] Mimo 服务端搜索失败: ${err}`);
  }
  return null;
}

/** 调用 AI 生成回复 */
async function generateResponse(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> {
  const response = await client.chat.completions.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages,
  });
  return response.choices[0].message.content || "";
}

export async function chat(userId: string, userMessage: string): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: userMessage });
  trimHistory(userId);

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: getSystemPromptWithTime() },
      ...formatMessages(history),
    ];

    console.log(`[AI] 正在思考... (模型: ${CLAUDE_MODEL})`);
    const startTime = Date.now();

    let text = "";

    // 策略1: 尝试 Mimo 服务端搜索
    if (WEB_SEARCH_ENABLED && needsSearch(userMessage)) {
      text = await tryMimoSearch(messages) ?? "";
    }

    // 策略2: 如果服务端搜索没有结果，使用客户端搜索
    if (!text && WEB_SEARCH_ENABLED && needsSearch(userMessage)) {
      console.log(`[搜索] 使用客户端搜索...`);
      await injectSearchContext(messages, userMessage);
      text = await generateResponse(messages);
    }

    // 策略3: 不需要搜索的普通对话
    if (!text) {
      text = await generateResponse(messages);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AI] 思考完成 (耗时: ${elapsed}秒)`);

    history.push({ role: "assistant", content: text });
    debouncedSave();
    return text;
  } catch (err) {
    history.pop();
    throw err;
  }
}

export async function chatWithImage(
  userId: string,
  userText: string,
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
): Promise<string> {
  const history = getHistory(userId);

  const content: OpenAI.ChatCompletionContentPart[] = [
    {
      type: "image_url",
      image_url: {
        url: `data:${mediaType};base64,${imageBase64}`,
      },
    },
  ];
  if (userText) {
    content.push({ type: "text", text: userText });
  } else {
    content.push({ type: "text", text: "请描述这张图片" });
  }

  history.push({ role: "user", content });
  trimHistory(userId);

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: getSystemPromptWithTime() },
      ...formatMessages(history),
    ];

    // 注入搜索上下文
    await injectSearchContext(messages, userText);

    const imageSizeKB = Math.round(imageBase64.length * 3 / 4 / 1024);
    console.log(`[AI] 正在分析图片... (模型: ${CLAUDE_MODEL}, 图片: ${imageSizeKB}KB, 格式: ${mediaType})`);
    const startTime = Date.now();

    let text: string;
    try {
      text = await generateResponse(messages);
    } catch (apiErr: unknown) {
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      const statusCode = (apiErr as any)?.status || (apiErr as any)?.response?.status;
      console.error(`[AI] 图片 API 错误: ${errMsg}`);
      if (statusCode) console.error(`[AI] HTTP 状态码: ${statusCode}`);

      // 图片太大或格式不支持，回退到纯文本
      history.pop();
      const desc = userText ? `用户说: ${userText}` : "用户发送了一张图片";
      console.warn(`[AI] 图片分析失败，回退到纯文本模式`);
      return chat(userId, `[系统提示：图片分析失败，错误: ${errMsg.substring(0, 100)}] ${desc}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AI] 分析完成 (耗时: ${elapsed}秒)`);

    history.push({ role: "assistant", content: text });
    debouncedSave();
    return text;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[AI] 图片处理错误: ${errMsg}`);
    history.pop();
    throw err;
  }
}

export async function chatWithVideo(
  userId: string,
  userText: string,
  videoBase64: string,
): Promise<string> {
  const history = getHistory(userId);

  const content: OpenAI.ChatCompletionContentPart[] = [
    {
      type: "video_url" as any,
      video_url: {
        url: `data:video/mp4;base64,${videoBase64}`,
      },
    } as any,
    { type: "text", text: userText || "请描述这个视频中发生了什么" },
  ];

  history.push({ role: "user", content });
  trimHistory(userId);

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: getSystemPromptWithTime() },
      ...formatMessages(history),
    ];

    const videoSizeKB = Math.round(videoBase64.length * 3 / 4 / 1024);
    console.log(`[AI] 正在分析视频... (模型: ${CLAUDE_MODEL}, 视频: ${videoSizeKB}KB)`);
    const startTime = Date.now();

    let text: string;
    try {
      text = await generateResponse(messages);
    } catch (apiErr: unknown) {
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      console.error(`[AI] 视频 API 错误: ${errMsg}`);
      history.pop();
      const desc = userText ? `用户说: ${userText}` : "用户发送了一个视频";
      return chat(userId, `[系统提示：视频分析失败，错误: ${errMsg.substring(0, 100)}] ${desc}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AI] 分析完成 (耗时: ${elapsed}秒)`);

    history.push({ role: "assistant", content: text });
    debouncedSave();
    return text;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[AI] 视频处理错误: ${errMsg}`);
    history.pop();
    throw err;
  }
}

export function clearHistory(userId: string): void {
  conversations.delete(userId);
  saveConversations();
}
