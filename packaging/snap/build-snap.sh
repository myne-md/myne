#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# build-snap.sh — pack the released .deb payload into a snap, by hand.
#
# Why hand-packed: `snapcraft` only runs under snapd, and neither build host
# (this Mac's colima VM, the VPS) runs snapd, so the alternative was installing
# a daemon on the owner's server to produce one file. A snap IS a squashfs with
# `meta/snap.yaml` inside, so the layout is written out below instead.
#
# Confinement is `classic`, deliberately: the app opens vaults the user points it
# at, anywhere on disk, and ships its own sidecars. A strictly-confined snap
# would need a plug per path and a portal rewrite, which is a porting project,
# not a packaging one. Classic snaps are what an app like this ships as when the
# publisher is not in the store.
#
# The deb's `usr/` tree is preserved verbatim under $SNAP, because that is what
# Tauri's resource lookup walks: from `<exe dir>/../lib/<product>`. Flattening it
# to snap/bin would strand the 640 MiB model payload.
set -euo pipefail

VERSION="${1:?usage: build-snap.sh <version> [arch] }"
ARCH="${2:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) DEBARCH=amd64; SNAPARCH=amd64 ;;
  aarch64|arm64) DEBARCH=arm64; SNAPARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEB="$ROOT/dist-release/Myne_${VERSION}_${DEBARCH}.deb"
OUT="$ROOT/dist-release/myne_${VERSION}_${SNAPARCH}.snap"
[ -f "$DEB" ] || { echo "missing $DEB" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root"

ar p "$DEB" "$(ar t "$DEB" | grep '^data.tar' | head -1)" > "$WORK/data.tar"
tar -xf "$WORK/data.tar" -C "$WORK/root"

mkdir -p "$WORK/root/meta"
cp "$ROOT/packaging/snap/snap.yaml" "$WORK/root/meta/snap.yaml"
sed -i "s/\${VERSION}/${VERSION}/" "$WORK/root/meta/snap.yaml"

# 1 MiB blocks, xz for size; the payload is dominated by the model trees, which
# do not compress well, so this is closer to a copy than to a compression step.
mksquashfs "$WORK/root" "$OUT" -noappend -comp xz -b 1M -no-progress >/dev/null
ls -l "$OUT"
