import { chromium } from "playwright-core";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = (...args) => console.error("[browser-launcher]", ...args);

// Auto-load .env
const envPath = path.join(__dirname, ".env");
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

// On macOS, GUI apps (like Claude Desktop / Cursor / Gemini Desktop) don't inherit /opt/homebrew/bin in PATH
if (process.platform === "darwin") {
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/sbin"];
  const currentPath = process.env.PATH || "";
  const missing = extraPaths.filter((p) => !currentPath.includes(p));
  if (missing.length > 0) {
    process.env.PATH = missing.join(":") + ":" + currentPath;
  }
}

export function getDataDir() {
  return process.env.AVITO_DATA_DIR || path.join(__dirname, "avito-data");
}

export function getStorageStatePath(dataDir) {
  return path.join(dataDir || getDataDir(), "storageState.json");
}

export function cleanStaleLocks(dir) {
  try {
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      const p = path.join(dir, f);
      try {
        if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) {
          fs.unlinkSync(p);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

export function findSystemChromePath() {
  if (process.env.AVITO_CHROME_PATH && fs.existsSync(process.env.AVITO_CHROME_PATH)) {
    return process.env.AVITO_CHROME_PATH;
  }

  const candidatePaths = [];
  if (process.platform === "darwin") {
    // Chrome for Testing (Playwright) — prioritized on macOS to bypass Keychain restrictions
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
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

export function getLaunchOptions({ isLogin = false, dataDir = getDataDir() } = {}) {
  const isLinux = process.platform === "linux";
  // On macOS and Linux servers in background MCP mode, default to headless unless login is requested
  const forceHeadless = !isLogin && (process.env.AVITO_HEADLESS !== "false");

  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--use-mock-keychain",
    "--password-store=basic"
  ];

  // Only use --no-sandbox if explicitly requested or running as root on Linux
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isLinux && (process.env.AVITO_NO_SANDBOX === "true" || isRoot)) {
    launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  if (isLogin) {
    launchArgs.push("--start-maximized");
  } else if (!forceHeadless) {
    launchArgs.push("--window-position=-3000,-3000", "--window-size=1280,800");
  }

  const customPath = findSystemChromePath();
  const storagePath = getStorageStatePath(dataDir);

  const options = {
    headless: forceHeadless,
    args: launchArgs,
    viewport: isLogin ? null : { width: 1280, height: 800 },
    locale: "ru-RU",
    executablePath: customPath || undefined
  };

  return { options, dataDir, storagePath };
}

export async function launchPersistentBrowser({ isLogin = false } = {}) {
  const { options, dataDir, storagePath } = getLaunchOptions({ isLogin });
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  cleanStaleLocks(dataDir);

  let context = null;
  let lastError = null;

  // 1. Try custom path if found
  if (options.executablePath) {
    try {
      context = await chromium.launchPersistentContext(dataDir, options);
      log("launched browser using executablePath:", options.executablePath);
    } catch (err) {
      lastError = err;
      log("failed launching executablePath:", err.message);
    }
  }

  // 2. Try standard system browser channels
  if (!context) {
    const channels = ["chrome", "msedge", "chromium"];
    for (const ch of channels) {
      try {
        context = await chromium.launchPersistentContext(dataDir, {
          ...options,
          channel: ch
        });
        log(`launched browser with channel '${ch}'`);
        break;
      } catch (err) {
        lastError = err;
      }
    }
  }

  // 3. Try default bundled chromium (if installed via npx playwright install)
  if (!context) {
    try {
      context = await chromium.launchPersistentContext(dataDir, {
        ...options,
        executablePath: undefined
      });
      log("launched default bundled chromium");
    } catch (err) {
      lastError = err;
    }
  }

  if (!context) {
    let profileLockHint = "";
    const msg = lastError?.message || "";
    if (msg.includes("ProcessSingleton") || msg.includes("lock") || msg.includes("Target closed") || msg.includes("EBUSY")) {
      profileLockHint = " Профиль браузера в avito-data заблокирован другим процессом (например, открытым окном браузера или login_avito). Закройте его и повторите.";
    }
    throw new Error(
      `Не удалось запустить браузер.${profileLockHint} Убедитесь, что установлен Chrome, Edge или Chromium, либо укажите путь через переменную AVITO_CHROME_PATH. Последняя ошибка: ${msg}`
    );
  }

  // Context-level automation stealth for all current and future tabs
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Restore saved cookies from storageState.json
  await restoreCookies(context, storagePath);

  return { context, dataDir, storagePath, isCdp: false };
}

export async function restoreCookies(context, storagePath) {
  if (fs.existsSync(storagePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
      if (saved.cookies && Array.isArray(saved.cookies) && saved.cookies.length > 0) {
        await context.addCookies(saved.cookies).catch(() => {});
        log(`restored ${saved.cookies.length} cookies from storageState.json`);
      }
    } catch (err) {
      log("failed restoring cookies from storageState.json:", err.message);
    }
  }
}
