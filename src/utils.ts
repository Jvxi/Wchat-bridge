/**
 * 共享工具函数
 */

// ─── 字节格式化 ───

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── 时间格式化 ───

export function formatChineseDateTime(): { dateStr: string; timeStr: string } {
  const now = new Date();
  return {
    dateStr: now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }),
    timeStr: now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分钟`);
  return parts.join("") || "< 1分钟";
}

// ─── 通用 JSON 持久化 ───

import fs from "node:fs";
import path from "node:path";

/**
 * 从 JSON 文件加载数据
 */
export function loadJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data as T;
  } catch {
    return defaultValue;
  }
}

/**
 * 保存数据到 JSON 文件
 */
export function saveJsonFile(filePath: string, data: unknown): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn(`保存文件失败 ${filePath}: ${err}`);
  }
}

/**
 * 防抖保存工厂函数
 */
export function createDebouncedSave(saveFn: () => void, interval: number = 5): () => void {
  let counter = 0;
  return () => {
    counter++;
    if (counter >= interval) {
      saveFn();
      counter = 0;
    }
  };
}
