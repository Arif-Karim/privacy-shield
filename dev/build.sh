#!/bin/sh
# Builds the store package (dist/privacy-shield-v<version>.zip, version from
# manifest.json) without the dev-only auto-reloader, then runs the end-to-end
# tests against exactly that build. Zips of other versions are kept.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./manifest.json").version')
ZIP="dist/privacy-shield-v$VERSION.zip"
OUT=dist/build
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"
cp -R manifest.json src icons "$OUT"/
rm "$OUT/src/dev-reload.js"
grep -v '^import "./dev-reload.js";$' src/background.js > "$OUT/src/background.js"
if grep -rq "dev-reload" "$OUT"; then echo "dev-reload still referenced in build" >&2; exit 1; fi
for f in "$OUT"/src/*.js; do node --check "$f"; done
(cd "$OUT" && zip -qrX "../$(basename "$ZIP")" . -x "*.DS_Store")
echo "Built $ZIP"
cd dev
[ -d node_modules ] || npm install --silent
EXTENSION_DIR=../dist/build node e2e.mjs
