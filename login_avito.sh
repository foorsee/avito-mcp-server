#!/usr/bin/env bash
set -e
echo "Запуск авторизации Avito..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.venv/bin/python" ]; then
    "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/login_avito.py"
else
    python3 "$SCRIPT_DIR/login_avito.py"
fi
