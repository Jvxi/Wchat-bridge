import crypto from "node:crypto";
import { ILINK_APP_ID, LONG_POLL_TIMEOUT_MS, API_TIMEOUT_MS } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: { message_item?: MessageItem; title?: string };
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  text?: string;
  sample_rate?: number;
  playtime?: number;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

// Message item types
export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageItemType = {
  TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5,
} as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": "131328", // 2.0.0 -> (2<<16)|(0<<8)|0 = 131072, using 2.0.2 -> 131328
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function buildBaseInfo(): BaseInfo {
  return {
    channel_version: "2.4.4",
    bot_agent: "WeixinClaudeBridge/1.0.0",
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
}): Promise<string> {
  const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : params.baseUrl + "/");
  const controller = new AbortController();
  const timeout = params.timeoutMs ?? API_TIMEOUT_MS;
  const t = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(params.token),
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${params.endpoint} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
}): Promise<string> {
  const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : params.baseUrl + "/");
  const controller = new AbortController();
  const timeout = params.timeoutMs ?? API_TIMEOUT_MS;
  const t = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": "131328",
      },
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${params.endpoint} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

/** Long-poll for new messages. Returns empty on timeout (normal). */
export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  getUpdatesBuf?: string;
  abortSignal?: AbortSignal;
}): Promise<GetUpdatesResp> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);

  // Wire external abort
  if (params.abortSignal) {
    if (params.abortSignal.aborted) controller.abort();
    else params.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const url = new URL("ilink/bot/getupdates", params.baseUrl.endsWith("/") ? params.baseUrl : params.baseUrl + "/");
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(params.token),
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf ?? "",
        base_info: buildBaseInfo(),
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`getUpdates ${res.status}: ${text}`);
    return JSON.parse(text) as GetUpdatesResp;
  } catch (err) {
    clearTimeout(t);
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  to: string;
  text: string;
  contextToken?: string;
  clientId?: string;
}): Promise<void> {
  const clientId = params.clientId ?? `wcb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: params.text ? [{ type: 1, text_item: { text: params.text } }] : [],
        context_token: params.contextToken ?? undefined,
      },
      base_info: buildBaseInfo(),
    }),
    token: params.token,
  });
}

export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  const raw = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
  });
  return JSON.parse(raw) as GetConfigResp;
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  typingTicket: string;
  status: number;
}): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
  });
}

export async function notifyStart(params: { baseUrl: string; token?: string }): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
  });
}

export async function notifyStop(params: { baseUrl: string; token?: string }): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
  });
}

/** Extract text body from item_list. */
export function extractText(items?: MessageItem[]): string {
  if (!items?.length) return "";
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Find the first image item in item_list. */
export function findImageItem(items?: MessageItem[]): ImageItem | undefined {
  if (!items?.length) return undefined;
  for (const item of items) {
    if (item.type === MessageItemType.IMAGE && item.image_item) {
      return item.image_item;
    }
    // Check ref_msg for quoted images
    if (item.type === MessageItemType.TEXT && item.ref_msg?.message_item?.image_item) {
      return item.ref_msg.message_item.image_item;
    }
  }
  return undefined;
}

/** Find the first voice item in item_list. */
export function findVoiceItem(items?: MessageItem[]): VoiceItem | undefined {
  if (!items?.length) return undefined;
  for (const item of items) {
    if (item.type === MessageItemType.VOICE && item.voice_item) {
      return item.voice_item;
    }
  }
  return undefined;
}

/** Find the first video item in item_list. */
export function findVideoItem(items?: MessageItem[]): VideoItem | undefined {
  if (!items?.length) return undefined;
  for (const item of items) {
    if (item.type === MessageItemType.VIDEO && item.video_item) {
      return item.video_item;
    }
  }
  return undefined;
}
