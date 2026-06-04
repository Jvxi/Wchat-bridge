import crypto from "node:crypto";
import { CDN_BASE_URL, ASR_ENABLED, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL } from "./config.js";
import type { ImageItem, VoiceItem, VideoItem, CDNMedia } from "./iLink.js";

/**
 * Download and decrypt an image from WeChat CDN.
 * Returns base64-encoded decrypted bytes, or null on failure.
 */
export async function downloadAndDecryptImage(image: ImageItem): Promise<{
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
} | null> {
  const media = image.media;
  if (!media) return null;

  // 提取AES密钥
  const aesKey = media.aes_key ?? image.aeskey;

  /** 尝试下载并解密数据 */
  async function tryDownload(url: string, label: string): Promise<Buffer | null> {
    try {
      console.log(`[媒体] ${label}: ${url.substring(0, 80)}...`);
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        console.warn(`[媒体] ${label} 响应: ${resp.status}`);
        return null;
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      console.warn(`[媒体] ${label} 失败: ${err}`);
      return null;
    }
  }

  /** 尝试将数据作为图片验证，如果不是图片且有密钥则尝试解密 */
  function tryValidateOrDecrypt(buf: Buffer, label: string): { base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null {
    // 先尝试直接验证
    const direct = validateImageData(buf);
    if (direct) return direct;

    // 不是图片，尝试解密
    if (aesKey) {
      try {
        console.log(`[媒体] ${label} 数据不是图片，尝试解密...`);
        const decrypted = decryptAes128Ecb(buf, aesKey);
        console.log(`[媒体] 解密后: ${decrypted.length} bytes`);
        return validateImageData(decrypted);
      } catch (err) {
        console.warn(`[媒体] 解密失败: ${err}`);
      }
    }

    return null;
  }

  // 1. Try direct URL
  if (image.url) {
    const buf = await tryDownload(image.url, "直接URL");
    if (buf) {
      const result = tryValidateOrDecrypt(buf, "直接URL");
      if (result) return result;
    }
  }

  // 2. Try full_url
  if (media.full_url) {
    const buf = await tryDownload(media.full_url, "full_url");
    if (buf) {
      const result = tryValidateOrDecrypt(buf, "full_url");
      if (result) return result;
    }
  }

  // 3. Try CDN with encrypt_query_param
  if (media.encrypt_query_param) {
    const cdnUrl = `${CDN_BASE_URL}?${media.encrypt_query_param}`;
    const buf = await tryDownload(cdnUrl, "CDN");
    if (buf) {
      const result = tryValidateOrDecrypt(buf, "CDN");
      if (result) return result;
    }
  }

  console.warn(`[媒体] 所有下载方式均失败`);
  return null;
}

/** AES-128-ECB decrypt. aesKey is base64-encoded. */
/** 检查是否是32位hex密钥 */
function isHexAesKey(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value);
}

