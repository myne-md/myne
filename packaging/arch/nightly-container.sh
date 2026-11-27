#!/usr/bin/env bash
# Container entrypoint for the nightly Arch repackage step. Runs as root,
# creates a non-root builder (makepkg refuses root), then hands off to
# nightly-repackage.sh. The repository is mounted read-only at /src and the
# output directory is /out.
set -euo pipefail
DEB="${1:?usage: nightly-container.sh <deb> <version> <commit>}"
VERSION="${2:?missing version}"
COMMIT="${3:?missing commit}"

useradd -m builder
chown builder /out
su builder -c "MYNE_ARCH_OUT=/out MYNE_ARCH_LICENSE=/src/LICENSE /src/packaging/arch/nightly-repackage.sh '$DEB' '$VERSION' '$COMMIT'"
