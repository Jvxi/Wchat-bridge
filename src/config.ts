import "dotenv/config";

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
export const MAX_HISTORY_LENGTH = parseInt(process.env.MAX_HISTORY_LENGTH ?? "0", 10);

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const ILINK_APP_ID = "bot";

export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;

// 语音识别配置（使用 mimo-v2-omni 的语音理解能力）
export const ASR_ENABLED = process.env.ASR_ENABLED !== "false"; // 默认启用

// 联网搜索配置
export const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== "false"; // 默认启用
