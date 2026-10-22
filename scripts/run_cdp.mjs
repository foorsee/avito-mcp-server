#!/usr/bin/env node
import { spawn } from "child_process";
import { findSystemChromePath, getDataDir, cleanStaleLocks } from "../browser_launcher.mjs";

const DATA_DIR = getDataDir();
cleanStaleLocks(DATA_DIR);

const chromePath = findSystemChromePath();
if (!chromePath) {
  console.error("Error: Chrome binary not found. Please install Chrome or specify AVITO_CHROME_PATH.");
  process.exit(1);
}

const port = process.env.AVITO_CDP_PORT || "9222";
const forceHeadless = process.env.AVITO_HEADLESS !== "false";

const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${DATA_DIR}`,
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--use-mock-keychain",
  "--password-store=basic"
];

const isLinux = process.platform === "linux";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
if (isLinux && (process.env.AVITO_NO_SANDBOX === "true" || isRoot)) {
  args.push("--no-sandbox", "--disable-setuid-sandbox");
}

if (forceHeadless) {
  args.push("--headless=new");
}

console.log(`[avito-cdp] Launching Chrome on port ${port}...`);
console.log(`[avito-cdp] Executable: ${chromePath}`);
console.log(`[avito-cdp] Profile dir: ${DATA_DIR}`);

const child = spawn(chromePath, args, {
  stdio: "inherit"
});

child.on("error", (err) => {
  console.error("[avito-cdp] Failed to start Chrome process:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  console.log(`[avito-cdp] Chrome exited with code ${code}, signal ${signal}`);
  process.exit(code || 0);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
