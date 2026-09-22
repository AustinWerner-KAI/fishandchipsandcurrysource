#!/bin/bash
# Double-click to open Sourcer. Installs what it needs the first time.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then double-click this again."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
if [ ! -d node_modules ]; then echo "First run: installing (a minute or two)..."; fi
# quick when nothing changed; picks up new packages after an update
npm install --silent || { echo "npm install failed"; read -n 1 -s -r; exit 1; }
# idempotent: only downloads when the matching browser build is missing
npx playwright install chromium >/dev/null 2>&1 || { echo "browser install failed, check your internet connection"; read -n 1 -s -r; exit 1; }
echo "Sourcer is running. Keep this window open. Close it to stop everything."
# The app restarts itself after an update (exit code 75) and carries on with what it was doing.
export SOURCER_SUPERVISED=1
while true; do
  node src/cli.js app
  code=$?
  if [ $code -eq 75 ]; then echo "Updated. Starting the new version..."; npm install --silent >/dev/null 2>&1; continue; fi
  break
done
