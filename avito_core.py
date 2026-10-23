#!/usr/bin/env python3
"""
Core automation module for Avito using Playwright in Python 3.12+.
Supports:
- Chrome DevTools Protocol (CDP) connection (essential for sandboxed environments like Gemini Desktop)
- Local persistent context (Docker, VPS, local Linux/Windows/Mac)
- Session persistence via storageState.json
- Anti-bot stealth & challenge detection
"""

import asyncio
import json
import logging
import os
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from dotenv import load_dotenv
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

logging.basicConfig(level=logging.INFO, format="[avito-core-py] %(message)s")
log = logging.getLogger("avito_core")

# Load .env file from root
ROOT_DIR = Path(__file__).resolve().parent
ENV_PATH = ROOT_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

DATA_DIR = Path(os.getenv("AVITO_DATA_DIR", ROOT_DIR / "avito-data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
STORAGE_STATE_PATH = DATA_DIR / "storageState.json"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    if sys.platform == "darwin"
    else (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        if sys.platform == "win32"
        else "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
)

# Global runtime state
_playwright = None
_browser: Optional[Browser] = None
_context: Optional[BrowserContext] = None
_active_page: Optional[Page] = None
_is_cdp: bool = False
_lock = asyncio.Lock()


def clean_stale_locks(directory: Path):
    """Remove Chrome Singleton lock files that could block startup."""
    for lock_name in ["SingletonLock", "SingletonCookie", "SingletonSocket"]:
        lock_file = directory / lock_name
        try:
            if lock_file.exists() or lock_file.is_symlink():
                lock_file.unlink(missing_ok=True)
        except Exception:
            pass


def find_system_chrome() -> Optional[str]:
    """Find installed Chrome / Chromium binary across OS platforms."""
    explicit = os.getenv("AVITO_CHROME_PATH") or os.getenv("CHROME_PATH")
    if explicit and Path(explicit).exists():
        return explicit

    candidates = []
    if sys.platform == "darwin":
        # Check ms-playwright cache
        pw_cache = Path.home() / "Library/Caches/ms-playwright"
        if pw_cache.exists():
            for entry in pw_cache.glob("chromium-*"):
                for arch in ["chrome-mac-arm64", "chrome-mac-x64"]:
                    binary = entry / arch / "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
                    if binary.exists():
                        candidates.append(str(binary))
                        break

        candidates.extend([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            str(Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        ])
    elif sys.platform == "linux":
        candidates.extend([
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium"
        ])
    elif sys.platform == "win32":
        for base in [os.getenv("ProgramFiles"), os.getenv("ProgramFiles(x86)"), os.getenv("LOCALAPPDATA")]:
            if base:
                candidates.extend([
                    str(Path(base) / "Google/Chrome/Application/chrome.exe"),
                    str(Path(base) / "Microsoft/Edge/Application/msedge.exe")
                ])

    for c in candidates:
        if Path(c).exists():
            return c
    return None


async def restore_cookies(ctx: BrowserContext):
    """Restore Avito cookies from storageState.json if present."""
    if not STORAGE_STATE_PATH.exists():
        return
    try:
        with open(STORAGE_STATE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
            cookies = state.get("cookies", [])
            if cookies:
                await ctx.add_cookies(cookies)
                log.info("Restored %d cookies from %s", len(cookies), STORAGE_STATE_PATH.name)
    except Exception as e:
        log.warning("Could not restore cookies: %s", e)


async def save_cookies(ctx: BrowserContext):
    """Save current cookies and storage to storageState.json."""
    try:
        await ctx.storage_state(path=str(STORAGE_STATE_PATH))
        log.info("Saved cookies to %s", STORAGE_STATE_PATH.name)
    except Exception as e:
        log.warning("Could not save cookies: %s", e)


def is_cdp_available(url: str = "http://127.0.0.1:9222") -> bool:
    """Check if Chrome DevTools Protocol endpoint is reachable with a short timeout."""
    try:
        endpoint = f"{url.rstrip('/')}/json/version"
        req = urllib.request.Request(endpoint, method="GET")
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False


async def get_browser_context() -> BrowserContext:
    """Initialize or reuse browser context (CDP or local persistent)."""
    global _playwright, _browser, _context, _is_cdp

    if _context:
        return _context

    clean_stale_locks(DATA_DIR)

    if not _playwright:
        _playwright = await async_playwright().start()

    # 1. First, check CDP endpoint (bypasses sandboxes on macOS / Gemini Desktop)
    cdp_url = os.getenv("AVITO_CDP_URL", "http://127.0.0.1:9222")
    if is_cdp_available(cdp_url):
        try:
            log.info("Connecting to Chrome over CDP at %s...", cdp_url)
            _browser = await _playwright.chromium.connect_over_cdp(cdp_url)
            _context = _browser.contexts[0] if _browser.contexts else await _browser.new_context(locale="ru-RU")
            _is_cdp = True
            log.info("Successfully connected over CDP")

            await _context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
            )

            # Check if context already has cookies; if not, restore from file
            existing = await _context.cookies(["https://www.avito.ru"])
            if not existing:
                await restore_cookies(_context)

            _browser.on("disconnected", _on_disconnected)
            return _context
        except Exception as e:
            log.warning("Failed connecting over CDP (%s), falling back to local launch", e)
            _is_cdp = False
            _browser = None
            _context = None

    # 2. Local persistent launch (Servers, Docker, or Desktop)
    log.info("Launching local persistent browser context...")
    chrome_path = find_system_chrome()
    force_headless = os.getenv("AVITO_HEADLESS", "true").lower() != "false"

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--use-mock-keychain",
        "--password-store=basic",
        f"--user-agent={DEFAULT_USER_AGENT}"
    ]

    # Docker / root check
    is_root = hasattr(os, "getuid") and os.getuid() == 0
    in_docker = Path("/.dockerenv").exists()
    if os.getenv("AVITO_NO_SANDBOX") == "true" or is_root or in_docker:
        launch_args.extend(["--no-sandbox", "--disable-setuid-sandbox"])

    if not force_headless:
        launch_args.extend(["--window-position=-3000,-3000", "--window-size=1280,800"])

    launch_options = {
        "headless": force_headless,
        "args": launch_args,
        "viewport": {"width": 1280, "height": 800},
        "locale": "ru-RU",
        "user_agent": DEFAULT_USER_AGENT,
        "executable_path": chrome_path or None
    }

    try:
        _context = await _playwright.chromium.launch_persistent_context(
            user_data_dir=str(DATA_DIR),
            **launch_options
        )
        _is_cdp = False
        log.info("Launched local persistent context with executable: %s", chrome_path or "default")
    except Exception as err:
        # Fallback to standard channel 'chrome'
        try:
            del launch_options["executable_path"]
            _context = await _playwright.chromium.launch_persistent_context(
                user_data_dir=str(DATA_DIR),
                channel="chrome",
                **launch_options
            )
            _is_cdp = False
        except Exception:
            raise RuntimeError(
                f"Не удалось запустить браузер (путь: {chrome_path or 'auto'}). Ошибка: {err}. "
                "Убедитесь, что установлен Chrome / Chromium, либо укажите AVITO_CHROME_PATH."
            )

    await _context.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
    )

    existing = await _context.cookies(["https://www.avito.ru"])
    if not existing:
        await restore_cookies(_context)

    _context.on("close", _on_context_close)
    return _context


def _on_disconnected():
    global _browser, _context, _active_page, _is_cdp
    log.info("CDP browser disconnected")
    _browser = None
    _context = None
    _active_page = None
    _is_cdp = False


def _on_context_close():
    global _context, _active_page
    log.info("Browser context closed")
    _context = None
    _active_page = None


async def get_page() -> Page:
    """Get existing page or create a new tab."""
    global _active_page
    ctx = await get_browser_context()
    if not _active_page or _active_page.is_closed:
        pages = ctx.pages
        _active_page = pages[0] if pages else await ctx.new_page()
    return _active_page


async def close_browser():
    """Disconnect from CDP or close local persistent context."""
    global _browser, _context, _active_page, _is_cdp, _playwright

    if _is_cdp:
        if _active_page and not _active_page.is_closed:
            try:
                await _active_page.goto("about:blank", timeout=5000)
            except Exception:
                pass
        if _browser:
            try:
                await _browser.close()
            except Exception:
                pass
        _browser = None
        _context = None
        _active_page = None
        _is_cdp = False
        return

    if _context:
        try:
            await save_cookies(_context)
            await _context.close()
        except Exception:
            pass
        _context = None
        _active_page = None

    if _playwright:
        try:
            await _playwright.stop()
        except Exception:
            pass
        _playwright = None


async def ensure_not_blocked(page: Page, max_wait_sec: float = 15.0):
    """Check whether Avito security challenge or IP rate-limit is active."""
    start = asyncio.get_event_loop().time()
    while (asyncio.get_event_loop().time() - start) < max_wait_sec:
        title = await page.title() or ""
        body_text = await page.inner_text("body") or ""
        is_blocked = (
            "Доступ ограничен" in title
            or "проверка безопасности" in title
            or "проблема с IP" in title
            or "Доступ ограничен: проблема с IP" in body_text
            or "Доступ ограничен: проверка безопасности" in body_text
        )
        if not is_blocked:
            return True

        log.info("Waiting for security challenge redirect, title: %s", title)
        await asyncio.sleep(1.5)

    title = await page.title() or ""
    raise RuntimeError(
        f"Антибот Авито: доступ ограничен ({title}). "
        "Запустите решение капчи через 'python login_avito.py' / 'npm run solve', либо смените IP."
    )


def validate_avito_url(raw_url: str) -> str:
    """Validate that the URL belongs to avito.ru domain."""
    url = raw_url.strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        url = f"https://{url}"

    parsed = urlparse(url)
    if parsed.scheme != "https":
        parsed = parsed._replace(scheme="https")

    hostname = (parsed.hostname or "").lower()
    if hostname != "avito.ru" and not hostname.endswith(".avito.ru"):
        raise ValueError(f"Разрешены только ссылки на домен avito.ru, получено: {hostname}")

    return urlunparse(parsed)


# ---------------------------------------------------------------------------
# Core Tools
# ---------------------------------------------------------------------------

async def search_avito(
    query: str,
    location: str = "all",
    price_min: Optional[int] = None,
    price_max: Optional[int] = None,
    sort: str = "default",
    limit: int = 10
) -> Dict[str, Any]:
    """Search for listings on Avito."""
    if price_min is not None and price_max is not None and price_min > price_max:
        raise ValueError(f"price_min ({price_min}) не может быть больше price_max ({price_max})")

    async with _lock:
        page = await get_page()

        loc = location.lower().strip()
        loc_map = {
            "россия": "all", "все": "all", "всей россии": "all",
            "москва": "moskva",
            "питер": "sankt-peterburg", "санкт-петербург": "sankt-peterburg",
            "крым": "respublika_krym", "krym": "respublika_krym",
            "симферополь": "simferopol", "севастополь": "sevastopol",
            "евпатория": "evpatoriya"
        }
        loc = loc_map.get(loc, loc)

        params = {"q": query}
        if price_min is not None:
            params["pmin"] = str(price_min)
        if price_max is not None:
            params["pmax"] = str(price_max)

        sort_map = {"price_asc": "1", "price_desc": "2", "date": "104"}
        if sort in sort_map:
            params["s"] = sort_map[sort]

        target_url = f"https://www.avito.ru/{loc}?{urlencode(params)}"
        log.info("Navigating to search: %s", target_url)

        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        await ensure_not_blocked(page)

        try:
            await page.wait_for_selector('[data-marker="item"]', timeout=8000)
        except Exception:
            pass

        items = await page.evaluate(
            """
            (limit) => {
                const els = Array.from(document.querySelectorAll('[data-marker="item"]'));
                return els.slice(0, limit).map(el => {
                    const titleEl = el.querySelector('[data-marker="item-title"]');
                    const priceEl = el.querySelector('[data-marker="item-price"]');
                    const linkEl = el.querySelector('a[data-marker="item-title"]') || el.querySelector('a');
                    const descEl = el.querySelector('[class*="description"]');
                    const geoEl = el.querySelector('[class*="geo"]');
                    const dateEl = el.querySelector('[data-marker="item-date"]') || el.querySelector('[class*="date"]');
                    const imgEl = el.querySelector('img[src*="img.avito.st"], img[data-src*="img.avito.st"], img');

                    const title = titleEl ? titleEl.innerText.trim() : (linkEl ? (linkEl.getAttribute("title") || "") : "");
                    const price = priceEl ? priceEl.innerText.trim() : "";
                    const href = linkEl ? linkEl.getAttribute("href") : "";
                    const url = href ? (href.startsWith("http") ? href : `https://www.avito.ru${href}`) : "";
                    const location = geoEl ? geoEl.innerText.trim().replace(/\\s+/g, " ") : "";
                    const description = descEl ? descEl.innerText.trim() : "";
                    const date = dateEl ? dateEl.innerText.trim() : "";

                    let image = "";
                    if (imgEl) {
                        const src = imgEl.currentSrc || imgEl.getAttribute("src") || imgEl.getAttribute("data-src") || "";
                        if (src && !src.startsWith("data:")) image = src;
                    }

                    const urlMatch = url.match(/_(\\d+)(?:\\?|$)/);
                    const rawId = el.getAttribute("data-item-id") || (urlMatch ? urlMatch[1] : "") || el.getAttribute("id") || "";
                    const id = rawId.replace(/^i/, "");

                    const text = el.innerText || "";
                    const isReserved = text.includes("Товар зарезервирован") || text.includes("Зарезервировано");
                    const hasDelivery = text.includes("Доставка") || !!el.querySelector('[data-marker*="delivery"]');

                    return {
                        id, title, price, url, image, location, description, date,
                        is_reserved: isReserved, has_delivery: hasDelivery
                    };
                });
            }
            """,
            limit
        )

        return {
            "query": query,
            "location": loc,
            "count": len(items),
            "items": items
        }


async def get_item_details(url: str) -> Dict[str, Any]:
    """Get full details of a specific Avito listing."""
    target_url = url.strip()
    if re.match(r"^\d+$", target_url):
        target_url = f"https://www.avito.ru/{target_url}"
    else:
        target_url = validate_avito_url(target_url)

    async with _lock:
        page = await get_page()
        log.info("Fetching item details: %s", target_url)

        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        await ensure_not_blocked(page)
        await asyncio.sleep(2.0)

        data = await page.evaluate(
            """
            () => {
                const titleEl = document.querySelector('[data-marker="item-view/title-info"]');
                const priceEl = document.querySelector('[data-marker="item-view/item-price"]');
                const descEl = document.querySelector('[data-marker="item-view/item-description"]');
                const sellerNameEl = document.querySelector('[data-marker="seller-info/name"]');
                const sellerLabelEl = document.querySelector('[data-marker="seller-info/label"]');
                const sellerScoreEl = document.querySelector('[data-marker*="rating"] [class*="score"], [data-marker="seller-rating/score"]');
                const sellerSummaryEl = document.querySelector('[data-marker*="rating"] [class*="summary"], [data-marker="seller-rating/summary"]');
                const addressEl = document.querySelector('[itemprop="address"]');

                const paramsEls = document.querySelectorAll('[data-marker*="item-view/item-params"] li, [class*="params-paramsList"] li');
                const params = Array.from(paramsEls).map(el => el.innerText.trim().replace(/\\s+/g, " "));

                const bodyText = document.body ? document.body.innerText : "";
                const isReserved = bodyText.includes("Товар зарезервирован") || bodyText.includes("Зарезервировано");
                const hasDelivery = bodyText.includes("Купить с доставкой") || bodyText.includes("Авито Доставка") || !!document.querySelector('[data-marker*="delivery"]');
                const hasMessageBtn = !!document.querySelector('[data-marker*="messenger-button"], button:has-text("Написать"), a:has-text("Написать")');

                return {
                    title: titleEl ? titleEl.innerText.trim() : document.title,
                    price: priceEl ? priceEl.innerText.trim() : "",
                    description: descEl ? descEl.innerText.trim() : "",
                    address: addressEl ? addressEl.innerText.trim() : "",
                    params,
                    is_reserved: isReserved,
                    has_delivery: hasDelivery,
                    can_message: hasMessageBtn,
                    seller: {
                        name: sellerNameEl ? sellerNameEl.innerText.trim() : "",
                        label: sellerLabelEl ? sellerLabelEl.innerText.trim() : "",
                        rating: sellerScoreEl ? sellerScoreEl.innerText.trim() : "",
                        summary: sellerSummaryEl ? sellerSummaryEl.innerText.trim() : ""
                    }
                };
            }
            """
        )

        return {
            "url": page.url,
            **data
        }


async def list_chats(limit: int = 10) -> Dict[str, Any]:
    """List recent chats from Avito messenger."""
    async with _lock:
        page = await get_page()
        log.info("Navigating to messenger chats...")
        await page.goto("https://www.avito.ru/profile/messenger", wait_until="domcontentloaded", timeout=45000)
        await ensure_not_blocked(page)
        await asyncio.sleep(3.0)

        if "/login" in page.url or "#login" in page.url:
            raise RuntimeError("Необходима авторизация в аккаунте Авито! Запустите 'python login_avito.py' для входа.")

        chats = await page.evaluate(
            """
            (limit) => {
                const els = Array.from(document.querySelectorAll(
                    'a[data-marker*="channels/channelLink"], [data-marker*="channel-item"], [class*="channel-item"]'
                ));
                const results = [];
                const seenUrls = new Set();

                for (const el of els) {
                    if (results.length >= limit) break;
                    const a = el.tagName === "A" ? el : (el.querySelector("a") || el.closest("a"));
                    let href = a ? (a.getAttribute("href") || "") : "";
                    if (!href) continue;

                    try {
                        const resolved = new URL(href, "https://www.avito.ru");
                        if (resolved.protocol === "https:" && (resolved.hostname === "avito.ru" || resolved.hostname.endsWith(".avito.ru"))) {
                            href = resolved.toString();
                        } else {
                            continue;
                        }
                    } catch (_) {
                        continue;
                    }

                    if (seenUrls.has(href)) continue;
                    seenUrls.add(href);

                    const titleEl = el.querySelector('[class*="name"], [data-marker*="title"], [class*="title"]') || el.querySelector("strong, h3");
                    const snippetEl = el.querySelector('[class*="message"], [class*="snippet"], [data-marker*="snippet"], [class*="text"]');
                    const unreadEl = el.querySelector('[class*="unread"], [data-marker*="unread"]');

                    results.push({
                        chat_url: href,
                        title: titleEl ? titleEl.innerText.trim() : "",
                        last_message: snippetEl ? snippetEl.innerText.trim() : "",
                        has_unread: !!unreadEl
                    });
                }
                return results;
            }
            """,
            limit
        )

        return {
            "count": len(chats),
            "chats": chats
        }


async def get_chat_history(chat_url: Optional[str] = None, limit: int = 15) -> Dict[str, Any]:
    """Read message history in an active Avito chat."""
    target_url = validate_avito_url(chat_url) if chat_url else "https://www.avito.ru/profile/messenger"

    async with _lock:
        page = await get_page()
        log.info("Navigating to chat: %s", target_url)

        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        await ensure_not_blocked(page)
        await asyncio.sleep(3.0)

        if "/login" in page.url or "#login" in page.url:
            raise RuntimeError("Необходима авторизация в аккаунте Авито! Запустите 'python login_avito.py' для входа.")

        # If no specific chat_url, click or navigate to first chat link
        if not chat_url:
            first_link = await page.evaluate(
                """
                () => {
                    const el = document.querySelector('a[data-marker*="channels/channelLink"], [data-marker*="channel-item"] a');
                    return el ? el.getAttribute("href") : null;
                }
                """
            )
            if first_link:
                try:
                    full_url = validate_avito_url(f"https://www.avito.ru{first_link}" if first_link.startswith("/") else first_link)
                    log.info("Opening first chat from list: %s", full_url)
                    await page.goto(full_url, wait_until="domcontentloaded", timeout=45000)
                    await ensure_not_blocked(page)
                    await asyncio.sleep(2.5)
                except Exception as e:
                    log.warning("Could not open first chat: %s", e)

        messages = await page.evaluate(
            """
            (limit) => {
                const els = Array.from(document.querySelectorAll(
                    '[data-marker="message"], [data-marker*="message-item"], [class*="ChatMessage"]'
                ));
                // Filter out nested duplicates
                const uniqueEls = els.filter(el => !els.some(other => other !== el && other.contains(el)));

                return uniqueEls.slice(-limit).map(el => {
                    const textEl = el.querySelector('[data-marker="messageText"], [class*="messageText"], [class*="text"]') || el;
                    const timeEl = el.querySelector('[data-marker*="time"], [class*="time"]');
                    const className = el.className || "";

                    const isOut = className.includes("right") ||
                                  className.includes("message_blue") ||
                                  /\\b(out|message-out|ChatMessage-module_out)\\b/.test(className) ||
                                  el.getAttribute("data-is-out") === "true";

                    return {
                        sender: isOut ? "me" : "seller",
                        text: textEl ? textEl.innerText.trim() : "",
                        time: timeEl ? timeEl.innerText.trim() : ""
                    };
                });
            }
            """,
            limit
        )

        return {
            "chat_url": page.url,
            "title": await page.title(),
            "messages_count": len(messages),
            "messages": messages
        }


async def send_message(url: str, message: str) -> Dict[str, Any]:
    """Send a message to an Avito seller via listing or chat page."""
    target_url = validate_avito_url(url)

    async with _lock:
        page = await get_page()
        log.info("Opening item or chat to send message: %s", target_url)

        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        await ensure_not_blocked(page)
        await asyncio.sleep(2.5)

        # Check if on item page with messenger button
        msg_btn = await page.query_selector(
            '[data-marker="messenger-button/link"], [data-marker*="messenger-button"], button:has-text("Написать"), a:has-text("Написать")'
        )
        if msg_btn:
            log.info("Clicking messenger button on item page...")
            await msg_btn.click()
            await asyncio.sleep(3.0)
            await ensure_not_blocked(page)

        if "/login" in page.url or "#login" in page.url:
            raise RuntimeError("Необходима авторизация в аккаунте Авито! Запустите 'python login_avito.py' для входа.")

        input_sel = 'textarea[data-marker*="reply-input"], textarea[data-marker*="message"], [contenteditable="true"], textarea'
        try:
            input_el = await page.wait_for_selector(input_sel, timeout=10000)
        except Exception:
            input_el = None

        if not input_el:
            raise RuntimeError("Поле ввода сообщения в чате не найдено. Возможно, продавец отключил сообщения.")

        await input_el.click()
        await input_el.fill(message)
        await asyncio.sleep(0.8)

        send_btn = await page.query_selector(
            'button[data-marker*="send"], button[type="submit"], [data-marker*="send-button"]'
        )
        if send_btn:
            await send_btn.click()
        else:
            await input_el.press("Enter")

        await asyncio.sleep(2.5)
        log.info("Message sent successfully")

        return {
            "status": "success",
            "chat_url": page.url,
            "sent_message": message
        }
