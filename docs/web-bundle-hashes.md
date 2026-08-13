# Published web-bundle hashes

Every bundle served from `app.myne.md` appears here **before** it is deployed.
`scripts/check-bundle-record.mjs` refuses a deploy whose hash is absent, so this
is a precondition rather than a log kept afterwards — a substituted bundle
cannot reach the origin and then be written up.

## How to read it

Each row is one released bundle:

| field | meaning |
|---|---|
| `date` | UTC date the entry was added |
| `commit` | the commit the bundle was built from |
| `bundle_hash` | SHA-256 over every emitted asset, sorted, path-and-content (`scripts/emit-web-version.mjs`) |

The live origin publishes the same value at
<https://app.myne.md/version.json>, served `no-store`. Comparing the two is one
command:

```
curl -s https://app.myne.md/version.json | grep bundle_hash
```

If that hash is not in the table below, the origin is serving something that was
never published. That is the whole point of the file.

## Reproducing an entry yourself

The bundle is reproducible: the same commit produces the same hash, on any
machine, because `version.json` carries the COMMIT's timestamp rather than a
wall clock and the wasm build remaps every machine-specific path
(`scripts/build-wasm.sh`).

```
git checkout <commit>
docker build -f web/container/Dockerfile \
  --build-arg MYNE_BUILD_COMMIT=$(git rev-parse HEAD) \
  --build-arg MYNE_BUILD_TIMESTAMP=$(git show -s --format=%cI HEAD) \
  -t myne-web:verify .
docker run --rm -e MYNE_SYNC_ORIGIN=https://sync.myne.md -p 8099:8080 myne-web:verify &
curl -s localhost:8099/version.json | grep bundle_hash
```

A hash nobody can independently reproduce proves nothing, which is why this
procedure is part of the record and not a footnote to it.

**`git checkout <commit>` may need a fetch first.** The `commit` column holds the
commit CI built, which is whatever the deploying branch pointed at — and a branch
that is squash-merged leaves that commit off `develop` entirely. Both rows below
are such commits: neither is an ancestor of `develop`, and a fresh clone will not
have either until the branch carrying them is fetched.

```
git fetch origin feat/mynd-574-phase3-web-client
```

They are **not** re-pointed at the squash commit afterwards. The append-only gate
below treats an edited `commit` cell exactly like an edited hash, and quietly
moving a published row to a different commit is the rewrite this file exists to
prevent — even when the new commit is the "same" code.

## What "append-only" means here, and what it does not

Rows are **added, never edited or removed**, and
`scripts/check-bundle-record.mjs --append-only` enforces that against git
history: it re-reads the table as it existed at the merge base and fails if any
existing row changed. A rewrite therefore cannot arrive quietly — it has to
arrive as a force-push, which is visible.

**It does not make rewriting impossible.** Anyone who controls this repository
and its history can rewrite it; what they cannot do is rewrite it without the
rewrite being an event. A cryptographic transparency log (Sigstore's Rekor is
the obvious candidate) would raise that from "visible" to "verifiable by a third
party", and is the natural next step — it is not here yet because it adds a
dependency, and adding a dependency is a security decision in this repo
(`CLAUDE.md`).

State the property you actually have. This one is: **a deploy cannot happen
unless its hash was published first, and a published hash cannot change without
leaving a force-push behind.**

## The record

| date | commit | bundle_hash |
|---|---|---|
| 2026-07-28 | `233e7222a2f1011a7755fbb8035053d409d36084` | `sha256:e543369a9fb90c80f5169335713ea1ce6cc50587b08fc93c039d8e873ba40f61` |
| 2026-07-29 | `6279d39b5aa157e3da5bd3292f652fbe581952cf` | `sha256:bad879d4a5f3eb67a5d43243c5bdcb71eabfd9c53d423c99c735c73cc06cde25` |
| 2026-08-02 | `78e13de0a1456d209d2c7dbfe35e674d88db160f` | `sha256:5a2e304c1449bdb86c83dfd5a0405d7d26c6f54f3be80eed7922f9789ddcc630` |
| 2026-08-03 | `a8b952f38b9ce935685bd99caa9733b0eede1a0d` | `sha256:9bb290392657dcad02fc252f003a2fcad9d46334c0ca95b908a0953659d223f5` |
| 2026-08-04 | `9fb28ac2173420fed6ffb8de6ff37fad3317851c` | `sha256:e6c80b92a461fd8fd9e5bbe3412d9f0610d33ff58c04fa0796d3727569917b14` |
| 2026-08-13 | `fd8d23c1041351c196bdac274f956fe2fcaa8107` | `sha256:c5f4cd6e8399e96c5ddd8894b078cd595e67eaab4e106f6ef553d7908611ec98` |
| 2026-08-14 | `fd8d23c1041351c196bdac274f956fe2fcaa8107` | `sha256:d175d1fde8e1234c17ebfc4915e199d05e0d2728ade201d36f8c3ff9052dee25` |

### Why v0.5.0 has two rows for one commit

Both were built from `fd8d23c1`; they differ because the **build host** differs,
which [#228](https://github.com/myne-md/myne/issues/228) already tracks. The
first was produced on macOS/arm64 by `pnpm web:build`, the second inside
`web/container/Dockerfile` on Linux. The wasm artefact is not byte-identical
across the two (`…8k_t5cx8` vs `…D-hQnqxT`), and because every JS chunk that
imports it is content-hashed, one differing artefact renames a third of the
bundle.

**The container row is the one that ships.** The origin serves the container
image, so that is the hash a reader should find at `/version.json`. The
macOS row is left in place rather than edited away — rows here are appended,
never rewritten, and a row that turned out not to be the shipped one is still
a true record of what was published in advance.

This is also why the "the same commit produces the same hash, on any machine"
sentence above is **currently too strong**: it holds for a fixed build host, and
#228 is the work of making it hold across hosts. Read it as scoped until that
lands.
