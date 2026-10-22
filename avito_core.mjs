import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";
import { launchPersistentBrowser, getStorageStatePath, restoreCookies, getDataDir } from "./browser_launcher.mjs";

const log = (...args) => console.error("[avito-core]", ...args);
const DATA_DIR = getDataDir();

let browserInstance = null;
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

export async function cleanupExtraTabs(context, targetPage) {
  if (isCdp) {
    // In CDP mode, never close tabs that might belong to the user's browser session
    return;
  }
  try {
    const pages = context.pages();
    for (const p of pages) {
      if (p !== targetPage && !p.isClosed()) {
        await p.close().catch(() => {});
      }
    }
  } catch (err) {
    log("error cleaning extra tabs:", err.message);
  }
}

export async function getBrowserContext() {
  if (browserInstance?.context) return browserInstance.context;

  // 0. Connect via Chrome DevTools Protocol (CDP) if available
  // This bypasses macOS sandbox restrictions in environments like Gemini Desktop / Claude Desktop
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
      const ctx = contexts.length > 0 ? contexts[0] : await cdpBrowser.newContext({ locale: "ru-RU" });
      isCdp = true;
      log("successfully connected over CDP");

      // Context-level stealth & restore cookies in CDP mode
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      }).catch(() => {});

      // In CDP mode, Chrome already manages its profile SQLite cookies.
      // Only import from storageState.json if profile currently has no Avito cookies.
      const existingCookies = await ctx.cookies(["https://www.avito.ru"]).catch(() => []);
      if (existingCookies.length === 0) {
        const storagePath = getStorageStatePath(DATA_DIR);
        await restoreCookies(ctx, storagePath);
      }

      cdpBrowser.on("disconnected", () => {
        log("CDP browser disconnected");
        browserInstance = null;
        activePage = null;
        cdpBrowser = null;
        isCdp = false;
      });

      browserInstance = { context: ctx, dataDir: DATA_DIR, storagePath, isCdp: true };
      return ctx;
    } catch (err) {
      log("failed connecting over CDP, falling back to local launch:", err.message);
      cdpBrowser = null;
      isCdp = false;
    }
  }

  // 1. Launch local persistent browser context
  log("acquiring local persistent browser context...");
  browserInstance = await launchPersistentBrowser({ isLogin: false });
  const { context } = browserInstance;

  context.on("close", () => {
    log("browser context closed");
    browserInstance = null;
    activePage = null;
  });

  return context;
}

export async function getPage() {
  const ctx = await getBrowserContext();
  if (!activePage || activePage.isClosed()) {
    const pages = ctx.pages();
    activePage = pages.length > 0 ? pages[0] : await ctx.newPage();
  }
  return activePage;
}

