#!/usr/bin/env bash
# Build an Arch Linux package from a nightly Debian bundle.
#
# This is the nightly counterpart of packaging/arch/myne-bin/PKGBUILD: it
# repackages the exact .deb the Linux job built, so the Arch package carries the
# same payload as the other Linux artefacts. It does not rebuild the app.
#
# Runs INSIDE the archlinux:base-devel container, as a non-root user (makepkg
# refuses root). Usage:
#   nightly-repackage.sh <path-to-deb> <version> <commit>
set -euo pipefail

DEB="${1:?usage: nightly-repackage.sh <path-to-deb> <version> <commit>}"
VERSION="${2:?missing version}"
COMMIT="${3:?missing commit}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${MYNE_ARCH_OUT:-$ROOT/target/release/bundle/arch}"
LICENSE="${MYNE_ARCH_LICENSE:-$ROOT/LICENSE}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$DEB" ] || { echo "nightly-repackage: no deb at $DEB" >&2; exit 1; }
DEB_NAME="$(basename "$DEB")"
# Arch versions may not contain a hyphen. The short commit keeps two nightly
# builds from the same app version distinguishable without claiming a release.
PKGVER="${VERSION}.r${COMMIT:0:8}"
SHA="$(sha256sum "$DEB" | cut -d' ' -f1)"

mkdir -p "$OUT"
cp "$DEB" "$WORK/$DEB_NAME"

cat > "$WORK/PKGBUILD" <<EOF
pkgname=myne-nightly-bin
pkgver=$PKGVER
pkgrel=1
pkgdesc="Myne nightly (unsigned Arch repackage of the Linux deb)"
arch=('x86_64')
url="https://myne.md"
license=('AGPL-3.0-only')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator' 'librsvg' 'openssl')
provides=('myne')
conflicts=('myne' 'myne-bin')
options=('!strip')
source=('$DEB_NAME')
sha256sums=('$SHA')
noextract=('$DEB_NAME')

package() {
  # The deb payload is already the FHS tree this package wants.
  bsdtar -xOf "\$srcdir/$DEB_NAME" 'data.tar.*' | bsdtar -xf - -C "\$pkgdir"
  install -Dm644 "$LICENSE" "\$pkgdir/usr/share/licenses/\$pkgname/LICENSE"
  # bsdtar runs as the build user; without this, the deb's files land as that
  # user in the package. fakeroot records the chown as root.
  chown -R 0:0 "\$pkgdir"
}
EOF

cd "$WORK"
makepkg --nodeps --noconfirm
cp ./*.pkg.tar.zst "$OUT/"
ls -lh "$OUT"/*.pkg.tar.zst
