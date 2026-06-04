import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_MODEL, MAX_HISTORY_LENGTH, WEB_SEARCH_ENABLED, DATA_DIR } from "./config.js";

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
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" });
  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `[当前时间] ${dateStr} ${timeStr}\n\n${SYSTEM_PROMPT_BASE}`;
}

// 持久化存储路径
const STORAGE_DIR = DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, "weixin-claude-conversations.json");

// 内存中的对话历史
const conversations = new Map<string, ConversationEntry[]>();

// 保存计数器，批量保存
let saveCounter = 0;
const SAVE_INTERVAL = 5;

function loadConversations(): void {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      console.log("对话历史文件不存在，将创建新文件");
      return;
    }
    const data = fs.readFileSync(STORAGE_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null) {
      for (const [userId, history] of Object.entries(parsed)) {
        if (Array.isArray(history)) {
          conversations.set(userId, history as ConversationEntry[]);
        }
      }
      console.log(`已加载 ${conversations.size} 个用户的对话历史`);
    }
  } catch (err) {
    console.warn(`加载对话历史失败: ${err}`);
  }
}

export function saveConversations(): void {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    const data: Record<string, ConversationEntry[]> = {};
    for (const [userId, history] of conversations.entries()) {
      data[userId] = history;
    }
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn(`保存对话历史失败: ${err}`);
  }
}

