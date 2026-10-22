#!/usr/bin/env node
import fs from "fs";
import { spawn } from "child_process";
import { findSystemChromePath, getDataDir, checkProfileLock } from "../browser_launcher.mjs";

const DATA_DIR = getDataDir();
const lockStatus = checkProfileLock(DATA_DIR);
if (lockStatus.isLocked) {
  console.error(`[avito-cdp] Profile directory (${DATA_DIR}) is locked: ${lockStatus.reason}`);
  console.error("[avito-cdp] Please close any running Chrome processes using this profile before starting CDP daemon.");
  process.exit(1);
}

const chromePath = findSystemChromePath();
if (!chromePath) {
  console.error("Error: Chrome binary not found. Please install Chrome or specify AVITO_CHROME_PATH.");
  process.exit(1);
}

const port = process.env.AVITO_CDP_PORT || "9222";
const isLinux = process.platform === "linux";
const isHeadlessEnv = isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

let forceHeadless = false;
if (process.env.AVITO_HEADLESS === "true") {
  forceHeadless = true;
} else if (process.env.AVITO_HEADLESS === "false") {
  forceHeadless = false;
} else {
  forceHeadless = isHeadlessEnv;
}

const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${DATA_DIR}`,
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--use-mock-keychain",
  "--password-store=basic",
  "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const inDocker = fs.existsSync("/.dockerenv");
if (isLinux && (process.env.AVITO_NO_SANDBOX === "true" || isRoot || inDocker)) {
  args.push("--no-sandbox", "--disable-setuid-sandbox");
}

if (forceHeadless) {
  args.push("--headless=new");
} else {
  args.push("--window-position=-3000,-3000", "--window-size=1280,800");
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
