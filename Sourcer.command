#!/bin/bash
# Double-click to open Sourcer. Installs what it needs the first time.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then double-click this again."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (a minute or two)..."
  npm install --silent || { echo "npm install failed"; read -n 1 -s -r; exit 1; }
  npx playwright install chromium || { echo "browser install failed"; read -n 1 -s -r; exit 1; }
fi
node src/cli.js menu
echo; read -n 1 -s -r -p "Done. Press any key to close."