function debouncedSave(): void {
  saveCounter++;
  if (saveCounter >= SAVE_INTERVAL) {
    saveConversations();
    saveCounter = 0;
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

// ─── 搜索功能 ───

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** 判断是否是天气查询 */
function isWeatherQuery(text: string): boolean {
  return /天气|气温|温度|下雨|晴天|阴天|weather/i.test(text);
}

/** 从查询中提取地点 */
function extractLocation(text: string): string {
  // 常见地点模式
  const patterns = [
    /(.{2,6}?)天气/,
    /(.{2,6}?)气温/,
    /(.{2,6}?)温度/,
    /(.{2,6}?)下雨/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const loc = m[1].replace(/今天|明天|后天|昨天|现在|这|那/g, "").trim();
      if (loc.length >= 2) return loc;
    }
  }
  return "";
}

/** 获取天气信息 - 使用 wttr.in API */
async function fetchWeather(location: string): Promise<string> {
  const loc = location || "杭州";
  try {
    console.log(`[天气] 正在获取: ${loc}`);
    const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1&lang=zh`;
    const response = await fetch(url, {
      headers: { "User-Agent": "curl/7.0" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`wttr.in returned ${response.status}`);
    }

    const data = await response.json() as any;
    const current = data.current_condition?.[0];
    const today = data.weather?.[0];

    if (!current && !today) return "";

    const parts: string[] = [];

    // 地点
    const area = data.nearest_area?.[0];
    if (area) {
      const areaName = area.areaName?.[0]?.value || "";
      const cityName = area.region?.[0]?.value || "";
      const country = area.country?.[0]?.value || "";
      parts.push(`地点: ${areaName}, ${cityName}, ${country}`);
    }

    // 当前天气
    if (current) {
      const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || "";
      const temp = current.temp_C || "";
      const feelsLike = current.FeelsLikeC || "";
      const humidity = current.humidity || "";
      const windSpeed = current.windspeedKmph || "";
      const windDir = current.winddir16Point || "";
      const visibility = current.visibility || "";

      parts.push(`天气: ${desc}`);
      parts.push(`温度: ${temp}°C (体感 ${feelsLike}°C)`);
      parts.push(`湿度: ${humidity}%`);
      parts.push(`风: ${windDir} ${windSpeed}km/h`);
      if (visibility) parts.push(`能见度: ${visibility}km`);
    }

    // 今日预报
    if (today) {
      const maxTemp = today.maxtempC || "";
      const minTemp = today.mintempC || "";
      const sunrise = today.astronomy?.[0]?.sunrise || "";
      const sunset = today.astronomy?.[0]?.sunset || "";
      parts.push(`今日: ${minTemp}°C ~ ${maxTemp}°C`);
      if (sunrise) parts.push(`日出: ${sunrise} 日落: ${sunset}`);
    }

    console.log(`[天气] 获取成功`);
    return parts.join("\n");
  } catch (err) {
    console.error(`[天气] wttr.in 失败: ${err}`);

    // 备用：必应搜索
    try {
      const query = `${loc}今天天气`;
      console.log(`[天气] 备用搜索: ${query}`);
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return "";
      const html = await response.text();
      const weatherData: string[] = [];

      const tempMatch = html.match(/(\d+)\s*[°℃]/);
      if (tempMatch) weatherData.push(`温度: ${tempMatch[1]}°C`);

      const conditions = ["晴", "多云", "阴", "小雨", "中雨", "大雨", "雷阵雨", "雪", "雾", "霾"];
      for (const c of conditions) {
        if (html.includes(c)) {
          weatherData.push(`天气: ${c}`);
          break;
        }
      }

      if (weatherData.length > 0) {
        console.log(`[天气] 从必应获取到天气`);
        return weatherData.join("\n");
      }

      return "";
    } catch {
      return "";
    }
  }
}

async function bingSearch(query: string): Promise<SearchResult[]> {
  try {
    console.log(`[搜索] 正在搜索: ${query}`);
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Bing search failed: ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    const blocks = html.split(/class="b_algo"/);
    for (let i = 1; i < blocks.length && results.length < 5; i++) {
      const block = blocks[i];
      const titleMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

      if (titleMatch) {
        const url = titleMatch[1];
        const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        if (title && url.startsWith("http")) {
          results.push({ title, snippet, url });
        }
      }
    }

    if (results.length === 0) {
      const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
        const url = match[1];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        if (title && !url.includes("bing.com") && !url.includes("microsoft.com")) {
          results.push({ title, snippet: "", url });
        }
      }
    }

    console.log(`[搜索] 找到 ${results.length} 条结果`);
    return results;
  } catch (err) {
    console.error(`[搜索] 搜索失败: ${err}`);
    return [];
  }
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r, i) => {
    const parts = [`${i + 1}. ${r.title}`];
    if (r.snippet) parts.push(`   ${r.snippet}`);
    if (r.url) parts.push(`   ${r.url}`);
    return parts.join("\n");
  });
  return `\n\n[搜索结果: "${query}"]\n${lines.join("\n")}\n[搜索结果结束]`;
}

/** 判断是否需要搜索 */
function needsSearch(text: string): boolean {
  const keywords = [
    "天气", "气温", "温度", "下雨",
    "新闻", "最新", "今天", "明天", "昨天",
    "股价", "比分", "赛事", "航班", "快递",
    "谁是", "什么是", "怎么样", "多少钱",
    "搜索", "查一下", "帮我查", "帮我搜",
    "weather", "news", "latest",
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
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

export async function chat(userId: string, userMessage: string): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: userMessage });
  trimHistory(userId);

  try {
    const needSearch = WEB_SEARCH_ENABLED && needsSearch(userMessage);
    const isWeather = isWeatherQuery(userMessage);

    // 构建基础消息
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: getSystemPromptWithTime() },
      ...formatMessages(history),
    ];

    console.log(`[AI] 正在思考... (模型: ${CLAUDE_MODEL})`);
    const startTime = Date.now();

    // 策略1: 尝试 Mimo 服务端搜索
    let text = "";
    if (needSearch) {
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
          text = message.content;
          console.log(`[搜索] Mimo 服务端搜索成功`);
        }
      } catch (err) {
        console.warn(`[搜索] Mimo 服务端搜索失败: ${err}`);
      }
    }

    // 策略2: 如果服务端搜索没有结果，使用客户端搜索
    if (!text && needSearch) {
      console.log(`[搜索] 使用客户端搜索...`);
      let searchContext = "";

      if (isWeather) {
        const location = extractLocation(userMessage);
        const weatherData = await fetchWeather(location);
        if (weatherData) {
          searchContext = `\n\n[天气实况${location ? ": " + location : ""}]\n${weatherData}\n[天气信息结束]\n建议用户访问 https://www.msn.cn/zh-cn/weather/forecast/ 查看详细预报`;
        } else {
          const results = await bingSearch(userMessage + " 天气实况");
          searchContext = formatSearchResults(userMessage, results);
        }
      } else {
        const results = await bingSearch(userMessage);
        searchContext = formatSearchResults(userMessage, results);
      }

      if (searchContext) {
        // 注入搜索结果到最后一条用户消息
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
          lastMsg.content = lastMsg.content + searchContext;
        }
        console.log(`[搜索] 已注入客户端搜索结果`);
      }

      const response = await client.chat.completions.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        messages,
      });

      text = response.choices[0].message.content || "";
    }

    // 策略3: 不需要搜索的普通对话
    if (!text) {
      const response = await client.chat.completions.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        messages,
      });
      text = response.choices[0].message.content || "";
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
    // 判断是否需要搜索
    let searchContext = "";
    if (WEB_SEARCH_ENABLED && needsSearch(userText)) {
      if (isWeatherQuery(userText)) {
        const location = extractLocation(userText);
        const weatherData = await fetchWeather(location);
        if (weatherData) {
          searchContext = `\n\n[天气实况${location ? ": " + location : ""}]\n${weatherData}\n[天气信息结束]\n建议用户访问 https://www.msn.cn/zh-cn/weather/forecast/ 查看详细预报`;
        } else {
          const results = await bingSearch(userText + " 天气实况");
          searchContext = formatSearchResults(userText, results);
        }
      } else {
        const results = await bingSearch(userText);
        searchContext = formatSearchResults(userText, results);
      }
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: getSystemPromptWithTime() },
      ...formatMessages(history),
    ];

    // 将搜索结果注入到最后一条用户消息
    if (searchContext) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === "user") {
        if (typeof lastMsg.content === "string") {
          lastMsg.content = lastMsg.content + searchContext;
        } else if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push({ type: "text", text: searchContext });
        }
      }
    }

    const imageSizeKB = Math.round(imageBase64.length * 3 / 4 / 1024);
    console.log(`[AI] 正在分析图片... (模型: ${CLAUDE_MODEL}, 图片: ${imageSizeKB}KB, 格式: ${mediaType})`);
    const startTime = Date.now();

    let response;
    try {
      response = await client.chat.completions.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        messages,
      });
    } catch (apiErr: any) {
      const errMsg = apiErr?.message ?? String(apiErr);
      const statusCode = apiErr?.status || apiErr?.response?.status;
      const responseBody = apiErr?.response?.data ? JSON.stringify(apiErr.response.data) : "";
      console.error(`[AI] 图片 API 错误: ${errMsg}`);
      if (statusCode) console.error(`[AI] HTTP 状态码: ${statusCode}`);
      if (responseBody) console.error(`[AI] 响应内容: ${responseBody.substring(0, 500)}`);
      console.error(`[AI] 图片前50字符: ${imageBase64.substring(0, 50)}`);

      // 图片太大或格式不支持，回退到纯文本
      history.pop();
      const desc = userText ? `用户说: ${userText}` : "用户发送了一张图片";
      console.warn(`[AI] 图片分析失败，回退到纯文本模式`);
      return chat(userId, `[系统提示：图片分析失败，错误: ${errMsg.substring(0, 100)}] ${desc}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AI] 分析完成 (耗时: ${elapsed}秒)`);

    const text = response.choices[0].message.content || "";

    history.push({ role: "assistant", content: text });
    debouncedSave();
    return text;
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
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

    let response;
    try {
      response = await client.chat.completions.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        messages,
      });
    } catch (apiErr: any) {
      const errMsg = apiErr?.message ?? String(apiErr);
      console.error(`[AI] 视频 API 错误: ${errMsg}`);
      history.pop();
      const desc = userText ? `用户说: ${userText}` : "用户发送了一个视频";
      return chat(userId, `[系统提示：视频分析失败，错误: ${errMsg.substring(0, 100)}] ${desc}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AI] 分析完成 (耗时: ${elapsed}秒)`);

    const text = response.choices[0].message.content || "";

    history.push({ role: "assistant", content: text });
    debouncedSave();
    return text;
  } catch (err: any) {
    console.error(`[AI] 视频处理错误: ${err?.message}`);
    history.pop();
    throw err;
  }
}

export function clearHistory(userId: string): void {
  conversations.delete(userId);
  saveConversations();
}
