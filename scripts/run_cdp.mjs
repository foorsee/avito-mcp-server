#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// Auto-load .env
const envPath = path.join(rootDir, ".env");
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || "").trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}

const DATA_DIR = process.env.AVITO_DATA_DIR || path.join(rootDir, "avito-data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Clean stale locks
for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
  const p = path.join(DATA_DIR, f);
  try {
    if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) {
      fs.unlinkSync(p);
    }
  } catch (_) {}
}

function findChromePath() {
  if (process.env.AVITO_CHROME_PATH && fs.existsSync(process.env.AVITO_CHROME_PATH)) {
    return process.env.AVITO_CHROME_PATH;
  }

  const candidatePaths = [];
  if (process.platform === "darwin") {
    try {
      const pwDir = path.join(process.env.HOME || "", "Library/Caches/ms-playwright");
      if (fs.existsSync(pwDir)) {
        for (const entry of fs.readdirSync(pwDir)) {
          if (entry.startsWith("chromium-")) {
            const testPath = path.join(
              pwDir,
              entry,
              "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
            );
            if (fs.existsSync(testPath)) {
              candidatePaths.push(testPath);
              break;
            }
          }
        }
      }
    } catch (_) {}

    candidatePaths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(process.env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    );
  } else if (process.platform === "linux") {
    candidatePaths.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    );
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "C:\\Program Files";
    const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidatePaths.push(
      path.join(progFiles, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(progFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(progFilesX86, "Microsoft\\Edge\\Application\\msedge.exe")
    );
  }

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const chromePath = findChromePath();
if (!chromePath) {
  console.error("Error: Chrome binary not found. Please install Chrome or run 'npx playwright install chromium'.");
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
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--use-mock-keychain",
  "--password-store=basic"
];

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
