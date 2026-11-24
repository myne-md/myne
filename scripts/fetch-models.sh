#!/usr/bin/env bash
# Fetch the bundled model weights that are not stored in git.
#
# The public source tree carries no binaries. OCR and speech-to-text need their
# weights in src-tauri/resources/models/<role>/ before a bundle build; the tag
# model is fetched on demand by the desktop client and is not required here.
#
# Every file is checked against the SHA-256 compiled into this script, not only
# against the origin's SHA256SUMS: the origin is a distribution channel, not a
# trust anchor.
set -euo pipefail

ORIGIN="https://downloads.myne.md/models"
DEST="src-tauri/resources/models"

usage() {
  cat >&2 <<'EOF'
usage: scripts/fetch-models.sh [--role ocr|whisper|whisper-tiny|all] [--dest DIR] [--verify-only]

  --role        which model set to fetch (default: all)
  --dest        destination root (default: src-tauri/resources/models)
  --verify-only check the files already present; download nothing

Exit codes: 0 ok, 1 download/verification failure, 2 usage error.
EOF
  exit 2
}

ROLE="all"
VERIFY_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

case "$ROLE" in
  ocr|whisper|whisper-tiny|all) ;;
  *) echo "unknown role: $ROLE" >&2; usage ;;
esac

# role|file|sha256
MODELS="
ocr|ppocrv5-mobile-det.rten|3ade1f7474ebbcd72b105618018456f48570ed9b4bcc10952b97222132fdd4fd
ocr|ppocrv5-mobile-rec.rten|10baed9456f708af2b1377fc58bcb58ded84168a3177c4aeec51a11a6f5ba834
ocr|ppocrv5-cls.rten|f4e35e6ca3d36e2dec0d5b2646f32b37caaf982fbe445b2c876ddc245bcdeff9
ocr|ppocrv5_dict.txt|1ea29636956177e400af712d9782e7693f3fb25f98617bed10479d2965a836fd
whisper|model.gguf|dd96b06f89f0ffe4a146a80835a846004688a5bc709768a47a0a13301f52b4a9
whisper|config.json|a153c53883a6799b6f056b4a8d1a515c9926d03994682ba88a7616618d7da0c1
whisper|tokenizer.json|27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566
whisper-tiny|model.gguf|16a9293d98a8a15b36a5d7f71285bff05eba62142e8094ca5d44c31161bcd57f
whisper-tiny|config.json|ffdccec4f3211f4c63310f2b7098f309fe70f3952cedc5e4d11e43f5b2379b98
whisper-tiny|tokenizer.json|27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566
"

sha() { sha256sum "$1" | awk '{print $1}'; }

failed=0
while IFS='|' read -r role file want; do
  [ -n "$role" ] || continue
  if [ "$ROLE" != "all" ] && [ "$ROLE" != "$role" ]; then continue; fi
  dir="$DEST/$role"
  out="$dir/$file"
  url="$ORIGIN/$role/$(printf '%s' "$want" | cut -c1-12)/$file"

  if [ "$VERIFY_ONLY" -eq 0 ] && [ ! -f "$out" ]; then
    mkdir -p "$dir"
    echo "fetch $role/$file"
    curl --fail --location --silent --show-error --retry 3 --output "$out.part" "$url"
    mv "$out.part" "$out"
  fi

  if [ ! -f "$out" ]; then
    echo "missing $out (run without --verify-only)" >&2
    failed=1
    continue
  fi
  got="$(sha "$out")"
  if [ "$got" != "$want" ]; then
    echo "SHA-256 mismatch for $out: got $got want $want" >&2
    failed=1
  else
    echo "ok $role/$file"
  fi
done <<< "$MODELS"

if [ "$failed" -ne 0 ]; then
  echo "model fetch failed; nothing was removed" >&2
  exit 1
fi
