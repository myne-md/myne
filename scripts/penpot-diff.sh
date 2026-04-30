#!/usr/bin/env bash
# penpot-diff.sh — pixel-diff Penpot canvas exports against the live React render.
#
# Usage:
#   scripts/penpot-diff.sh [--regions] <playwright-dir> <penpot-dir> <output-dir>
#
# Inputs (PNGs, must be SAME pixel dimensions, e.g. 1280×800):
#   <playwright-dir>/<screen>.png   — Playwright viewport screenshot of the live app
#   <penpot-dir>/<screen>.png       — Penpot canvas-board export
#
# Output (in <output-dir>):
#   diff-<screen>.png        — red-overlay diff (ImageMagick `compare`)
#   triptych-<screen>.png    — Penpot | Playwright | Diff (640×360 each)
#   metrics.txt              — RMSE, SSIM, verdict per screen
#   regions.txt              — (only with --regions) per-region RMSE+SSIM
#
# Flags:
#   --regions   Also split each pair into header/body/footer (200/400/200 px)
#               and report per-region metrics in regions.txt.
#
# Notes:
#   ImageMagick's `compare -metric SSIM` actually outputs DSSIM (dissimilarity);
#   we convert SSIM = 1 - DSSIM_norm so the result fits the conventional
#   "1 = identical, 0 = totally different" reading.
#
# Requires: ImageMagick 7+ (`magick`, `compare`).

set -uo pipefail  # NOTE: no -e — `compare` returns 1 when images differ, expected.

REGIONS=0
if [ "${1:-}" = "--regions" ]; then
  REGIONS=1
  shift
fi

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 [--regions] <playwright-dir> <penpot-dir> <output-dir>" >&2
  exit 1
fi

PW_DIR="$1"
PEN_DIR="$2"
OUT_DIR="$3"
mkdir -p "$OUT_DIR"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick \`magick\` not found. Install: brew install imagemagick" >&2
  exit 1
fi

# Verdict thresholds. ImageMagick's SSIM is an aggressive aggregate over the
# whole image; even visually identical full-frame compares hover around 0.86
# because anti-aliasing differences pull the score down. These thresholds
# are calibrated against that behaviour, not the textbook 0.95+ scale.
# Region-mode (200/400/200) sees much higher SSIM on truly identical strips
# (Editor body = 0.999) so the same thresholds work for both modes.
verdict_for_ssim() {
  awk -v s="$1" 'BEGIN{
    if (s+0 >= 0.86) print "near-identical";
    else if (s+0 >= 0.80) print "review";
    else print "fix-needed";
  }'
}

# Computes "RMSE_norm_pct SSIM" for the given image pair (and optional diff PNG)
compute_metrics() {
  local pen="$1" pw="$2" diff_png="${3:-null:}"

  # RMSE: outputs "abs (normalized)" where normalized is 0..1
  local rmse_raw rmse_norm rmse_pct
  rmse_raw=$(compare -metric RMSE "$pen" "$pw" "$diff_png" 2>&1 | tr -d '\n')
  rmse_norm=$(printf "%s" "$rmse_raw" | awk -F'[()]' '{print $2}')
  rmse_pct=$(awk -v n="$rmse_norm" 'BEGIN{printf "%.2f", n*100}')

  # SSIM: ImageMagick reports DSSIM (dissimilarity) — invert it
  local ssim_raw dssim ssim
  ssim_raw=$(compare -metric SSIM "$pen" "$pw" null: 2>&1 | tr -d '\n')
  dssim=$(printf "%s" "$ssim_raw" | awk -F'[()]' '{print $2}')
  if [ -z "$dssim" ]; then
    # SSIM output may be a single bare number for identical images ("0")
    dssim="$ssim_raw"
  fi
  ssim=$(awk -v d="$dssim" 'BEGIN{printf "%.3f", 1.0 - d}')

  echo "$rmse_pct $ssim"
}

TMPRUN=$(mktemp -d)
trap 'rm -rf "$TMPRUN"' EXIT

METRICS_FILE="$OUT_DIR/metrics.txt"
{
  printf "%-22s %12s %8s %-16s\n" "Screen" "RMSE_norm%" "SSIM" "Verdict"
  printf "%-22s %12s %8s %-16s\n" "----------------------" "------------" "--------" "----------------"
} > "$METRICS_FILE"
cat "$METRICS_FILE"

REGIONS_FILE="$OUT_DIR/regions.txt"
if [ "$REGIONS" -eq 1 ]; then
  {
    printf "%-22s %-8s %12s %8s %-16s\n" "Screen" "Region" "RMSE_norm%" "SSIM" "Verdict"
    printf "%-22s %-8s %12s %8s %-16s\n" "----------------------" "--------" "------------" "--------" "----------------"
  } > "$REGIONS_FILE"
fi

shopt -s nullglob
for pw_png in "$PW_DIR"/*.png; do
  base="$(basename "$pw_png" .png)"
  pen_png="$PEN_DIR/$base.png"
  [ -f "$pen_png" ] || continue

  pw_size=$(magick identify -format "%wx%h" "$pw_png")
  pen_size=$(magick identify -format "%wx%h" "$pen_png")
  if [ "$pw_size" != "$pen_size" ]; then
    echo "[skip] $base: size mismatch ($pw_size vs $pen_size)" >&2
    continue
  fi

  diff_png="$OUT_DIR/diff-$base.png"
  triptych_png="$OUT_DIR/triptych-$base.png"

  read -r rmse_pct ssim < <(compute_metrics "$pen_png" "$pw_png" "$diff_png")
  verdict=$(verdict_for_ssim "$ssim")

  line=$(printf "%-22s %11s%% %8s %-16s\n" "$base" "$rmse_pct" "$ssim" "$verdict")
  echo "$line" | tee -a "$METRICS_FILE"

  magick \
    "$pen_png" -resize 640x360 \
    "$pw_png" -resize 640x360 \
    "$diff_png" -resize 640x360 \
    +append "$triptych_png" 2>/dev/null

  if [ "$REGIONS" -eq 1 ]; then
    for region in header body footer; do
      case "$region" in
        header) crop="1280x200+0+0";;
        body)   crop="1280x400+0+200";;
        footer) crop="1280x200+0+600";;
      esac
      pen_r="$TMPRUN/${base}-${region}-pen.png"
      pw_r="$TMPRUN/${base}-${region}-pw.png"
      magick "$pen_png" -crop "$crop" +repage "$pen_r"
      magick "$pw_png"  -crop "$crop" +repage "$pw_r"
      read -r r_pct r_ssim < <(compute_metrics "$pen_r" "$pw_r")
      r_verdict=$(verdict_for_ssim "$r_ssim")
      r_line=$(printf "%-22s %-8s %11s%% %8s %-16s\n" "$base" "$region" "$r_pct" "$r_ssim" "$r_verdict")
      echo "$r_line" | tee -a "$REGIONS_FILE"
    done
  fi
done

echo
echo "Diffs:     $OUT_DIR/diff-*.png"
echo "Triptychs: $OUT_DIR/triptych-*.png"
echo "Metrics:   $METRICS_FILE"
[ "$REGIONS" -eq 1 ] && echo "Regions:   $REGIONS_FILE"