/** 解码AES密钥，支持多种格式 */
function decodeAesKey(value: string): Buffer {
  const trimmed = value.trim();

  // 32位hex字符串
  if (isHexAesKey(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // base64编码的密钥
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 16) {
    return decoded;
  }

  // base64编码的hex字符串
  const decodedText = decoded.toString("utf8").trim();
  if (isHexAesKey(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }

  throw new Error(`Unsupported AES key format: ${trimmed.substring(0, 20)}...`);
}

function decryptAes128Ecb(encrypted: Buffer, aesKey: string): Buffer {
  const key = decodeAesKey(aesKey);
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** Guess MIME type from magic bytes. Returns null if not a recognized image. */
function guessMediaType(buf: Buffer): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return null;
}

/** Validate and return image data, or null if invalid. */
function validateImageData(buf: Buffer): { base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null {
  if (buf.length < 100) {
    console.warn(`[媒体] 数据太小: ${buf.length} bytes`);
    return null;
  }
  const mediaType = guessMediaType(buf);
  if (!mediaType) {
    const hex = buf.subarray(0, 16).toString("hex");
    console.warn(`[媒体] 未知图片格式, 前16字节: ${hex}`);
    return null;
  }
  console.log(`[媒体] 图片验证通过: ${mediaType}, ${buf.length} bytes`);
  return { base64: buf.toString("base64"), mediaType };
}

/**
 * Download voice from WeChat CDN.
 * Returns { base64, format } or null on failure.
 */
export async function downloadVoice(voice: VoiceItem): Promise<{ base64: string; format: string } | null> {
  const media = voice.media;
  if (!media) return null;

  const aesKey = media.aes_key;
  let buf: Buffer | null = null;

  /** 尝试下载并解密 */
  async function tryFetch(url: string): Promise<Buffer | null> {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** 尝试验证或解密音频数据 */
  function tryValidateOrDecrypt(data: Buffer): Buffer | null {
    // 先检查是否是有效音频
    const format = detectAudioFormat(data);
    if (format !== "unknown") return data;

    // 不是已知格式，尝试解密
    if (aesKey) {
      try {
        console.log(`[媒体] 语音数据不是已知格式，尝试解密...`);
        const decrypted = decryptAes128Ecb(data, aesKey);
        const decFormat = detectAudioFormat(decrypted);
        console.log(`[媒体] 解密后格式: ${decFormat}, ${decrypted.length} bytes`);
        return decrypted;
      } catch (err) {
        console.warn(`[媒体] 解密失败: ${err}`);
      }
    }

    return data; // 返回原始数据
  }

  // 1. Try full_url
  if (media.full_url) {
    const raw = await tryFetch(media.full_url);
    if (raw) {
      buf = tryValidateOrDecrypt(raw);
    }
  }

  // 2. Try CDN with encrypt_query_param
  if (!buf && media.encrypt_query_param) {
    const cdnUrl = `${CDN_BASE_URL}?${media.encrypt_query_param}`;
    const raw = await tryFetch(cdnUrl);
    if (raw) {
      buf = tryValidateOrDecrypt(raw);
    }
  }

  if (!buf || buf.length < 50) return null;

  // 检测音频格式
  let format = detectAudioFormat(buf);
  const hex = buf.subarray(0, 16).toString("hex");
  console.log(`[媒体] 语音格式: ${format}, ${buf.length} bytes, 前16字节: ${hex}`);

  // 微信语音可能有额外的前缀字节，检查偏移1字节是否是 SILK
  if (format === "unknown" && buf.length > 10) {
    const shifted = buf.subarray(1);
    const shiftedFormat = detectAudioFormat(shifted);
    if (shiftedFormat === "silk") {
      console.log(`[媒体] 检测到微信 SILK 前缀，跳过1字节`);
      buf = shifted;
      format = shiftedFormat;
    }
  }

  // 再尝试跳过2字节
  if (format === "unknown" && buf.length > 11) {
    const shifted = buf.subarray(2);
    const shiftedFormat = detectAudioFormat(shifted);
    if (shiftedFormat === "silk") {
      console.log(`[媒体] 检测到微信 SILK 前缀，跳过2字节`);
      buf = shifted;
      format = shiftedFormat;
    }
  }

  // 如果是 SILK 格式，尝试用 ffmpeg 转换
  if (format === "silk") {
    const converted = await convertSilkToWav(buf);
    if (converted) {
      return { base64: converted.toString("base64"), format: "wav" };
    }
    // ffmpeg 不可用，返回原始数据，让 API 尝试处理
    console.warn(`[媒体] SILK 转换失败，尝试直接发送`);
  }

  return { base64: buf.toString("base64"), format };
}

/** 检测音频格式 */
function detectAudioFormat(buf: Buffer): string {
  if (buf.length < 4) return "unknown";

  // SILK v3: "#!SILK_V3"
  if (buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x53 && buf[3] === 0x49) return "silk";
  // SILK v2: "#!SILK_V2"
  if (buf.subarray(0, 9).toString() === "#!SILK_V2") return "silk";

  // MP3: ID3 tag or sync word
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";

  // WAV: "RIFF....WAVE"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "wav";

  // FLAC: "fLaC"
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return "flac";

  // OGG: "OggS"
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return "ogg";

  // AMR: "#!AMR"
  if (buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 && buf[3] === 0x4d) return "amr";

  // M4A: ftyp
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "m4a";

  return "unknown";
}

/** 将 SILK 转换为 PCM，再封装为 WAV */
async function convertSilkToWav(silkBuf: Buffer): Promise<Buffer | null> {
  try {
    const { decode, isSilk } = await import("silk-wasm");

    // 检查是否是有效的 SILK 数据
    console.log(`[媒体] isSilk(原始): ${isSilk(silkBuf)}`);
    console.log(`[媒体] isSilk(跳过1字节): ${isSilk(silkBuf.subarray(1))}`);

    // 尝试解码 - 先尝试原始数据，再尝试跳过前缀
    const attempts = [
      { data: silkBuf, label: "原始" },
      { data: silkBuf.subarray(1), label: "跳过1字节" },
    ];

    for (const attempt of attempts) {
      for (const rate of [24000, 16000]) {
        try {
          console.log(`[媒体] 尝试解码 (${attempt.label}, 采样率: ${rate})...`);
          const result = await decode(attempt.data, rate);
          const pcmData = Buffer.from(result.data);
          console.log(`[媒体] SILK 解码成功: PCM ${pcmData.length} bytes, 时长 ${result.duration}ms`);
          const wavBuf = pcmToWav(pcmData, rate, 1, 16);
          console.log(`[媒体] WAV 封装完成: ${wavBuf.length} bytes`);
          return wavBuf;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[媒体] ${attempt.label} 采样率${rate} 失败: ${errMsg}`);
        }
      }
    }

    console.warn(`[媒体] 所有 SILK 解码尝试均失败`);
    return null;
  } catch (err) {
    console.warn(`[媒体] silk-wasm 加载失败: ${err}`);
    return null;
  }
}

/** 将 PCM 数据封装为 WAV 格式 */
function pcmToWav(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);

  // fmt chunk
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);        // chunk size
  wav.writeUInt16LE(1, 20);         // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmData.copy(wav, 44);

  return wav;
}

/**
 * Download video from WeChat CDN.
 * Returns base64-encoded video bytes, or null on failure.
 */
export async function downloadVideo(video: VideoItem): Promise<string | null> {
  const media = video.media;
  if (!media) return null;

  // Try full_url first
  if (media.full_url) {
    try {
      console.log(`[媒体] 尝试 full_url 下载视频`);
      const resp = await fetch(media.full_url, { signal: AbortSignal.timeout(30000) });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 100) {
          console.log(`[媒体] 视频下载成功: ${buf.length} bytes`);
          return buf.toString("base64");
        }
      }
    } catch {}
  }

  // CDN with encryption
  if (media.encrypt_query_param && media.aes_key) {
    try {
      console.log(`[媒体] 尝试 CDN 解密视频`);
      const cdnUrl = `${CDN_BASE_URL}?${media.encrypt_query_param}`;
      const resp = await fetch(cdnUrl, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) return null;
      const encrypted = Buffer.from(await resp.arrayBuffer());
      const decrypted = decryptAes128Ecb(encrypted, media.aes_key);
      if (decrypted.length > 100) {
        console.log(`[媒体] 视频解密成功: ${decrypted.length} bytes`);
        return decrypted.toString("base64");
      }
    } catch (err) {
      console.warn(`[媒体] 视频解密失败: ${err}`);
    }
  }

  return null;
}

/**
 * Recognize speech from audio using MiMo-V2-Omni's audio understanding.
 * Uses the same API as the chat function.
 * Returns transcribed text, or null on failure.
 */
export async function recognizeSpeech(audioBase64: string, audioFormat: string = "mp3"): Promise<string | null> {
  if (!ASR_ENABLED) return null;

  const apiKey = ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.mimo-v2.com/v1";
  const apiUrl = `${baseUrl}/chat/completions`;

  if (!apiKey) {
    console.warn(`[ASR] 未配置 API 密钥`);
    return null;
  }

  try {
    console.log(`[ASR] 正在识别语音... (mimo-v2-omni)`);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "mimo-v2-omni",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "请将这段语音的内容转录为文字，只输出转录结果，不要添加任何解释。" },
              {
                type: "input_audio",
                input_audio: {
                  data: audioBase64,
                  format: audioFormat,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.warn(`[ASR] API 错误: ${response.status} ${errBody.substring(0, 200)}`);
      return null;
    }

    const result = await response.json();
    const text = result?.choices?.[0]?.message?.content;
    return text || null;
  } catch (err) {
    console.warn(`ASR error: ${err}`);
    return null;
  }
}
