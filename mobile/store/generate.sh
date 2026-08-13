#!/usr/bin/env bash
# Regenerates the Myne mobile store screenshot set (App Store 6.9" — the required size).
#
#   ./store/generate.sh          (run from the myne-mobile repo root, or from store/)
#
# Needs: Google Chrome + ImageMagick 7. Everything else (fonts, brand mark) is vendored
# inside store/ so the folder is self-contained — nothing outside store/ is read or written.
#
# HOW IT WORKS: store/src/ builds ONE 6600x2868 canvas — five 1320x2868 frames side by side —
# and Chrome renders it in a single pass. Slicing that one image is what makes the solid
# backdrop, the seam-riding cards and the mark watermark line up exactly across frames;
# rendering five separate images and hoping they match would not.
#
# WHY MOCKUPS AND NOT CAPTURES: an honest capture needs an unlocked vault with representative
# notes, which no script has. So store/src/ redraws the screens from Myne's own design tokens —
# every colour, radius, spacing step and type size in store/src/screen.css is the value from
# docs/design/colors_and_type.css (warm-paper #fbfbfa, ink #1a1a17, iron-blue #2c4a7a, the
# 4px spacing scale, the Inter + JetBrains Mono families). If a token changes, change it here
# too — nothing enforces that link but this note.
#
# BRAND DISCIPLINE (PRODUCT.md): solid surfaces only (no gradient backgrounds, no glass/blur),
# no lock/shield/checkmark badges — encryption reads typographically, through the monospace
# account-number and recovery-phrase specimens. Sentence case, no hype words, no emoji.
#
# HONEST METADATA: the set shows only shipped mobile surfaces. Content is synthetic and generic
# (no real user data) and claims nothing the threat model does not back.
set -euo pipefail
cd "$(dirname "$0")"                    # store/
ROOT="$(cd .. && pwd)"                  # mobile/

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="6.9"
[ -x "$CHROME" ] || { echo "need Google Chrome at $CHROME"; exit 1; }
command -v magick >/dev/null || { echo "need ImageMagick 7 (brew install imagemagick)"; exit 1; }

node src/build.cjs
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --allow-file-access-from-files --window-size=6600,2868 \
  --screenshot="src/panorama.png" "file://$PWD/src/panorama.html" >/dev/null 2>&1

names=(01-notes 02-editor 03-graph 04-account 05-appearance)
mkdir -p "$OUT"
for i in 0 1 2 3 4; do
  # -strip: PNG embeds a tIME chunk, so without it every regeneration produces a byte-different
  # file with identical pixels — a git diff that means nothing. Stripped, re-running is a no-op.
  magick src/panorama.png -crop 1320x2868+$((i*1320))+0 +repage \
    -alpha remove -alpha off -depth 8 -strip "$OUT/${names[$i]}.png"
done
rm -f src/panorama.png src/panorama.html

echo "Generated (App Store 6.9\" = 1320x2868):"
for n in "${names[@]}"; do printf "  %-28s %s\n" "$OUT/$n.png" "$(magick identify -format '%wx%h alpha=%A' "$OUT/$n.png")"; done