export async function closeBrowser() {
  if (isCdp) {
    if (cdpBrowser) {
      await cdpBrowser.disconnect().catch(() => {});
    }
    browserInstance = null;
    activePage = null;
    cdpBrowser = null;
    isCdp = false;
    return;
  }

  if (browserInstance?.context) {
    if (browserInstance.storagePath) {
      await browserInstance.context.storageState({ path: browserInstance.storagePath }).catch(() => {});
    }
    await browserInstance.context.close().catch(() => {});
    browserInstance = null;
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

export function validateAvitoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("URL не указан или имеет неверный формат");
  }
  const trimmed = rawUrl.trim();
  if (/^\d+$/.test(trimmed)) {
    return `https://www.avito.ru/${trimmed}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Некорректный URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Разрешен только протокол https:, получено: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "avito.ru" && hostname !== "www.avito.ru" && !hostname.endsWith(".avito.ru")) {
    throw new Error(`Разрешены только ссылки на домен avito.ru, получено: ${hostname}`);
  }
  return parsed.toString();
}

async function ensureNotBlocked(page, maxWaitMs = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const title = await page.title().catch(() => "");
    const bodyText = await page.innerText("body").catch(() => "");
    const isBlocked =
      title.includes("Доступ ограничен") ||
      title.includes("проверка безопасности") ||
      bodyText.includes("Доступ ограничен: проблема с IP") ||
      bodyText.includes("Доступ ограничен: проверка безопасности");

    if (!isBlocked) {
      return true;
    }
    log("waiting for security challenge redirect, title:", title);
    await page.waitForTimeout(1500);
  }
  throw new Error("Антибот Авито: доступ ограничен (проблема с IP или проверка безопасности). Повторите позже или проверьте соединение.");
}

async function checkNeedsLogin(page) {
  const url = page.url();
  if (url.includes("#login") || url.includes("/login")) return true;
  const hasLoginModal = await page
    .$('[data-marker*="login-form"], [data-marker*="auth-modal"], [data-marker="passport/auth"]')
    .then((el) => !!el)
    .catch(() => false);
  return hasLoginModal;
}

// -------------------------------------------------------------------------
// Tools Implementation
// -------------------------------------------------------------------------

export async function searchAvito({ query, location = "all", price_min, price_max, sort = "default", limit = 10 }) {
  if (price_min !== undefined && price_max !== undefined && price_min > price_max) {
    throw new Error(`price_min (${price_min}) не может быть больше price_max (${price_max})`);
  }

  return executeWithLock(async () => {
    const page = await getPage();
    let loc = location.toLowerCase().trim();
    if (loc === "россия" || loc === "все" || loc === "всей россии") loc = "all";
    if (loc === "москва") loc = "moskva";
    if (loc === "питер" || loc === "санкт-петербург") loc = "sankt-peterburg";

    const encodedLoc = loc.split("/").map(encodeURIComponent).join("/");

    const params = new URLSearchParams();
    params.set("q", query);
    if (price_min !== undefined) params.set("pmin", String(price_min));
    if (price_max !== undefined) params.set("pmax", String(price_max));
    if (sort === "price_asc") params.set("s", "1");
    if (sort === "price_desc") params.set("s", "2");
    if (sort === "date") params.set("s", "104");

    const targetUrl = `https://www.avito.ru/${encodedLoc}?${params.toString()}`;
    log("navigating to search:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await ensureNotBlocked(page);

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
        const urlMatch = url.match(/_(\d+)(?:\?|$)/);
        const rawId = el.getAttribute("data-item-id") || (urlMatch ? urlMatch[1] : "") || el.getAttribute("id") || "";
        const id = rawId.replace(/^i/, "");

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
  const validUrl = validateAvitoUrl(url);

  return executeWithLock(async () => {
    const page = await getPage();
    log("fetching item details:", validUrl);
    await page.goto(validUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await ensureNotBlocked(page);

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
  const validUrl = validateAvitoUrl(url);

  return executeWithLock(async () => {
    const ctx = await getBrowserContext();
    let page = await getPage();
    log("opening item or chat to send message:", validUrl);
    await page.goto(validUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await ensureNotBlocked(page);
    await page.waitForTimeout(2000);

    const pagesBefore = ctx.pages().length;
    const messageBtn = await page.$('[data-marker="messenger-button/link"], [data-marker*="messenger-button"], button:has-text("Написать"), a:has-text("Написать")');
    if (messageBtn) {
      log("clicking messenger button on item page...");
      await messageBtn.click();
      await page.waitForTimeout(3000);

      // Check if a new tab was opened
      if (ctx.pages().length > pagesBefore) {
        activePage = ctx.pages()[ctx.pages().length - 1];
        page = activePage;
      }
      await ensureNotBlocked(page);
    }

    if (await checkNeedsLogin(page)) {
      throw new Error("Необходима авторизация в аккаунте Авито! Запустите npm run login для входа.");
    }

    // Scoped chat input selectors (never generic page textarea)
    const inputSelector = [
      'textarea[data-marker*="reply-input"]',
      'textarea[data-marker*="chat-input"]',
      '[data-marker*="chat"] textarea',
      '[data-marker*="messenger"] textarea',
      '[class*="chat-input"] textarea',
      '[class*="chat"] [contenteditable="true"]',
      '[class*="messenger"] [contenteditable="true"]'
    ].join(", ");

    const inputEl = await page.waitForSelector(inputSelector, { timeout: 12000 }).catch(() => null);
    if (!inputEl) {
      throw new Error("Поле ввода сообщения в чате не найдено. Возможно, продавец отключил сообщения или страница не загрузилась.");
    }

    log("typing message into chat...");
    const normMessage = message.replace(/\s+/g, " ").trim();
    const countBefore = await page.evaluate((target) => {
      const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
      const els = document.querySelectorAll(
        '[data-marker*="message-item"], [data-marker*="message-text"], [class*="message-text"], [class*="ChatMessage"]'
      );
      let count = 0;
      for (const el of els) {
        if (normalize(el.innerText).includes(target)) {
          count++;
        }
      }
      return count;
    }, normMessage).catch(() => 0);

    await inputEl.scrollIntoViewIfNeeded?.().catch(() => {});
    await inputEl.click();
    await inputEl.fill(message);
    await page.waitForTimeout(600);

    // Send button scoped strictly to chat/messenger (never page-wide button[type=submit])
    const sendBtnSelector = [
      'button[data-marker*="send"]',
      'button[data-marker*="chat-send"]',
      'button[data-marker*="reply-send"]',
      '[data-marker*="chat"] button[type="submit"]',
      '[data-marker*="messenger"] button[type="submit"]'
    ].join(", ");

    const sendBtn = await page.$(sendBtnSelector);
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await inputEl.press("Enter");
    }

    // Delivery confirmation: verify normalized message count increases in chat history
    log("verifying message delivery in chat history...");
    const delivered = await page
      .waitForFunction(
        ({ target, beforeCount }) => {
          const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
          const els = document.querySelectorAll(
            '[data-marker*="message-item"], [data-marker*="message-text"], [class*="message-text"], [class*="ChatMessage"]'
          );
          let count = 0;
          for (const el of els) {
            if (normalize(el.innerText).includes(target)) {
              count++;
            }
          }
          return count > beforeCount;
        },
        { target: normMessage, beforeCount: countBefore },
        { timeout: 12000 }
      )
      .catch(() => false);

    if (!delivered) {
      throw new Error("Сообщение было отправлено, но не появилось в ленте чата. Возможно, оно заблокировано модерацией Авито или произошел сбой сети.");
    }

    // Clean up any extra tabs that were opened
    await cleanupExtraTabs(ctx, page);

    log("message delivered and verified successfully");
    return {
      status: "success",
      chat_url: page.url(),
      sent_message: message
    };
  });
}

export async function listChats({ limit = 10 }) {
  return executeWithLock(async () => {
    const page = await getPage();
    log("navigating to messenger chat list...");
    await page.goto("https://www.avito.ru/profile/messenger", { waitUntil: "domcontentloaded", timeout: 45000 });
    await ensureNotBlocked(page);
    await page.waitForTimeout(3000);

    if (await checkNeedsLogin(page)) {
      throw new Error("Необходима авторизация в аккаунте Авито! Запустите npm run login для входа.");
    }

    const chats = await page.$$eval('[data-marker*="channel-item"], [class*="channel-item"]', (els, max) => {
      return els.slice(0, max).map((el) => {
        const titleEl = el.querySelector('[class*="title"], [data-marker*="title"]');
        const snippetEl = el.querySelector('[class*="snippet"], [data-marker*="snippet"]');
        const unreadEl = el.querySelector('[class*="unread"]');
        const linkEl = el.querySelector("a") || el;
        let href = linkEl.getAttribute("href") || "";
        if (href) {
          try {
            const resolved = new URL(href, "https://www.avito.ru");
            if (resolved.protocol === "https:" && (resolved.hostname === "avito.ru" || resolved.hostname.endsWith(".avito.ru"))) {
              href = resolved.toString();
            } else {
              href = "";
            }
          } catch (_) {
            href = "";
          }
        }

        return {
          chat_url: href,
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

export async function getChatHistory({ chat_url, limit = 15 }) {
  const targetUrl = chat_url ? validateAvitoUrl(chat_url) : "https://www.avito.ru/profile/messenger";

  return executeWithLock(async () => {
    const page = await getPage();
    log("navigating to chat:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await ensureNotBlocked(page);
    await page.waitForTimeout(3000);

    if (await checkNeedsLogin(page)) {
      throw new Error("Необходима авторизация в аккаунте Авито! Запустите npm run login для входа.");
    }

    // If no specific chat_url was provided, pick the first active conversation from the list
    if (!chat_url) {
      const firstChatLink = await page.$eval('[data-marker*="channel-item"] a, [class*="channel-item"] a', el => el.getAttribute("href")).catch(() => null);
      if (firstChatLink) {
        let fullChatUrl = null;
        try {
          fullChatUrl = validateAvitoUrl(new URL(firstChatLink, "https://www.avito.ru").toString());
        } catch (_) {}

        if (fullChatUrl) {
          log("opening first conversation from list:", fullChatUrl);
          await page.goto(fullChatUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
          await ensureNotBlocked(page);
          await page.waitForTimeout(2500);
        }
      }
    }

    // Extract messages: deduplicate nested elements and use strict word boundaries for direction
    const messages = await page.$$eval(
      '[data-marker*="message-item"], [class*="message-item"], [class*="ChatMessage"]',
      (els, max) => {
        // Filter out nested duplicates: only keep elements that have no other matched element as an ancestor
        const uniqueEls = els.filter((el) => !els.some((other) => other !== el && other.contains(el)));

        return uniqueEls.slice(-max).map((el) => {
          const textEl = el.querySelector('[data-marker*="message-text"], [class*="message-text"], [class*="text"]') || el;
          const timeEl = el.querySelector('[data-marker*="message-time"], [class*="message-time"], [class*="time"]');

          // Strict direction check: use word boundaries or explicit data attributes
          const className = el.className || "";
          const isOut =
            /\b(out|message-out|ChatMessage-module_out)\b/.test(className) ||
            el.getAttribute("data-is-out") === "true";

          return {
            sender: isOut ? "me" : "seller",
            text: textEl ? textEl.innerText.trim() : "",
            time: timeEl ? timeEl.innerText.trim() : ""
          };
        });
      },
      limit
    );

    return {
      chat_url: page.url(),
      title: await page.title(),
      messages_count: messages.length,
      messages
    };
  });
}
