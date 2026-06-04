import crypto from "node:crypto";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ANTHROPIC_API_KEY } from "./config.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "1.0.0";
const SEND_TIMEOUT_MS = 15_000;
const CDN_MAX_RETRIES = 3;
const BYTES_PER_MB = 1024 * 1024;

const DEFAULT_MEDIA_UPLOAD_LIMIT_MB = {
  image: 20,
  file: 50,
  voice: 20,
  video: 100,
};

const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_VIDEO = 5;

const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;
const UPLOAD_MEDIA_TYPE_VOICE = 4;

export type UploadLabel = "image" | "file" | "voice" | "video";

export type UploadPreparation = {
  rawsize: number;
  filesize: number;
  aeskey: Buffer;
  downloadParam: string;
};

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes >= BYTES_PER_MB) {
    const value = bytes / BYTES_PER_MB;
    return `${value.toFixed(value >= 100 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    const value = bytes / 1024;
    return `${value.toFixed(value >= 100 ? 0 : 1)} KB`;
  }
  return `${bytes} B`;
}

function resolveMediaUploadLimitBytes(label: UploadLabel): number {
  const limitMb = DEFAULT_MEDIA_UPLOAD_LIMIT_MB[label];
  return Math.floor(limitMb * BYTES_PER_MB);
}

export function assertMediaUploadSizeAllowed(label: UploadLabel, rawsize: number): void {
  const limitBytes = resolveMediaUploadLimitBytes(label);
  if (rawsize <= limitBytes) {
    return;
  }

  const labelName = label.charAt(0).toUpperCase() + label.slice(1);
  throw new Error(
    `${labelName} too large: ${formatByteSize(rawsize)} exceeds ${formatByteSize(limitBytes)} limit.`,
  );
}

function encodeMessageAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString("hex")).toString("base64");
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: params.token ? `Bearer ${params.token}` : "",
      },
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  },
): Promise<{ upload_param?: string }> {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      no_need_thumb: true,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: SEND_TIMEOUT_MS,
  });
  return JSON.parse(raw) as { upload_param?: string };
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const cdnUrl = buildCdnUploadUrl(params.uploadParam, params.filekey);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) {
        throw err;
      }
      if (attempt >= CDN_MAX_RETRIES) {
        break;
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error("CDN upload failed");
  }

  return { downloadParam };
}

export async function prepareUpload(
  baseUrl: string,
  token: string,
  recipientId: string,
  filePath: string,
  mediaType: number,
  label: UploadLabel,
): Promise<UploadPreparation> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  assertMediaUploadSizeAllowed(label, stat.size);

  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  console.log(`Uploading ${label}: ${filePath} (${rawsize} bytes)`);

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: mediaType,
    to_user_id: recipientId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });

  if (!uploadResp.upload_param) {
    throw new Error("getUploadUrl returned no upload_param");
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam: uploadResp.upload_param,
    filekey,
    aeskey,
  });

  return {
    rawsize,
    filesize,
    aeskey,
    downloadParam,
  };
}

export async function sendImageMessage(
  baseUrl: string,
  token: string,
  recipientId: string,
  contextToken: string,
  imagePath: string,
  caption?: string,
): Promise<void> {
  if (caption) {
    await sendMessage(baseUrl, token, recipientId, contextToken, [
      { type: MSG_ITEM_TEXT, text_item: { text: caption } },
    ]);
  }

  const upload = await prepareUpload(
    baseUrl,
    token,
    recipientId,
    imagePath,
    UPLOAD_MEDIA_TYPE_IMAGE,
    "image",
  );

  await sendMessage(baseUrl, token, recipientId, contextToken, [
    {
      type: MSG_ITEM_IMAGE,
      image_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: encodeMessageAesKey(upload.aeskey),
          encrypt_type: 1,
        },
        mid_size: upload.filesize,
      },
    },
  ]);
}

export async function sendFileMessage(
  baseUrl: string,
  token: string,
  recipientId: string,
  contextToken: string,
  filePath: string,
  title?: string,
): Promise<void> {
  const upload = await prepareUpload(
    baseUrl,
    token,
    recipientId,
    filePath,
    UPLOAD_MEDIA_TYPE_FILE,
    "file",
  );
  const fileName = title?.trim() || path.basename(filePath);

  await sendMessage(baseUrl, token, recipientId, contextToken, [
    {
      type: MSG_ITEM_FILE,
      file_item: {
        file_name: fileName,
        len: String(upload.rawsize),
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: encodeMessageAesKey(upload.aeskey),
          encrypt_type: 1,
        },
      },
    },
  ]);
}

export async function sendVoiceMessage(
  baseUrl: string,
  token: string,
  recipientId: string,
  contextToken: string,
  voicePath: string,
): Promise<void> {
  const upload = await prepareUpload(
    baseUrl,
    token,
    recipientId,
    voicePath,
    UPLOAD_MEDIA_TYPE_VOICE,
    "voice",
  );

  console.log(`[上传] 语音上传完成, downloadParam长度=${upload.downloadParam.length}`);

  // 与 CLI-WeChat-Bridge 保持一致的 voice_item 结构
  await sendMessage(baseUrl, token, recipientId, contextToken, [
    {
      type: MSG_ITEM_VOICE,
      voice_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: encodeMessageAesKey(upload.aeskey),
          encrypt_type: 1,
        },
      },
    },
  ]);

  console.log(`[上传] sendMessage 调用完成`);
}

export async function sendVideoMessage(
  baseUrl: string,
  token: string,
  recipientId: string,
  contextToken: string,
  videoPath: string,
  title?: string,
): Promise<void> {
  if (title) {
    await sendMessage(baseUrl, token, recipientId, contextToken, [
      { type: MSG_ITEM_TEXT, text_item: { text: title } },
    ]);
  }

  const upload = await prepareUpload(
    baseUrl,
    token,
    recipientId,
    videoPath,
    UPLOAD_MEDIA_TYPE_VIDEO,
    "video",
  );

  await sendMessage(baseUrl, token, recipientId, contextToken, [
    {
      type: MSG_ITEM_VIDEO,
      video_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: encodeMessageAesKey(upload.aeskey),
          encrypt_type: 1,
        },
        video_size: upload.filesize,
      },
    },
  ]);
}

async function sendMessage(
  baseUrl: string,
  token: string,
  recipientId: string,
  contextToken: string,
  itemList: unknown[],
): Promise<void> {
  const clientId = `wcb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: recipientId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: itemList,
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: SEND_TIMEOUT_MS,
  });

  const response = JSON.parse(raw);
  console.log(`[上传] sendmessage 响应: ret=${response.ret} errmsg=${response.errmsg || "none"}`);
  if (response.ret !== undefined && response.ret !== 0) {
    throw new Error(`sendmessage failed: ret=${response.ret} errmsg=${response.errmsg}`);
  }
}
