/**
 * 文件日志模块
 * 将 console 输出同步写入文件
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const LOG_DIR = DATA_DIR;
const LOG_FILE = path.join(LOG_DIR, "bridge.log");

// 确保日志目录存在（只在启动时检查一次）
let logDirEnsured = false;

function ensureLogDir(): void {
  if (logDirEnsured) return;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  logDirEnsured = true;
}

function getTimestamp(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

// 使用 WriteStream 提高性能
let logStream: fs.WriteStream | null = null;

function getLogStream(): fs.WriteStream {
  if (!logStream) {
    ensureLogDir();
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf-8" });
  }
  return logStream;
}

function writeLog(level: string, args: unknown[]): void {
  try {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    const line = `[${getTimestamp()}] [${level}] ${msg}\n`;
    getLogStream().write(line);
  } catch {
    // 日志写入失败不应影响主流程
  }
}

// 保存原始 console 方法
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

// 拦截 console 输出到文件
console.log = (...args: unknown[]) => {
  writeLog("INFO", args);
  origLog.apply(console, args);
};

console.warn = (...args: unknown[]) => {
  writeLog("WARN", args);
  origWarn.apply(console, args);
};

console.error = (...args: unknown[]) => {
  writeLog("ERROR", args);
  origError.apply(console, args);
};

/**
 * 初始化日志系统（清空旧日志）
 */
export function initLogger(): void {
  ensureLogDir();
  // 关闭旧的 stream（如果有）
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  fs.writeFileSync(LOG_FILE, `=== WeChat Claude Bridge Log ===\n启动时间: ${getTimestamp()}\n\n`, "utf-8");
  // 重新创建 stream
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf-8" });
}

/**
 * 关闭日志流
 */
export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
