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

The bundle is reproducible **in the reference build environment**: the same
commit produces the same hash for anyone who builds it there, because
`version.json` carries the COMMIT's timestamp rather than a wall clock and the
wasm build remaps every machine-specific path (`scripts/build-wasm.sh`).

The reference build environment is **`linux/amd64`, built from
`web/container/Dockerfile`**. `--platform` is load-bearing here, not decoration:
the same commit built on an arm64 host produces a different hash from every row
below, for the reason measured in "Why the build host is part of the hash", and
plain `docker build` silently builds for whatever the host happens to be. Which
is exactly the trap this section used to set: the procedure failed for the
honest arm64 verifier and told them nothing about why.

Emulation is not a caveat, it is the point: an arm64 machine reaches the
reference platform through it and gets the byte-identical result.

```
git checkout <commit>
docker buildx build --platform linux/amd64 -f web/container/Dockerfile \
  --build-arg MYNE_BUILD_COMMIT=$(git rev-parse HEAD) \
  --build-arg MYNE_BUILD_TIMESTAMP=$(git show -s --format=%cI HEAD) \
  -t myne-web:verify --load .
docker run --rm --platform linux/amd64 \
  -e MYNE_SYNC_ORIGIN=https://sync.myne.md -p 8099:8080 myne-web:verify &
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
| 2026-08-14 | `fd8d23c1041351c196bdac274f956fe2fcaa8107` | `sha256:1d8ccfeb4e673113ebc3f92da257c31a2fd62e70263af75387337f40832cad4d` |
| 2026-08-26 | `5ffe8d388ddeb91e7b08859d122f5e29515a16fc` | `sha256:4870edbb39370d94faaf536cca1e87f708a4ee3d33bb67d156a47db1d4ccacb8` |
| 2026-09-02 | `0b115cf0d68312126527704c1fd395d9696008da` | `sha256:9f695eb8b43bb1d02e949a0503a8920a5e7505ca1d749a743142d11e7f85f0e6` |

### v0.7.0 has one row, and it rests on one machine rather than two

`0b115cf0` was built once, on macOS / arm64 emulated to `linux/amd64` through
`web/container/Dockerfile`, with both `--build-arg` values. No second host
confirmed it. That is weaker evidence than the v0.6.0 row below, which two
machines agreed on, and the difference is stated here rather than left for a
reader to infer from a table where both rows look alike.

One thing the single build did establish, because it happened by accident and
was caught before it reached this table. The same commit built with no
`--platform` on this Apple Silicon host produced a **linux/arm64** image whose
`version.json` reported
`sha256:f55888d154cf3684360d4dc40d78872c2c8764267a1925d8874f71085c8dc2fe`. The
amd64 build of the identical source reported the row above. Two hashes, one
commit, one machine, one flag: that is the "why the build host is part of the
hash" section below, measured again rather than quoted.

### v0.6.0 has one row, and that is the point

v0.5.0 needed three rows because three build hosts produced three hashes.
`5ffe8d38` needed one, because two hosts produced the same one:

| build host | bundle_hash |
|---|---|
| macOS / arm64, emulated to `linux/amd64` via `web/container/Dockerfile` | `sha256:4870edbb…` |
| Linux / amd64, native, `web/container/Dockerfile` | `sha256:4870edbb…` |

Both ran the procedure this file documents, with `--platform linux/amd64` and
both `--build-arg` values. This is
[#228](https://github.com/myne-md/myne/issues/228) measured rather than
asserted: the row above rests on two machines agreeing, not on one machine's
word.

One difference between the two builds is worth naming because it is evidence
rather than noise. An earlier build of the same commit carried a wall-clock
`built_at`; these two carry the commit's own timestamp. The `bundle_hash` is
identical across all three, which is only consistent with `version.json` being
excluded from the hash it reports, and that exclusion is what makes the hash
reproducible at all.

### Why v0.5.0 has three rows for one commit

All three were built from `fd8d23c1`. They differ because the **build host**
differs, which [#228](https://github.com/myne-md/myne/issues/228) already
tracks — and v0.5.0 is the first release to measure how far it goes:

| build host | bundle_hash |
|---|---|
| macOS / arm64, `pnpm web:build` | `sha256:c5f4cd6e…` |
| Linux / arm64, `web/container/Dockerfile` | `sha256:d175d1fd…` |
| Linux / amd64, `web/container/Dockerfile` | `sha256:1d8ccfeb…` |

The wasm artefact is not byte-identical across them, and because every JS chunk
importing it is content-hashed, one differing artefact renames roughly a third
of the bundle. Same tree, same commit, same Dockerfile — three hashes.

A **second** build-environment input reached the bundle at the time these rows
were measured and no longer does: `web/vite.config.ts` compiled the short commit
in as `__BUILD_COMMIT__`, which the container build answered `"unknown"` (it has
no `.git` and no `git`) while a local `pnpm web:build` answered with the real
SHA. That define is pinned as of `decisions.md` 2026-08-15 (entry 0505), so the
bundle now takes no COMMIT from its build environment. It still takes the build
HOST, which is the whole subject of this section: the wasm artefact differs per
architecture, and entry 0498 settled that as a measured scope limit rather than
as pending work.

**The `linux/amd64` row is the one that ships.** `app.myne.md` runs on an
x86_64 host and the image is built on that host's own daemon, so amd64 is what
`/version.json` will report. The other two are left in place rather than edited
away: rows here are appended, never rewritten, and a row that turned out not to
be the shipped one is still a true record of what was published in advance.

This is why the section above names a reference build environment rather than
"any machine". The narrower sentence is the one that is true, and it is enough:
**the same commit produces the same hash for every build of the reference
platform, from any host.**

Verified rather than asserted. The `linux/amd64` row above,
`sha256:1d8ccfeb…`, was rebuilt from `fd8d23c1` on a macOS **arm64** laptop, in
an emulated `linux/amd64` container, and came out byte-identical (2026-08-15,
[#228](https://github.com/myne-md/myne/issues/228)). The verifier and the
publisher shared neither operating system nor CPU architecture, which is the
case that matters: a hash only one machine in the world can produce is a number
the publisher asserts about itself.

**The residual, stated rather than left for a verifier to hit.** The claim above
is scoped across hosts and it is not yet scoped across time, because the
reference environment is not itself pinned. `web/container/Dockerfile` names
`rust:1.96-bookworm`, `node:25-slim` and `caddy:2.8-alpine`, all floating tags,
and its wasm stage installs `nodejs` from live Debian. Its own comment says the
digest pinning belongs to the release pipeline (task 16), and that pipeline does
not exist yet. So a base image can move under a row that was written before it
moved, and a verifier rebuilding an older row later can get a mismatch that means
"the environment drifted", not "the bundle was substituted", which is the same
false alarm this section closes for the architecture axis. Read a row as
reproducible against the reference environment **as it stood when the row was
written**. Pinning the three base images by digest, and recording the digests per
row, is what closes it, and it is tracked rather than done
([#228](https://github.com/myne-md/myne/issues/228)).

## Why the build host is part of the hash

The divergence is in the **wasm artefact**, and everything else follows from it.
`web/wasm/pkg/myne_web_wasm_bg.wasm` is an input to the JS bundle, every chunk
is content-hashed, and the chunk that carries the wasm's URL renames when the
wasm renames, which renames its importers, and theirs, up to `index.html`. One
differing artefact renamed 16 JS chunks in the measured case. Reading that
symptom as "the bundler emits architecture-dependent output" is the wrong turn
this section exists to prevent.

Measured on the two published `0.2.0` image variants (504 assets each): 487
byte-identical, 17 differing per side (16 `.js` and the one `.wasm`), and after
normalising the hashed asset references inside the differing chunks, all of them
collapse to the same text, except the wasm-bindgen glue, where the divergence
is a Rust symbol name.

The chain, from the bottom:

1. Cargo derives `-C metadata` for every crate by hashing, among other things,
   the output of `rustc -vV`, which carries a `host:` line naming the build
   machine's target triple.
2. rustc folds `-C metadata` into each crate's `StableCrateId`, which is what a
   symbol's hash suffix encodes. Two container builds of the same commit, same
   pinned rustc, same `wasm32-unknown-unknown` target, gave `wasm-bindgen` the
   disambiguator `9394cf8502cefdb6` on arm64 and `5abedafe4fd079f5` on amd64.
3. Symbol names are inputs to codegen-unit partitioning and to static-data
   ordering, so the effect does not stay in the name section. Comparing the two
   builds section by section: `code` differs (by 3011 bytes), and so do `data`,
   `export`, `elem`, `function` and `custom:name`; `type`, `import`, `memory`,
   `global`, `producers` and `target_features` are identical.

**`-C symbol-mangling-version=v0` does not fix it, and was measured rather than
assumed.** v0 removes the legacy `h<16 hex>` suffix, then encodes the same
`StableCrateId` as a crate disambiguator instead
(`_Result_____wasm_bindgen_9394cf8502cefdb6___JsError___true_`), so the arm64
and amd64 artefacts still differ, in the same six sections. No stable-toolchain
flag neutralises the `rustc -vV` input to cargo's metadata hash, which is why
the fix is to name the build environment instead of chasing host independence.

**The bundler was ruled out, not assumed innocent.** Vite 8 bundles through
Rolldown, whose binding is a per-architecture native binary, which makes it the
obvious suspect. Building the same commit four ways on one machine (native
`darwin-arm64` binding, the architecture-independent `wasm32-wasi` binding
(forced with `NAPI_RS_FORCE_WASI=error`, which fails closed rather than falling
back), and with `RAYON_NUM_THREADS` at 1 and 2) produced one hash,
`sha256:a585e43e…`, four times.
