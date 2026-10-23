#!/usr/bin/env python3
"""
Install macOS LaunchAgent for background Chrome CDP daemon.
"""

import os
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

if sys.platform != "darwin":
    print("LaunchAgent доступен только на macOS.")
    sys.exit(0)

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from avito_core import DATA_DIR

HOME_DIR = Path.home()
LAUNCH_AGENTS_DIR = HOME_DIR / "Library/LaunchAgents"
LAUNCH_AGENTS_DIR.mkdir(parents=True, exist_ok=True)

PLIST_NAME = "com.foorsee.avito-chrome-cdp.plist"
PLIST_PATH = LAUNCH_AGENTS_DIR / PLIST_NAME

python_bin = sys.executable
script_path = ROOT_DIR / "scripts/run_cdp.py"
stdout_path = DATA_DIR / "cdp.stdout.log"
stderr_path = DATA_DIR / "cdp.stderr.log"

plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.foorsee.avito-chrome-cdp</string>
  <key>ProgramArguments</key>
  <array>
    <string>{escape(str(python_bin))}</string>
    <string>{escape(str(script_path))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AVITO_DATA_DIR</key>
    <string>{escape(str(DATA_DIR))}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>{escape(str(ROOT_DIR))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{escape(str(stdout_path))}</string>
  <key>StandardErrorPath</key>
  <string>{escape(str(stderr_path))}</string>
</dict>
</plist>
"""


def main():
    try:
        subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True)
    except Exception:
        pass

    PLIST_PATH.write_text(plist_content, encoding="utf-8")
    print(f"[daemon] Создан plist: {PLIST_PATH}")

    try:
        subprocess.run(["launchctl", "load", str(PLIST_PATH)], check=True)
        print("[daemon] Успешно загружен LaunchAgent com.foorsee.avito-chrome-cdp")
        print("[daemon] Chrome CDP теперь постоянно работает в фоне!")
    except Exception as e:
        print(f"[daemon] Ошибка при загрузке LaunchAgent: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
