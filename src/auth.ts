import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiPostFetch, apiGetFetch } from "./iLink.js";
import { ILINK_BASE_URL } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = path.join(__dirname, "..", ".weixin-credentials.json");

const QR_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH = 3;

interface QrResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WeixinCredentials {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
}

export function loadCredentials(): WeixinCredentials | null {
  try {
    if (!fs.existsSync(CREDS_PATH)) return null;
    return JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8")) as WeixinCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(creds: WeixinCredentials): void {
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), "utf-8");
  try { fs.chmodSync(CREDS_PATH, 0o600); } catch {}
}

function getLocalBotTokenList(): string[] {
  const creds = loadCredentials();
  return creds?.botToken ? [creds.botToken] : [];
}

async function fetchQRCode(baseUrl: string): Promise<QrResponse> {
  const raw = await apiPostFetch({
    baseUrl,
    endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
    body: JSON.stringify({ local_token_list: getLocalBotTokenList() }),
    timeoutMs: 15_000,
  });
  return JSON.parse(raw) as QrResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<StatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const raw = await apiGetFetch({ baseUrl, endpoint, timeoutMs: QR_POLL_TIMEOUT_MS });
    return JSON.parse(raw) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    console.warn(`pollQRStatus error, retrying: ${err}`);
    return { status: "wait" };
  }
}

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

export async function login(forceRelogin = false): Promise<WeixinCredentials> {
  // Check existing
  const existing = loadCredentials();
  if (existing?.botToken && !forceRelogin) {
    console.log("已有登录凭据，跳过扫码。如需重新登录，请删除 .weixin-credentials.json");
    return existing;
  }

  // If force relogin, delete old credentials
  if (forceRelogin && existing) {
    console.log("清除旧凭据，准备重新登录...");
    try {
      fs.unlinkSync(CREDS_PATH);
    } catch {}
  }

  console.log("正在获取登录二维码...");
  const qr = await fetchQRCode(ILINK_BASE_URL);
  console.log(`二维码链接: ${qr.qrcode_img_content}`);

  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qr.qrcode_img_content, { small: true });
  } catch {
    // fallback: just show URL
  }
  console.log("\n请用微信扫描上方二维码\n");

  let currentBaseUrl = ILINK_BASE_URL;
  let qrCode = qr.qrcode;
  let qrRefreshCount = 1;
  let pendingVerifyCode: string | undefined;
  const deadline = Date.now() + 480_000; // 8 min

  while (Date.now() < deadline) {
    const status = await pollQRStatus(currentBaseUrl, qrCode, pendingVerifyCode);

    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;

      case "scaned":
        if (pendingVerifyCode) pendingVerifyCode = undefined;
        console.log("\n已扫码，等待确认...");
        break;

      case "need_verifycode": {
        const prompt = pendingVerifyCode
          ? "❌ 数字不匹配，请重新输入："
          : "输入手机微信显示的数字：";
        pendingVerifyCode = await readLine(prompt);
        continue;
      }

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH) {
          throw new Error("二维码多次过期，请重新运行。");
        }
        console.log(`\n二维码已过期，正在刷新 (${qrRefreshCount}/${MAX_QR_REFRESH})...`);
        const newQr = await fetchQRCode(currentBaseUrl);
        qrCode = newQr.qrcode;
        try {
          const qrterm = await import("qrcode-terminal");
          qrterm.default.generate(newQr.qrcode_img_content, { small: true });
        } catch {}
        console.log("请重新扫描\n");
        break;
      }

      case "verify_code_blocked":
        throw new Error("验证码多次错误，请稍后再试。");

      case "binded_redirect":
        console.log("\n已连接过，无需重复连接。");
        return loadCredentials()!;

      case "scaned_but_redirect":
        if (status.redirect_host) {
          currentBaseUrl = `https://${status.redirect_host}`;
          console.log(`IDC 重定向: ${currentBaseUrl}`);
        }
        break;

      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("登录确认但未返回凭据。");
        }
        const creds: WeixinCredentials = {
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl || currentBaseUrl,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(creds);
        console.log(`\n登录成功! 账号: ${creds.accountId}`);
        return creds;
      }

      default:
        console.log(`\n未知状态: ${status.status}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error("登录超时，请重试。");
}

// Run standalone if called directly
if (process.argv[1]?.endsWith("auth.ts") || process.argv[1]?.endsWith("auth.js")) {
  const forceRelogin = process.argv.includes("--force") || process.argv.includes("-f");
  login(forceRelogin).then(() => process.exit(0)).catch(err => {
    console.error(`登录失败: ${err.message}`);
    process.exit(1);
  });
}
