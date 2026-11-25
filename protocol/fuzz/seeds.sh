#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Seed-corpus generator for the protocol blob-decoder fuzz targets.
#
# Strategy — magic-prefixed seeds, NO encoder coupling.
#   The single cheapest-but-most-blocking coverage gate in every decoder is
#   the 4-byte magic check: a random mutation almost never reproduces it, so
#   without a seed the fuzzer wastes its whole budget bouncing off byte 0..4.
#   Each seed here = correct magic || zero-filled header-length || a little
#   slack, which lands the fuzzer PAST the magic gate and inside the real
#   surface: length-field parsing and allocation sizing.
#
#   We deliberately do NOT mint valid-AEAD seeds. In the zero-knowledge model
#   the attacker controls bytes, not keys, so a tag will never verify on
#   attacker input — the security-relevant code path is exactly the
#   pre-decrypt parse these seeds target. (Richer valid-blob seeds can be
#   added later from the encoders if post-decrypt parsing ever needs coverage.)
#
# Idempotent: safe to re-run. Run from anywhere; paths are script-relative.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
corpus="$here/corpus"

# write_seed <target> <name> <magic-ascii> <total-len>
#   Emits <magic> followed by zero bytes up to <total-len>.
write_seed() {
  local target="$1" name="$2" magic="$3" total="$4"
  local dir="$corpus/$target"
  mkdir -p "$dir"
  local zeros=$(( total - ${#magic} ))
  {
    printf '%s' "$magic"
    if [ "$zeros" -gt 0 ]; then head -c "$zeros" /dev/zero; fi
  } > "$dir/$name"
}

# Per target: a header-length-sized magic seed (past the magic + length gate)
# and a magic-only seed (truncated; exercises the short-slice reject path).
# vault.meta is exact-length (345); the others use a 34-byte header, MY01 uses
# a 112-byte prefix. Slack added so length checks see a non-empty body.
write_seed note          valid     MY01 200
write_seed note          magiconly MY01 4
write_seed vault_meta    valid     MYV1 345
write_seed vault_meta    magiconly MYV1 4
write_seed search        valid     MYS1 80
write_seed search        magiconly MYS1 4
write_seed vault_indices valid     MYI1 80
write_seed vault_indices magiconly MYI1 4
write_seed prefs         valid     MYP1 80
write_seed prefs         magiconly MYP1 4
write_seed dictionary    valid     MYD1 80
write_seed dictionary    magiconly MYD1 4
write_seed workspace     valid     MYW1 80
write_seed workspace     magiconly MYW1 4
write_seed catalog       valid     MYC1 80
write_seed catalog       magiconly MYC1 4
write_seed attachment    valid     MYA1 200
write_seed attachment    magiconly MYA1 4

echo "Seeds written under $corpus/"
find "$corpus" -type f | sort
