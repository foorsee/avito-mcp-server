#!/usr/bin/env python3
"""
Interactive login helper for Avito in Python 3.12+.
Launches visible browser to log in with SMS/password/push and saves session
cookies to avito-data/storageState.json.
"""

import asyncio
import os
import sys
from pathlib import Path

from avito_core import DATA_DIR, DEFAULT_USER_AGENT, STORAGE_STATE_PATH, find_system_chrome
from playwright.async_api import async_playwright


async def main():
    print("=" * 60)
    print(" 🚀 Запуск браузера для авторизации на Avito (Python)...")
    print("=" * 60)

    chrome_path = find_system_chrome()

    launch_args = [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-agent={DEFAULT_USER_AGENT}"
    ]

    if sys.platform == "linux":
        launch_args.append("--no-sandbox")

    async with async_playwright() as p:
        try:
            context = await p.chromium.launch_persistent_context(
                user_data_dir=str(DATA_DIR),
                headless=False,
                args=launch_args,
                executable_path=chrome_path or None,
                viewport=None,
                locale="ru-RU"
            )
        except Exception:
            context = await p.chromium.launch_persistent_context(
                user_data_dir=str(DATA_DIR),
                headless=False,
                channel="chrome",
                args=launch_args,
                viewport=None,
                locale="ru-RU"
            )

        page = context.pages[0] if context.pages else await context.new_page()

        print("Открываем страницу Avito...")
        await page.goto("https://www.avito.ru/", wait_until="domcontentloaded", timeout=90000)

        print("\n" + "-" * 60)
        print("👉 ИНСТРУКЦИЯ:")
        print("1. В открывшемся окне браузера нажмите 'Вход и регистрация'.")
        print("2. Введите номер телефона и войдите по СМС / пушу / паролю.")
        print("3. Убедитесь, что в правом верхнем углу отображается ваш профиль.")
        print("4. Вернитесь в эту консоль и нажмите клавишу [ENTER].")
        print("-" * 60 + "\n")

        # Run input in executor to not block asyncio loop
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, input, "Нажмите [ENTER] после того, как вошли в аккаунт: ")

        print("\nСохраняем сессию и cookies...")
        await context.storage_state(path=str(STORAGE_STATE_PATH))

        print("-" * 60)
        print("✅ УСПЕХ! Сессия авторизации сохранена в:")
        print(f"   {STORAGE_STATE_PATH}")
        print("-" * 60)

        await context.close()
        print("Браузер закрыт. Python MCP-сервер готов к работе!")


if __name__ == "__main__":
    asyncio.run(main())
