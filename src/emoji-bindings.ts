import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const EMOJI_BINDINGS_FILE = path.join(DATA_DIR, "emoji-bindings.json");

export const DEFAULT_EMOJI_BINDINGS: Record<string, string> = {
  "[OK]": "/confirm",
  "[闭嘴]": "/stop",
  "[强]": "/status",
  "[胜利]": "/clear",
  "[再见]": "/help",
};

export type EmojiBindingsConfig = {
  bindings: Record<string, string>;
};

let bindingsMap: Map<string, string> | null = null;

function buildMap(bindings: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [emoji, command] of Object.entries(bindings)) {
    map.set(emoji.toLowerCase(), command);
  }
  return map;
}

export function loadEmojiBindings(): Map<string, string> {
  if (bindingsMap) {
    return bindingsMap;
  }
  try {
    if (fs.existsSync(EMOJI_BINDINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(EMOJI_BINDINGS_FILE, "utf-8")) as EmojiBindingsConfig;
      if (raw.bindings && typeof raw.bindings === "object") {
        bindingsMap = buildMap(raw.bindings);
        return bindingsMap;
      }
    }
  } catch {
    // Fall through to defaults on parse error.
  }
  bindingsMap = buildMap(DEFAULT_EMOJI_BINDINGS);
  return bindingsMap;
}

export function saveEmojiBindings(map: Map<string, string>): void {
  const bindings: Record<string, string> = {};
  for (const [emoji, command] of map) {
    bindings[emoji] = command;
  }
  const data: EmojiBindingsConfig = { bindings };
  fs.writeFileSync(EMOJI_BINDINGS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function setBinding(emoji: string, command: string): void {
  const map = loadEmojiBindings();
  map.set(emoji.toLowerCase(), command);
  bindingsMap = map;
  saveEmojiBindings(map);
}

export function removeBinding(emoji: string): boolean {
  const map = loadEmojiBindings();
  const key = emoji.toLowerCase();
  if (!map.has(key)) {
    return false;
  }
  map.delete(key);
  bindingsMap = map;
  saveEmojiBindings(map);
  return true;
}

export function listBindings(): Map<string, string> {
  return loadEmojiBindings();
}

export type EmojiCommandMatch = {
  command: string;
  remainder: string;
};

export function resolveEmojiCommand(text: string): EmojiCommandMatch | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }
  const map = loadEmojiBindings();
  const lower = trimmed.toLowerCase();
  for (const [emoji, command] of map) {
    if (lower.startsWith(emoji)) {
      const remainder = trimmed.slice(emoji.length).trim();
      return { command, remainder };
    }
  }
  return null;
}

export type EmojiBindingsCommand =
  | { type: "bind"; emoji: string; command: string }
  | { type: "unbind"; emoji: string }
  | { type: "list" };

export function parseEmojiBindingsCommand(text: string): EmojiBindingsCommand | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "/bindings") {
    return { type: "list" };
  }
  const bindMatch = trimmed.match(/^\/bind\s+(\[[^\]]+\])\s+(.+)$/i);
  if (bindMatch) {
    return { type: "bind", emoji: bindMatch[1]!, command: bindMatch[2]!.trim() };
  }
  const unbindMatch = trimmed.match(/^\/unbind\s+(\[[^\]]+\])$/i);
  if (unbindMatch) {
    return { type: "unbind", emoji: unbindMatch[1]! };
  }
  return null;
}

export function formatBindingsListMessage(map: Map<string, string>): string {
  if (map.size === 0) {
    return "No emoji bindings configured.";
  }
  const lines = Array.from(map.entries()).map(
    ([emoji, command]) => `${emoji} → ${command}`,
  );
  return `Emoji bindings:\n${lines.join("\n")}`;
}
