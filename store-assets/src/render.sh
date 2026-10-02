#!/bin/sh
# Renders the Chrome Web Store tiles into ../ using headless Chrome.
# Renders at 4x then downsamples to the exact store size for clean, sharp edges.
cd "$(dirname "$0")"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
r() {
  "$CH" --headless=new --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=4000 \
    --force-device-scale-factor=4 --window-size=$2,$3 --screenshot="$TMP/$4" "file://$PWD/$1" 2>/dev/null
  sips -s format png -z $3 $2 "$TMP/$4" --out "../$4" >/dev/null
}
r promo_small.html 440 280 promo_tile_440x280.png
r marquee.html 1400 560 marquee_tile_1400x560.png
rm -rf "$TMP"
