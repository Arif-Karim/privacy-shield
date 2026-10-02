#!/bin/sh
# Opens a separate Chrome window with the extension loaded from this folder,
# reloading it automatically whenever a file changes. Also serves
# dev/test-page.html (a phone form) at http://localhost:8791/test-page.html.
cd "$(dirname "$0")/.."
python3 -m http.server 8791 --directory dev >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
npx --yes web-ext@10 run --target=chromium --source-dir=. \
  --ignore-files "backend/**" "docs/**" "store-assets/**" "dist/**" "dev/**" "*.md" \
  --start-url http://localhost:8791/test-page.html
