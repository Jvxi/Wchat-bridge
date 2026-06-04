import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
  extractText,
  findImageItem,
  findVoiceItem,
  findVideoItem,
  getConfig,
  sendTyping,
  TypingStatus,
  type WeixinMessage,
} from "./iLink.js";
import { chat, chatWithImage, chatWithVideo, clearHistory } from "./claude.js";
import { downloadAndDecryptImage, downloadVoice, downloadVideo, recognizeSpeech } from "./media.js";
import { sendVoiceMessage } from "./media-upload.js";
import { synthesizeSpeech } from "./tts.js";
import { resolveEmojiCommand, parseEmojiBindingsCommand, setBinding, removeBinding, listBindings, formatBindingsListMessage } from "./emoji-bindings.js";
import type { WeixinCredentials } from "./auth.js";
import { LONG_POLL_TIMEOUT_MS, ASR_ENABLED, CLAUDE_MODEL, DATA_DIR } from "./config.js";

// ─── 文件日志 ───
const LOG_DIR = DATA_DIR;
const LOG_FILE = path.join(LOG_DIR, "bridge.log");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTimestamp(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function writeLog(level: string, args: any[]): void {
  try {
    ensureLogDir();
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    const line = `[${getTimestamp()}] [${level}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, "utf-8");
  } catch {}
}

// 拦截 console 输出到文件
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args: any[]) => {
  writeLog("INFO", args);
  origLog.apply(console, args);
};
console.warn = (...args: any[]) => {
  writeLog("WARN", args);
  origWarn.apply(console, args);
};
console.error = (...args: any[]) => {
  writeLog("ERROR", args);
  origError.apply(console, args);
};

// 启动时清空旧日志
ensureLogDir();
fs.writeFileSync(LOG_FILE, `=== WeChat Claude Bridge Log ===\n启动时间: ${getTimestamp()}\n\n`, "utf-8");

// Context token 持久化路径
const CONTEXT_TOKENS_FILE = path.join(DATA_DIR, "context-tokens.json");

// Per-user context token cache (needed to reply)
const contextTokens = new Map<string, string>();

// Per-user typing ticket cache
const typingTickets = new Map<string, string>();

// Per-user voice mode (true = 回复语音)
const voiceMode = new Map<string, boolean>();

// Dedup: track processed message keys (keep last 500)
const processedMsgKeys = new Set<string>();
const MAX_SEEN_MSG_KEYS = 500;

/** 加载持久化的 context tokens */
function loadContextTokens(): void {
  try {
    if (!fs.existsSync(CONTEXT_TOKENS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CONTEXT_TOKENS_FILE, "utf-8"));
    if (typeof data === "object" && data !== null) {
      for (const [userId, token] of Object.entries(data)) {
        if (typeof token === "string") {
          contextTokens.set(userId, token);
        }
      }
      console.log(`已加载 ${contextTokens.size} 个用户的 context token`);
    }
  } catch {}
}

/** 保存 context tokens 到文件 */
function saveContextTokens(): void {
  try {
    const dir = path.dirname(CONTEXT_TOKENS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data: Record<string, string> = {};
    for (const [userId, token] of contextTokens.entries()) {
      data[userId] = token;
    }
    fs.writeFileSync(CONTEXT_TOKENS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

// 启动时加载 context tokens
loadContextTokens();

function makeMsgKey(msg: WeixinMessage): string {
  // Prefer message_id if available
  if (msg.message_id != null) return `mid:${msg.message_id}`;
  // Fallback: composite key from available fields
  const text = extractText(msg.item_list);
  return `f:${msg.from_user_id ?? ""}:${msg.create_time_ms ?? ""}:${msg.seq ?? ""}:${text.slice(0, 50)}`;
}

function markProcessed(key: string): boolean {
  if (processedMsgKeys.has(key)) return false;
  processedMsgKeys.add(key);
  if (processedMsgKeys.size > MAX_SEEN_MSG_KEYS) {
    const iter = processedMsgKeys.values();
    for (let i = 0; i < 100; i++) iter.next();
    const cutoff = iter.next().value as string | undefined;
    if (cutoff !== undefined) {
      for (const k of processedMsgKeys) {
        if (k <= cutoff) processedMsgKeys.delete(k);
        else break;
      }
    }
  }
  return true;
}

function setContextToken(userId: string, token: string) {
  contextTokens.set(userId, token);
  saveContextTokens();
}

function getContextToken(userId: string): string | undefined {
  return contextTokens.get(userId);
}

async function fetchTypingTicket(creds: WeixinCredentials, userId: string, contextToken?: string): Promise<string | undefined> {
  try {
    const resp = await getConfig({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
      ilinkUserId: userId,
      contextToken,
    });
    if (resp.typing_ticket) {
      typingTickets.set(userId, resp.typing_ticket);
      return resp.typing_ticket;
    }
  } catch {}
  return typingTickets.get(userId);
}

async function startTyping(creds: WeixinCredentials, userId: string) {
  const ticket = typingTickets.get(userId) ?? await fetchTypingTicket(creds, userId, getContextToken(userId));
  if (!ticket) return;
  try {
    await sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
      ilinkUserId: userId,
      typingTicket: ticket,
      status: TypingStatus.TYPING,
    });
  } catch {}
}

async function stopTyping(creds: WeixinCredentials, userId: string) {
  const ticket = typingTickets.get(userId);
  if (!ticket) return;
  try {
    await sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
      ilinkUserId: userId,
      typingTicket: ticket,
      status: TypingStatus.CANCEL,
    });
  } catch {}
}

function getSystemStatus(): string {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const uptime = os.uptime();
  const load = os.loadavg();

  // CPU usage (average across cores)
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  // Disk usage
  let diskInfo = "未知";
  try {
    if (process.platform === "win32") {
      const raw = execSync("wmic logicaldisk where DeviceID='C:' get Size,FreeSpace /format:csv", { encoding: "utf-8", timeout: 5000 });
      const lines = raw.trim().split("\n").filter(l => l.includes(","));
      if (lines.length > 0) {
        const parts = lines[lines.length - 1].split(",");
        const free = parseInt(parts[1]);
        const total = parseInt(parts[2]);
        if (!isNaN(free) && !isNaN(total)) {
          const used = total - free;
          diskInfo = `${fmtBytes(used)} / ${fmtBytes(total)} (${((used / total) * 100).toFixed(1)}%)`;
        }
      }
    } else {
      const raw = execSync("df -B1 / | tail -1", { encoding: "utf-8", timeout: 5000 });
      const parts = raw.trim().split(/\s+/);
      if (parts.length >= 4) {
        const total = parseInt(parts[1]);
        const used = parseInt(parts[2]);
        diskInfo = `${fmtBytes(used)} / ${fmtBytes(total)} (${((used / total) * 100).toFixed(1)}%)`;
      }
    }
  } catch {}

  // Process info
  const procMem = process.memoryUsage();
  const nodeVersion = process.version;
  const platform = `${os.type()} ${os.release()}`;
  const hostname = os.hostname();

  const lines = [
    `=== 系统状态 ===`,
    `主机: ${hostname}`,
    `平台: ${platform}`,
    `Node: ${nodeVersion}`,
    `运行时间: ${fmtUptime(uptime)}`,
    ``,
    `CPU: ${cpuUsage.toFixed(1)}% (${cpus.length} 核)`,
    `负载: ${load.map(l => l.toFixed(2)).join(" / ")}`,
    ``,
    `内存: ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (${((usedMem / totalMem) * 100).toFixed(1)}%)`,
    `可用: ${fmtBytes(freeMem)}`,
    `磁盘(C:): ${diskInfo}`,
    ``,
    `进程内存: ${fmtBytes(procMem.rss)}`,
    `堆内存: ${fmtBytes(procMem.heapUsed)} / ${fmtBytes(procMem.heapTotal)}`,
  ];
  return lines.join("\n");
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分钟`);
  return parts.join("") || "< 1分钟";
}
/** 自然语言删除/清除指令识别 */
function isDeleteCommand(text: string): boolean {
  return /清除|清空|删除|重置/.test(text) &&
    /聊天|对话|记录|历史|消息/.test(text);
}

async function processMessage(msg: WeixinMessage, creds: WeixinCredentials): Promise<void> {
  const from = msg.from_user_id;
  if (!from) return;

  // Cache context token
  if (msg.context_token) setContextToken(from, msg.context_token);

  let text = extractText(msg.item_list);
  const imageItem = findImageItem(msg.item_list);
  const voiceItem = findVoiceItem(msg.item_list);
  const videoItem = findVideoItem(msg.item_list);

  // Check for emoji bindings first
  const emojiMatch = resolveEmojiCommand(text);
  if (emojiMatch) {
    const emojiCommand = emojiMatch.command;
    const remainder = emojiMatch.remainder;

    // If there's remainder text, append it after processing the command
    if (remainder) {
      text = remainder;
    } else {
      // Process as command
      text = emojiCommand;
    }
  }

  // Handle emoji bindings commands
  const bindingsCmd = parseEmojiBindingsCommand(text);
  if (bindingsCmd) {
    if (bindingsCmd.type === "list") {
      const map = listBindings();
      await reply(from, formatBindingsListMessage(map), creds);
      return;
    }
    if (bindingsCmd.type === "bind") {
      setBinding(bindingsCmd.emoji, bindingsCmd.command);
      await reply(from, `已绑定: ${bindingsCmd.emoji} → ${bindingsCmd.command}`, creds);
      return;
    }
    if (bindingsCmd.type === "unbind") {
      const removed = removeBinding(bindingsCmd.emoji);
      await reply(from, removed ? `已解绑: ${bindingsCmd.emoji}` : `未找到绑定: ${bindingsCmd.emoji}`, creds);
      return;
    }
  }

  // Handle commands
  if (text === "/clear" || text === "/重置" || text === "/delete" || text === "/删除" || isDeleteCommand(text)) {
    clearHistory(from);
    await reply(from, "对话已重置，聊天记录已清除。", creds);
    return;
  }

  if (text === "/help" || text === "/帮助") {
    const helpText = `可用命令:
/clear(/delete) - 重置对话
说"清除聊天记录"也行
/status - 系统状态
/voice - 切换语音回复模式
/bindings - 查看表情绑定
/bind [表情] /命令 - 绑定表情
/unbind [表情] - 解除绑定
/help - 显示帮助

表情绑定示例:
/bind [微笑] /status`;
    await reply(from, helpText, creds);
    return;
  }

  if (text === "/voice" || text === "/语音") {
    const current = voiceMode.get(from) || false;
    voiceMode.set(from, !current);
    const status = !current ? "开启" : "关闭";
    await reply(from, `语音回复模式已${status}`, creds);
    return;
  }

  if (text === "/status" || text === "/状态") {
    const status = getSystemStatus();
    await reply(from, status, creds);
    return;
  }

  // Start typing indicator
  await startTyping(creds, from);

  try {
    let response: string;

    if (imageItem) {
      // Image message: download, decrypt, send to Claude
      console.log(`[AI] 正在处理图片消息...`);
      const imageData = await downloadAndDecryptImage(imageItem);
      if (imageData) {
        console.log(`[AI] 图片下载完成，正在调用 AI 分析...`);
        response = await chatWithImage(from, text || "请描述这张图片", imageData.base64, imageData.mediaType);
      } else if (text) {
        console.log(`[AI] 图片下载失败，正在处理文字...`);
        response = await chat(from, text);
      } else {
        response = "收到图片，但无法解密。";
      }
    } else if (videoItem) {
      // Video message: download and analyze
      console.log(`[AI] 正在处理视频消息...`);
      const videoBase64 = await downloadVideo(videoItem);
      if (videoBase64) {
        console.log(`[AI] 视频下载完成，正在调用 AI 分析...`);
        response = await chatWithVideo(from, text || "请描述这个视频中发生了什么", videoBase64);
      } else if (text) {
        console.log(`[AI] 视频下载失败，正在处理文字...`);
        response = await chat(from, text);
      } else {
        response = "收到视频，但无法下载。";
      }
    } else if (voiceItem && ASR_ENABLED) {
      // Voice message: check for WeChat transcription first, then try ASR
      console.log(`[AI] 正在处理语音消息...`);

      // 优先使用微信自带的语音转文字
      const voiceText = voiceItem.text?.trim();
      if (voiceText) {
        console.log(`[AI] 微信语音转文字: ${voiceText}`);
        response = await chat(from, voiceText);
      } else {
        // 微信没有转文字，尝试 ASR
        const voiceData = await downloadVoice(voiceItem);
        if (voiceData) {
          console.log(`[AI] 语音下载完成，正在识别... (格式: ${voiceData.format})`);
          const recognizedText = await recognizeSpeech(voiceData.base64, voiceData.format);
          if (recognizedText) {
            console.log(`[AI] 语音识别结果: ${recognizedText}`);
            console.log(`[AI] 正在调用 AI 回复...`);
            response = await chat(from, recognizedText);
          } else if (text) {
            console.log(`[AI] 语音识别失败，正在处理文字...`);
            response = await chat(from, text);
          } else {
            response = "收到语音，但无法识别内容。请在微信中开启语音转文字功能，或用文字发送。";
          }
        } else if (text) {
          console.log(`[AI] 语音下载失败，正在处理文字...`);
          response = await chat(from, text);
        } else {
          response = "收到语音，但无法识别内容。请在微信中开启语音转文字功能，或用文字发送。";
        }
      }
    } else if (text) {
      console.log(`[AI] 正在调用 AI 回复...`);
      response = await chat(from, text);
    } else {
      return; // No text, image, or voice, ignore
    }

    console.log(`[AI] 回复完成:`);
    console.log(`----------------------------------------`);
    console.log(response);
    console.log(`----------------------------------------`);

    // 检查是否启用语音模式
    if (voiceMode.get(from)) {
      console.log(`[TTS] 语音模式已启用，正在合成语音...`);
      const audioBuf = await synthesizeSpeech(response);
      if (audioBuf) {
        // 保存音频到 Audio 文件夹
        const tmpDir = path.join(DATA_DIR, "audio");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `tts_${Date.now()}.wav`);
        fs.writeFileSync(tmpPath, audioBuf);
        console.log(`[TTS] 音频已保存: ${tmpPath} (${audioBuf.length} bytes)`);

        try {
          // WAV 需要转换为 SILK 才能发送为微信语音
          const { encode } = await import("silk-wasm");
          console.log(`[TTS] 正在转换为 SILK 格式...`);
          const silkResult = await encode(audioBuf, 24000);
          const silkBuf = Buffer.from(silkResult.data);
          const silkPath = path.join(tmpDir, `tts_${Date.now()}.silk`);
          fs.writeFileSync(silkPath, silkBuf);
          console.log(`[TTS] SILK 转换完成: ${silkPath} (${silkBuf.length} bytes)`);

          // 等待上传完成后再清理
          const ctxToken = getContextToken(from) || "";
          console.log(`[TTS] 开始上传语音... contextToken=${ctxToken ? "有" : "无"}`);
          await sendVoiceMessage(creds.baseUrl, creds.botToken, from, ctxToken, silkPath);
          console.log(`[TTS] 语音消息发送完成`);

          // 延迟清理
          setTimeout(() => {
            try { fs.unlinkSync(silkPath); } catch {}
            try { fs.unlinkSync(tmpPath); } catch {}
          }, 10000);
        } catch (err) {
          console.warn(`[TTS] 语音发送失败，回退到文字: ${err}`);
          await reply(from, response, creds);
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } else {
        console.warn(`[TTS] 语音合成失败，回退到文字`);
        await reply(from, response, creds);
      }
    } else {
      await reply(from, response, creds);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] 处理消息失败: ${errMsg}`);
    await reply(from, `处理出错: ${errMsg}`, creds).catch(() => {});
  } finally {
    await stopTyping(creds, from);
  }
}

async function reply(to: string, text: string, creds: WeixinCredentials): Promise<void> {
  if (!text) return;
  try {
    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
      to,
      text,
      contextToken: getContextToken(to),
    });
  } catch (err) {
    console.error(`发送回复失败: ${err}`);
  }
}

export async function runBridge(creds: WeixinCredentials, abortSignal?: AbortSignal): Promise<void> {
  console.log(`\n========================================`);
  console.log(`  WeChat Claude Bridge 就绪`);
  console.log(`========================================`);
  console.log(`账号: ${creds.accountId}`);
  console.log(`服务端: ${creds.baseUrl}`);
  console.log(`模型: ${CLAUDE_MODEL}`);
  console.log(`语音识别: ${ASR_ENABLED ? '启用' : '禁用'}`);
  console.log(`联网搜索: 启用`);
  console.log(``);
  console.log(`开始监听消息...`);
  console.log(`========================================\n`);

  try {
    await notifyStart({ baseUrl: creds.baseUrl, token: creds.botToken });
  } catch (err) {
    console.warn(`notifyStart 失败 (忽略): ${err}`);
  }

  // 启动后立即向最近活跃用户发送就绪消息
  const lastUserId = [...contextTokens.keys()].pop();
  if (lastUserId) {
    const now = new Date();
    const dateStr = now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" });
    const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

    const welcomeText = [
      `WeChat Claude Bridge 已就绪`,
      ``,
      `时间: ${dateStr} ${timeStr}`,
      `模型: ${CLAUDE_MODEL}`,
      `语音: ${ASR_ENABLED ? 'ON' : 'OFF'} | 搜索: ON`,
      ``,
      `命令`,
      `/clear  重置对话(说"清除聊天记录")`,
      `/status  系统状态`,
      `/voice  语音回复模式`,
      `/help  帮助`,
      `/bindings  表情绑定`,
      ``,
      `表情快捷`,
      `[强] 状态  [胜利] 重置  [再见] 帮助`,
      ``,
      `开始对话吧`,
    ].join("\n");

    try {
      await sendMessage({
        baseUrl: creds.baseUrl,
        token: creds.botToken,
        to: lastUserId,
        text: welcomeText,
        contextToken: getContextToken(lastUserId),
      });
      console.log(`已发送就绪消息给 ${lastUserId}`);
    } catch (err) {
      console.warn(`发送就绪消息失败: ${err}`);
    }
  } else {
    console.log(`暂无用户 context token，就绪消息将在用户首次发消息后发送`);
  }

  let getUpdatesBuf = "";
  let nextTimeout = LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl: creds.baseUrl,
        token: creds.botToken,
        getUpdatesBuf,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeout = resp.longpolling_timeout_ms;
      }

      // Handle API errors (ret/errcode may be undefined on success)
      const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        // -14 = session expired
        if (resp.errcode === -14 || resp.ret === -14) {
          console.error("会话已过期，请重新登录。");
          console.error("删除 .weixin-credentials.json 后重新运行。");
          return;
        }
        consecutiveFailures++;
        console.error(`getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
        if (consecutiveFailures >= 3) {
          console.error("连续失败 3 次，等待 30 秒...");
          await sleep(30_000, abortSignal);
          consecutiveFailures = 0;
        } else {
          await sleep(2_000, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save sync buf
      if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf;

      // Process messages sequentially with dedup
      for (const msg of resp.msgs ?? []) {
        // Dedup by message key (message_id or composite fallback)
        const msgKey = makeMsgKey(msg);
        if (!markProcessed(msgKey)) {
          continue;
        }

        const from = msg.from_user_id ?? "?";
        const text = extractText(msg.item_list);
        const hasImage = !!findImageItem(msg.item_list);
        const hasVoice = !!findVoiceItem(msg.item_list);

        console.log(`\n========================================`);
        console.log(`[收到消息] ${new Date().toLocaleTimeString()}`);
        console.log(`[发送者] ${from}`);
        if (text) console.log(`[内容] ${text}`);
        if (hasImage) console.log(`[附件] 图片`);
        if (hasVoice) console.log(`[附件] 语音`);
        console.log(`========================================`);

        // Sequential: wait for each message to finish before processing next
        try {
          await processMessage(msg, creds);
        } catch (err) {
          console.error(`processMessage error: ${err}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) return;
      consecutiveFailures++;
      console.error(`getUpdates 异常: ${err}`);
      if (consecutiveFailures >= 3) {
        console.error("连续失败 3 次，等待 30 秒...");
        await sleep(30_000, abortSignal);
        consecutiveFailures = 0;
      } else {
        await sleep(2_000, abortSignal);
      }
    }
  }

  // Cleanup
  try {
    await notifyStop({ baseUrl: creds.baseUrl, token: creds.botToken });
  } catch {}
  console.log("桥接服务已停止。");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}
