#!/usr/bin/env bash
set -e
echo "Запуск авторизации Avito..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/login_avito.js"
