import { chromium } from "playwright-core";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Автоматически подгружаем .env если есть
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

const log = (...args) => console.error("[avito-core]", ...args);
const DATA_DIR = process.env.AVITO_DATA_DIR || path.join(__dirname, "avito-data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let context = null;
let activePage = null;
let cdpBrowser = null;
let isCdp = false;
let idleTimer = null;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
let requestLock = Promise.resolve();

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    log("idle timeout - closing browser context to free RAM");
    await closeBrowser().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function cleanStaleLocks(dir) {
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

function getLaunchOptions() {
  // По умолчанию для MCP-сервера в фоне запускаем headless, чтобы macOS WindowServer не падал
  const forceHeadless = process.env.AVITO_HEADLESS !== "false";

  const launchArgs = [
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

  if (!forceHeadless) {
    launchArgs.push("--window-position=-3000,-3000", "--window-size=1280,800");
  }

  let customPath = process.env.AVITO_CHROME_PATH || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!customPath) {
    const candidatePaths = [];
    if (process.platform === "darwin") {
      // Chrome for Testing (Playwright) — highest priority on macOS to bypass Keychain restrictions
      try {
        const pwDir = path.join(process.env.HOME || "", "Library/Caches/ms-playwright");
        if (fs.existsSync(pwDir)) {
          const entries = fs.readdirSync(pwDir);
          for (const entry of entries) {
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
        customPath = p;
        break;
      }
    }
  }

  return {
    headless: forceHeadless,
    args: launchArgs,
    viewport: { width: 1280, height: 800 },
    locale: "ru-RU",
    executablePath: customPath || undefined
  };
}

export async function getBrowserContext() {
  if (context) return context;
  cleanStaleLocks(DATA_DIR);

  // 0. Connect via Chrome DevTools Protocol (CDP) if available
  // This completely bypasses macOS sandbox restrictions in environments like Gemini Desktop
  const cdpUrl = process.env.AVITO_CDP_URL || "http://127.0.0.1:9222";
  let cdpAvailable = false;
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) cdpAvailable = true;
  } catch (_) {}

  if (cdpAvailable) {
    try {
      log(`connecting to browser over CDP at ${cdpUrl}...`);
      cdpBrowser = await chromium.connectOverCDP(cdpUrl);
      const contexts = cdpBrowser.contexts();
      context = contexts.length > 0 ? contexts[0] : await cdpBrowser.newContext({ locale: "ru-RU" });
      isCdp = true;
      log("successfully connected over CDP");

      cdpBrowser.on("disconnected", () => {
        log("CDP browser disconnected");
        context = null;
        activePage = null;
        cdpBrowser = null;
        isCdp = false;
      });

      return context;
    } catch (err) {
      log("failed connecting over CDP, falling back to local launch:", err.message);
      cdpBrowser = null;
      isCdp = false;
    }
  }

  log("launching persistent browser context...");
  const baseOptions = getLaunchOptions();
  let lastError = null;

  // 1. Try custom path if specified
  if (baseOptions.executablePath && fs.existsSync(baseOptions.executablePath)) {
    try {
      context = await chromium.launchPersistentContext(DATA_DIR, baseOptions);
      log("launched with custom executablePath:", baseOptions.executablePath);
    } catch (err) {
      lastError = err;
      log("failed custom executablePath:", err.message);
    }
  }

  // 2. Try standard system browser channels
  if (!context) {
    const channels = ["chrome", "msedge", "chromium"];
    for (const ch of channels) {
      try {
        context = await chromium.launchPersistentContext(DATA_DIR, {
          ...baseOptions,
          channel: ch
        });
        log(`launched browser with channel '${ch}'`);
        break;
      } catch (err) {
        // try next channel
      }
    }
  }

  // 3. Try bundled/installed Chromium
  if (!context) {
    try {
      context = await chromium.launchPersistentContext(DATA_DIR, baseOptions);
      log("launched default chromium");
    } catch (e) {
      // ignore
    }
  }

  // 4. Search common binary paths for macOS, Linux and Windows
  if (!context) {
    const commonPaths = [];
    if (process.platform === "darwin") {
      commonPaths.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        path.join(process.env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      );
    } else if (process.platform === "linux") {
      commonPaths.push(
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
      commonPaths.push(
        path.join(progFiles, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(progFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(progFilesX86, "Microsoft\\Edge\\Application\\msedge.exe")
      );
    }

    for (const binPath of commonPaths) {
      if (fs.existsSync(binPath)) {
        try {
          context = await chromium.launchPersistentContext(DATA_DIR, {
            ...baseOptions,
            executablePath: binPath
          });
          log(`launched browser at '${binPath}'`);
          break;
        } catch (err) {
          log(`failed launching browser at '${binPath}':`, err.message);
        }
      }
    }
  }

  if (!context) {
    const detail = lastError ? (lastError.message || String(lastError)) : "браузер не найден";
    throw new Error(
      `Не удалось запустить браузер (путь: ${baseOptions.executablePath || "auto"}). Ошибка: ${detail}`
    );
  }

  context.on("close", () => {
    log("browser context closed");
    context = null;
    activePage = null;
  });

  return context;
}

export async function getPage() {
  const ctx = await getBrowserContext();
  if (!activePage || activePage.isClosed()) {
    activePage = ctx.pages().length > 0 ? ctx.pages()[0] : await ctx.newPage();
    await activePage.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }
  return activePage;
}

export async function closeBrowser() {
  if (isCdp) {
    if (activePage && !activePage.isClosed()) {
      await activePage.goto("about:blank").catch(() => {});
    }
    if (cdpBrowser) {
      await cdpBrowser.close().catch(() => {});
    }
    context = null;
    activePage = null;
    cdpBrowser = null;
    isCdp = false;
    return;
  }

  if (context) {
    await context.close().catch(() => {});
    context = null;
    activePage = null;
  }
}

async function executeWithLock(fn) {
  resetIdle();
  const prevLock = requestLock;
  let resolveLock;
  requestLock = new Promise((res) => {
    resolveLock = res;
  });

  try {
    await prevLock;
    return await fn();
  } finally {
    resolveLock();
    resetIdle();
  }
}

async function handleChallenge(page, maxWaitMs = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const title = await page.title().catch(() => "");
    if (!title.includes("Доступ ограничен") && !title.includes("проверка безопасности")) {
      return true;
    }
    log("waiting for challenge redirect, title:", title);
    await page.waitForTimeout(1500);
  }
  return false;
}

export async function searchAvito({ query, location = "all", price_min, price_max, sort = "default", limit = 10 }) {
  return executeWithLock(async () => {
    const page = await getPage();
    let loc = location.toLowerCase().trim();
    if (loc === "россия" || loc === "все" || loc === "всей россии") loc = "all";
    if (loc === "москва") loc = "moskva";
    if (loc === "питер" || loc === "санкт-петербург") loc = "sankt-peterburg";

    const params = new URLSearchParams();
    params.set("q", query);
    if (price_min !== undefined) params.set("pmin", String(price_min));
    if (price_max !== undefined) params.set("pmax", String(price_max));
    if (sort === "price_asc") params.set("s", "1");
    if (sort === "price_desc") params.set("s", "2");
    if (sort === "date") params.set("s", "104");

    const targetUrl = `https://www.avito.ru/${encodeURIComponent(loc)}?${params.toString()}`;
    log("navigating to search:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleChallenge(page);

    await page.waitForSelector('[data-marker="item"]', { timeout: 8000 }).catch(() => {});

    const items = await page.$$eval('[data-marker="item"]', (els, max) => {
      return els.slice(0, max).map((el) => {
        const titleEl = el.querySelector('[data-marker="item-title"]');
        const priceEl = el.querySelector('[data-marker="item-price"]');
        const linkEl = el.querySelector('a[data-marker="item-title"]') || el.querySelector('a');
        const descEl = el.querySelector('[class*="description"]');
        const geoEl = el.querySelector('[class*="geo"]');
        const dateEl = el.querySelector('[data-marker="item-date"]') || el.querySelector('[class*="date"]');

        const title = titleEl ? titleEl.innerText.trim() : (linkEl ? linkEl.getAttribute("title") || "" : "");
        const price = priceEl ? priceEl.innerText.trim() : "";
        const href = linkEl ? linkEl.getAttribute("href") : "";
        const url = href ? (href.startsWith("http") ? href : `https://www.avito.ru${href}`) : "";
        const location = geoEl ? geoEl.innerText.trim().replace(/\s+/g, " ") : "";
        const description = descEl ? descEl.innerText.trim() : "";
        const date = dateEl ? dateEl.innerText.trim() : "";
        const id = el.getAttribute("data-item-id") || (url.match(/_(\d+)(\?|$)/) ? url.match(/_(\d+)(\?|$)/)[1] : "");

        const text = el.innerText || "";
        const isReserved = text.includes("Товар зарезервирован") || text.includes("Зарезервировано");
        const hasDelivery = text.includes("Доставка") || !!el.querySelector('[data-marker*="delivery"]');

        return { id, title, price, url, location, description, date, is_reserved: isReserved, has_delivery: hasDelivery };
      });
    }, limit);

    return {
      query,
      location: loc,
      count: items.length,
      items
    };
  });
}

export async function getItemDetails({ url }) {
  return executeWithLock(async () => {
    const page = await getPage();
    let targetUrl = url;
    if (/^\d+$/.test(url.trim())) {
      targetUrl = `https://www.avito.ru/${url.trim()}`;
    }
    log("fetching item details:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleChallenge(page);

    await page.waitForTimeout(2000);

    const title = await page.$eval('[data-marker="item-view/title-info"]', el => el.innerText.trim()).catch(async () => page.title());
    const price = await page.$eval('[data-marker="item-view/item-price"]', el => el.innerText.trim()).catch(() => "");
    const description = await page.$eval('[data-marker="item-view/item-description"]', el => el.innerText.trim()).catch(() => "");
    const sellerName = await page.$eval('[data-marker="seller-info/name"]', el => el.innerText.trim()).catch(() => "");
    const sellerLabel = await page.$eval('[data-marker="seller-info/label"]', el => el.innerText.trim()).catch(() => "");
    const sellerScore = await page.$eval('[data-marker*="rating"] [class*="score"], [data-marker="seller-rating/score"]', el => el.innerText.trim()).catch(() => "");
    const sellerSummary = await page.$eval('[data-marker*="rating"] [class*="summary"], [data-marker="seller-rating/summary"]', el => el.innerText.trim()).catch(() => "");
    const address = await page.$eval('[itemprop="address"]', el => el.innerText.trim()).catch(() => "");

    const params = await page.$$eval('[data-marker*="item-view/item-params"] li, [class*="params-paramsList"] li', els =>
      els.map(el => el.innerText.trim().replace(/\s+/g, " "))
    ).catch(() => []);

    const bodyText = await page.innerText("body").catch(() => "");
    const isReserved = bodyText.includes("Товар зарезервирован") || bodyText.includes("Зарезервировано");
    const hasDelivery = bodyText.includes("Купить с доставкой") || bodyText.includes("Авито Доставка") || (await page.$('[data-marker*="delivery"]').then(el => !!el).catch(() => false));

    const hasMessageButton = await page.$('[data-marker*="messenger-button"], button:has-text("Написать"), a:has-text("Написать")').then(el => !!el).catch(() => false);

    return {
      url: page.url(),
      title,
      price,
      is_reserved: isReserved,
      has_delivery: hasDelivery,
      address,
      description,
      params,
      seller: {
        name: sellerName,
        label: sellerLabel,
        rating: sellerScore,
        summary: sellerSummary
      },
      can_message: hasMessageButton
    };
  });
}

export async function sendMessage({ url, message }) {
  return executeWithLock(async () => {
    let page = await getPage();
    log("opening item or chat to send message:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleChallenge(page);
    await page.waitForTimeout(2500);

    const pagesBefore = context.pages().length;
    const messageBtn = await page.$('[data-marker="messenger-button/link"], button:has-text("Написать"), a:has-text("Написать")');
    if (messageBtn) {
      log("clicking messenger button on item page...");
      await messageBtn.click();
      await page.waitForTimeout(3000);
      if (context.pages().length > pagesBefore) {
        activePage = context.pages()[context.pages().length - 1];
        page = activePage;
      }
      await handleChallenge(page);
    }

    if (page.url().includes("#login") || page.url().includes("/login")) {
      throw new Error("Необходима авторизация в аккаунте Авито! Запустите npm run login для входа.");
    }

    const inputSelector = 'textarea[data-marker*="reply-input"], textarea[data-marker*="message"], [contenteditable="true"], textarea';
    const inputEl = await page.waitForSelector(inputSelector, { timeout: 10000 }).catch(() => null);
    if (!inputEl) {
      throw new Error("Поле ввода сообщения в чате не найдено. Возможно, продавец отключил сообщения или страница не загрузилась.");
    }

    log("typing message...");
    await inputEl.scrollIntoViewIfNeeded?.().catch(() => {});
    await inputEl.click();
    await inputEl.fill(message);
    await page.waitForTimeout(800);

    const sendBtn = await page.$('button[data-marker*="send"], button[type="submit"], [data-marker*="send-button"]');
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await inputEl.press("Enter");
    }

    await page.waitForTimeout(2000);
    log("message sent successfully");

    return {
      status: "success",
      chat_url: page.url(),
      sent_message: message
    };
  });
}

export async function getChatHistory({ chat_url, limit = 15 }) {
  return executeWithLock(async () => {
    const page = await getPage();
    const targetUrl = chat_url || "https://www.avito.ru/profile/messenger";
    log("navigating to chat:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleChallenge(page);
    await page.waitForTimeout(3000);

    if (page.url().includes("#login") || page.url().includes("/login")) {
      throw new Error("Необходима авторизация в аккаунте Авито! Запустите npm run login для входа.");
    }

    const messages = await page.$$eval('[data-marker*="message-item"], [class*="message-item"], [class*="ChatMessage"]', (els, max) => {
      return els.slice(-max).map((el) => {
        const textEl = el.querySelector('[class*="text"], [data-marker*="message-text"]') || el;
        const timeEl = el.querySelector('[class*="time"], [data-marker*="message-time"]');
        const isMe = el.className.includes("out") || el.getAttribute("data-is-out") === "true";
        return {
          sender: isMe ? "me" : "seller",
          text: textEl ? textEl.innerText.trim() : "",
          time: timeEl ? timeEl.innerText.trim() : ""
        };
      });
    }, limit);

    return {
      chat_url: page.url(),
      title: await page.title(),
      messages_count: messages.length,
      messages
    };
  });
}

export async function listChats({ limit = 10 }) {
  return executeWithLock(async () => {
    const page = await getPage();
    log("navigating to messenger chat list...");
    await page.goto("https://www.avito.ru/profile/messenger", { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleChallenge(page);
    await page.waitForTimeout(3000);

    if (page.url().includes("#login") || page.url().includes("/login")) {
      throw new Error("Необходима авторизация в аккаунте Авито! Запустите npm run login для входа.");
    }

    const chats = await page.$$eval('[data-marker*="channel-item"], [class*="channel-item"]', (els, max) => {
      return els.slice(0, max).map((el) => {
        const titleEl = el.querySelector('[class*="title"], [data-marker*="title"]');
        const snippetEl = el.querySelector('[class*="snippet"], [data-marker*="snippet"]');
        const unreadEl = el.querySelector('[class*="unread"]');
        const linkEl = el.querySelector("a") || el;
        const href = linkEl.getAttribute("href") || "";

        return {
          chat_url: href ? (href.startsWith("http") ? href : `https://www.avito.ru${href}`) : "",
          title: titleEl ? titleEl.innerText.trim() : "",
          last_message: snippetEl ? snippetEl.innerText.trim() : "",
          has_unread: !!unreadEl
        };
      });
    }, limit);

    return {
      count: chats.length,
      chats
    };
  });
}
