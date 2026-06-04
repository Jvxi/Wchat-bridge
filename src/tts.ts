import { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL } from "./config.js";

const TTS_MODEL = "mimo-v2.5-tts";
const TTS_VOICE = "mimo_default";

/**
 * 将文本合成为语音（WAV格式）
 * 返回 base64 编码的 WAV 数据，或 null 失败
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const apiKey = ANTHROPIC_API_KEY;
  const baseUrl = ANTHROPIC_BASE_URL || "https://api.mimo-v2.com/v1";
  const apiUrl = `${baseUrl}/chat/completions`;

  if (!apiKey) {
    console.warn(`[TTS] 未配置 API 密钥`);
    return null;
  }

  if (!text || text.trim().length === 0) return null;

  // 截断过长文本
  const maxLen = 2000;
  const synthText = text.length > maxLen ? text.substring(0, maxLen) + "..." : text;

  try {
    console.log(`[TTS] 正在合成语音... (${synthText.length} 字)`);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        messages: [
          {
            role: "assistant",
            content: synthText,
          },
        ],
        audio: {
          format: "wav",
          voice: TTS_VOICE,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.warn(`[TTS] API 错误: ${response.status} ${errBody.substring(0, 200)}`);
      return null;
    }

    const result = await response.json() as any;
    const audioData = result?.choices?.[0]?.message?.audio?.data;

    if (!audioData) {
      console.warn(`[TTS] 响应中没有音频数据`);
      return null;
    }

    const audioBuf = Buffer.from(audioData, "base64");
    console.log(`[TTS] 语音合成成功: ${audioBuf.length} bytes`);
    return audioBuf;
  } catch (err) {
    console.error(`[TTS] 合成失败: ${err}`);
    return null;
  }
}
