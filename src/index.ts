import { ANTHROPIC_API_KEY } from "./config.js";
import { saveConversations } from "./claude.js";
import { login, loadCredentials } from "./auth.js";
import { runBridge } from "./bridge.js";

async function main() {
  console.log("=== WeChat <-> Claude 桥接服务 ===\n");

  if (!ANTHROPIC_API_KEY) {
    console.error("错误: 请设置 ANTHROPIC_API_KEY 环境变量");
    console.error("复制 .env.example 为 .env 并填入你的 API Key");
    process.exit(1);
  }

  // Login
  let creds = loadCredentials();
  if (!creds) {
    creds = await login();
  } else {
    console.log(`使用已保存的凭据: ${creds.accountId}`);
  }

  // Graceful shutdown
  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    saveConversations();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    console.log("\n正在停止...");
    saveConversations();
    ac.abort();
  });

  // Run
  await runBridge(creds, ac.signal);
}

main().catch(err => {
  console.error(`致命错误: ${err}`);
  process.exit(1);
});
