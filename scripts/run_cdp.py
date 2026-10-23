#!/usr/bin/env python3
"""
Chrome DevTools Protocol (CDP) background launcher for Avito automation.
Launches system Chrome on port 9222 with user-data-dir and stealth flags.
Used for sandboxed environments (macOS / Gemini Desktop) and standalone daemon.
"""

import os
import subprocess
import sys
from pathlib import Path

# Add root directory to sys.path to import avito_core
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from avito_core import DATA_DIR, DEFAULT_USER_AGENT, clean_stale_locks, find_system_chrome


def main():
    clean_stale_locks(DATA_DIR)

    chrome_path = find_system_chrome()
    if not chrome_path:
        print("[avito-cdp] Ошибка: Браузер Chrome не найден. Установите Google Chrome или задайте AVITO_CHROME_PATH.", file=sys.stderr)
        sys.exit(1)

    port = os.getenv("AVITO_CDP_PORT", "9222")
    is_linux = sys.platform == "linux"
    in_docker = Path("/.dockerenv").exists()
    is_root = hasattr(os, "getuid") and os.getuid() == 0

    force_headless = False
    if os.getenv("AVITO_HEADLESS") == "true":
        force_headless = True
    elif os.getenv("AVITO_HEADLESS") == "false":
        force_headless = False
    else:
        force_headless = is_linux and not os.getenv("DISPLAY") and not os.getenv("WAYLAND_DISPLAY")

    args = [
        chrome_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={DATA_DIR}",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--use-mock-keychain",
        "--password-store=basic",
        f"--user-agent={DEFAULT_USER_AGENT}",
    ]

    if is_linux and (os.getenv("AVITO_NO_SANDBOX") == "true" or is_root or in_docker):
        args.extend(["--no-sandbox", "--disable-setuid-sandbox"])

    if force_headless:
        args.append("--headless=new")
    else:
        args.extend(["--window-position=-3000,-3000", "--window-size=1280,800"])

    print(f"[avito-cdp] Запуск Chrome на порту {port}...")
    print(f"[avito-cdp] Бинарник: {chrome_path}")
    print(f"[avito-cdp] Папка профиля: {DATA_DIR}")

    try:
        proc = subprocess.Popen(args)
        proc.wait()
    except (KeyboardInterrupt, SystemExit):
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
