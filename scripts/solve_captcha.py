#!/usr/bin/env python3
"""
Interactive captcha solver for Avito in Python.
Launches visible browser, allows user to solve puzzle/slider, and updates storageState.json.
"""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from avito_core import (
    DATA_DIR,
    DEFAULT_USER_AGENT,
    STORAGE_STATE_PATH,
    clean_stale_locks,
    find_system_chrome,
)
from playwright.async_api import async_playwright

PLIST_PATH = Path.home() / "Library/LaunchAgents/com.foorsee.avito-chrome-cdp.plist"


async def main():
    had_daemon = False
    if sys.platform == "darwin" and PLIST_PATH.exists():
        try:
            subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True)
            had_daemon = True
            print("[solve] Временно приостановлен фоновый демон LaunchAgent...")
        except Exception:
            pass

    # Kill stray Chrome processes using avito-data
    try:
        subprocess.run(["pkill", "-f", "Google Chrome.*avito-data"], capture_output=True)
    except Exception:
        pass

    clean_stale_locks(DATA_DIR)

    chrome_path = find_system_chrome()
    print("=" * 70)
    print(" 🧩 Запуск браузера для решения капчи / разблокировки Авито...")
    print("=" * 70)

    launch_args = [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-agent={DEFAULT_USER_AGENT}",
    ]
    if sys.platform == "linux":
        launch_args.append("--no-sandbox")

    async with async_playwright() as p:
        try:
            context = await p.chromium.launch_persistent_context(
                user_data_dir=str(DATA_DIR),
                headless=False,
                executable_path=chrome_path or None,
                viewport=None,
                locale="ru-RU",
                args=launch_args,
            )
        except Exception:
            context = await p.chromium.launch_persistent_context(
                user_data_dir=str(DATA_DIR),
                headless=False,
                channel="chrome",
                viewport=None,
                locale="ru-RU",
                args=launch_args,
            )

        page = context.pages[0] if context.pages else await context.new_page()
        print("Открываем https://www.avito.ru/ ...")
        try:
            await page.goto("https://www.avito.ru/", wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass

        await asyncio.sleep(1.5)

        # Check for 'Продолжить' button
        try:
            btn = await page.query_selector("button:has-text('Продолжить'), [class*='button']:has-text('Продолжить')")
            if btn:
                print("Нажимаем кнопку 'Продолжить' для открытия пазла...")
                await btn.click()
        except Exception:
            pass

        print("\n" + "-" * 70)
        print("👉 ИНСТРУКЦИЯ:")
        print("1. В открывшемся окне браузера решите пазл (переместите слайдер).")
        print("2. Скрипт автоматически определит прохождение капчи.")
        print("   (Либо нажмите [ENTER] в этой консоли, если капча уже пройдена).")
        print("-" * 70 + "\n")

        resolved = False

        async def check_auto():
            nonlocal resolved
            while not resolved:
                await asyncio.sleep(1.5)
                if resolved:
                    break
                try:
                    title = await page.title()
                    body = await page.inner_text("body")
                    is_blocked = (
                        "Доступ ограничен" in title
                        or "проблема с IP" in title
                        or "проверка безопасности" in title
                        or "Доступ ограничен: проблема с IP" in body
                    )
                    if not is_blocked and title:
                        print(f"\n🎉 Капча успешно пройдена! Заголовок страницы: '{title}'")
                        resolved = True
                        break
                except Exception:
                    pass

        loop = asyncio.get_event_loop()

        async def wait_enter():
            nonlocal resolved
            await loop.run_in_executor(None, input, "Нажмите [ENTER] после решения капчи: ")
            resolved = True

        auto_task = asyncio.create_task(check_auto())
        enter_task = asyncio.create_task(wait_enter())

        done, pending = await asyncio.wait(
            [auto_task, enter_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()

        print("Сохраняем сессию и cookies...")
        try:
            await context.storage_state(path=str(STORAGE_STATE_PATH))
        except Exception as e:
            print(f"Ошибка сохранения storage_state: {e}")

        await context.close()
        print("Браузер закрыт.")

    if had_daemon:
        print("Возобновляем работу фонового демона LaunchAgent...")
        try:
            subprocess.run(["launchctl", "load", str(PLIST_PATH)], check=True)
            print("Фоновый демон перезапущен!")
        except Exception as e:
            print(f"Не удалось перезапустить демон: {e}")

    print("=" * 70)
    print("✅ УСПЕХ! Блокировка снята, куки обновлены. MCP готов к работе.")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
