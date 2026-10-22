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

/**
 * Safely check if Chrome profile is currently locked by another active process.
 * Does NOT blindly unlink locks if process is still alive.
 */
export function checkProfileLock(dataDir) {
  const lockFiles = ["SingletonLock", "lockfile"];
  for (const f of lockFiles) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) continue;

    if (process.platform === "win32") {
      try {
        const fd = fs.openSync(p, "r+");
        fs.closeSync(fd);
      } catch (err) {
        if (err.code === "EBUSY" || err.code === "EPERM") {
          return { isLocked: true, reason: "Chrome process is running on Windows (lockfile held)" };
        }
      }
    } else {
      // Unix / macOS symlink check
      try {
        const target = fs.readlinkSync(p);
        const match = target.match(/-(\d+)$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          try {
            process.kill(pid, 0);
            return { isLocked: true, pid, reason: `Chrome process with PID ${pid} is currently active` };
          } catch (_) {
            // Process is dead, stale lock can be cleaned safely
            try {
              fs.unlinkSync(p);
              const socketPath = path.join(dataDir, "SingletonSocket");
              if (fs.existsSync(socketPath) || fs.lstatSync(socketPath).isSymbolicLink()) {
                fs.unlinkSync(socketPath);
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }
  return { isLocked: false };
}

export function cleanStaleLocks(dir) {
  return checkProfileLock(dir);
}

export function findSystemChromePath() {
  // Support AVITO_CHROME_PATH, CHROME_PATH, and PUPPETEER_EXECUTABLE_PATH
  const explicitPath =
    process.env.AVITO_CHROME_PATH || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const candidatePaths = [];
  if (process.platform === "darwin") {
    // Chrome for Testing (Playwright) — check both arm64 and x64 architectures
    try {
      const pwDir = path.join(process.env.HOME || "", "Library/Caches/ms-playwright");
      if (fs.existsSync(pwDir)) {
        const archDirs = [
          process.arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64",
          process.arch === "arm64" ? "chrome-mac-x64" : "chrome-mac-arm64"
        ];
        for (const entry of fs.readdirSync(pwDir)) {
          if (entry.startsWith("chromium-")) {
            for (const aDir of archDirs) {
              const testPath = path.join(
                pwDir,
                entry,
                `${aDir}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
              );
              if (fs.existsSync(testPath)) {
                candidatePaths.push(testPath);
                break;
              }
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
  const isHeadlessEnv = isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

  // Respect AVITO_HEADLESS if explicitly defined; otherwise only default to headless on headless Linux
  let forceHeadless = false;
  if (process.env.AVITO_HEADLESS === "true") {
    forceHeadless = true;
  } else if (process.env.AVITO_HEADLESS === "false") {
    forceHeadless = false;
  } else {
    forceHeadless = isHeadlessEnv;
  }

  if (isLogin) {
    forceHeadless = false;
  }

  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--use-mock-keychain",
    "--password-store=basic"
  ];

  // Enable --no-sandbox if in Docker, running as root, or explicitly requested
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const inDocker = fs.existsSync("/.dockerenv");
  if (isLinux && (process.env.AVITO_NO_SANDBOX === "true" || isRoot || inDocker)) {
    launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  if (isLogin) {
    launchArgs.push("--start-maximized");
  } else if (!forceHeadless) {
    // Run off-screen on desktop so it doesn't disturb user
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

  // Check if profile is already locked by another running Chrome process
  const lockStatus = checkProfileLock(dataDir);
  if (lockStatus.isLocked) {
    throw new Error(
      `Профиль браузера (${dataDir}) сейчас заблокирован: ${lockStatus.reason}. ` +
      `Если у вас запущен фоновый демон (npm run cdp), сервер подключится к нему автоматически через CDP. ` +
      `Иначе закройте запущенный браузер или процесс перед повторным запуском.`
    );
  }

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
    const msg = lastError?.message || "";
    throw new Error(
      `Не удалось запустить браузер. Убедитесь, что установлен Chrome, Edge или Chromium, либо укажите путь через переменную AVITO_CHROME_PATH. Последняя ошибка: ${msg}`
    );
  }

  // Context-level automation stealth for all current and future tabs
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Only restore from storageState.json if the persistent profile DB is fresh / doesn't have cookies yet
  // This prevents overwriting fresh session cookies with an older snapshot
  const hasProfileCookies =
    fs.existsSync(path.join(dataDir, "Default", "Network", "Cookies")) ||
    fs.existsSync(path.join(dataDir, "Default", "Cookies"));

  if (!hasProfileCookies) {
    await restoreCookies(context, storagePath);
  }

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
