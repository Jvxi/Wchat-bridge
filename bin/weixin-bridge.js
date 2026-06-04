#!/usr/bin/env node

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcPath = join(__dirname, "..", "src", "index.ts");

try {
  execSync(`npx tsx "${srcPath}"`, {
    stdio: "inherit",
    cwd: join(__dirname, ".."),
  });
} catch (err) {
  process.exit(err.status || 1);
}
