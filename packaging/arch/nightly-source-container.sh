#!/usr/bin/env bash
# Weekly/manual Arch source build. Runs as root inside archlinux:base-devel:
# installs the toolchain and build deps, then hands the build to a non-root
# builder because makepkg refuses root. The repository is mounted read-only at
# /src; the generated package is written to /out.
set -euo pipefail
VERSION="${1:?usage: nightly-source-container.sh <version> <commit>}"
COMMIT="${2:?missing commit}"

pacman -Sy --noconfirm
pacman -S --needed --noconfirm \
  base-devel git nodejs npm rust webkit2gtk-4.1 gtk3 \
  libayatana-appindicator librsvg openssl

npm install -g pnpm@11.8.0
useradd -m builder
mkdir -p /work /out

PKGVER="${VERSION}.r${COMMIT:0:8}"
sed \
  -e 's/^pkgname=.*/pkgname=myne-nightly/' \
  -e "s/^pkgver=.*/pkgver=${PKGVER}/" \
  -e "s|^source=.*|source=(\"myne-nightly::git+https://github.com/myne-md/myne.git#commit=${COMMIT}\")|" \
  /src/packaging/arch/PKGBUILD > /work/PKGBUILD

chown -R builder:builder /work /out
su builder -c 'cd /work && makepkg --nodeps --noconfirm'
cp /work/*.pkg.tar.zst /out/
ls -lh /out/*.pkg.tar.zst
