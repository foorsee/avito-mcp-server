#!/usr/bin/env python3
"""
Uninstall macOS LaunchAgent for background Chrome CDP daemon.
"""

import subprocess
import sys
from pathlib import Path

if sys.platform != "darwin":
    print("LaunchAgent доступен только на macOS.")
    sys.exit(0)

HOME_DIR = Path.home()
PLIST_PATH = HOME_DIR / "Library/LaunchAgents/com.foorsee.avito-chrome-cdp.plist"


def main():
    if PLIST_PATH.exists():
        try:
            subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True)
        except Exception:
            pass

        PLIST_PATH.unlink(missing_ok=True)
        print("[daemon] LaunchAgent com.foorsee.avito-chrome-cdp успешно выгружен и удален.")
    else:
        print("[daemon] Файл LaunchAgent plist не найден.")


if __name__ == "__main__":
    main()
