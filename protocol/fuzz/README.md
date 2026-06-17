<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# `protocol` blob-decoder fuzzing

libFuzzer harnesses for the nine binary blob decoders in the `protocol`
crate. Each target hammers ONE decoder with attacker-controlled bytes and
asserts the core security invariant of the parse layer:

> No input — however hostile — may panic, abort, or trigger an unbounded
> allocation. Every decode of untrusted bytes returns `Ok | Err`, never a
> crash.

## Why this layer

Myne is zero-knowledge. The threat model gives the attacker read/write access
to the user's **encrypted files** (stolen disk, cloud backup, future sync
server) but **not** the keys. When a vault opens, these decoders parse those
attacker-controlled bytes — checking magic, reading length fields, sizing
allocations — *before* the AEAD tag can ever verify. A panic or OOM there is a
denial-of-service reachable with a single crafted `.myn`/`vault.*` file. That
pre-decrypt parse is exactly what these targets exercise (the fixed dummy keys
never let a tag verify, which mirrors reality).

## Toolchain (one-time)

libFuzzer needs **nightly**; the product is pinned to stable `1.96.0`. This
crate is severed from the root workspace (empty `[workspace]` in `Cargo.toml`)
so nightly never touches the product build or CI.

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
```

## Seed the corpus (recommended)

```bash
bash protocol/fuzz/seeds.sh
```

Writes magic-prefixed seeds under `corpus/<target>/` so the fuzzer starts past
the 4-byte magic gate. See the script header for the rationale (and why we
don't mint valid-AEAD seeds).

## Run

```bash
cd protocol/fuzz
cargo +nightly fuzz list                                          # the 9 targets
cargo +nightly fuzz run note --sanitizer none -- -max_total_time=120
cargo +nightly fuzz run search --sanitizer none -- -runs=5000000
```

Targets: `note`, `vault_meta`, `search`, `vault_indices`, `prefs`,
`dictionary`, `attachment`, `catalog`, `workspace`.

Build-only smoke (no run):

```bash
cargo +nightly fuzz build --sanitizer none
```

### macOS / Apple Silicon: use `--sanitizer none`

On macOS aarch64 the **AddressSanitizer**-instrumented libFuzzer binary hangs
at startup (spins at high CPU, prints nothing — even `-help=1` never returns).
This is an ASan-on-Apple-Silicon toolchain issue, not a decoder bug. Pass
`--sanitizer none` and libFuzzer runs normally (verified: `note` → 20k runs,
clean). On Linux CI you may drop the flag and keep ASan.

Dropping ASan is sound for this crate specifically: `protocol` is
`#![forbid(unsafe_code)]`, so the memory-safety bugs ASan exists to catch
(use-after-free, out-of-bounds) are already precluded by the compiler. The
failure modes we DO care about are still caught without ASan:

| Failure | Caught by |
|---|---|
| panic (index OOB, `unwrap`, arithmetic overflow) | libFuzzer aborts on panic |
| unbounded allocation (OOM) | `-rss_limit_mb=2048` (default) |
| infinite loop / pathological slow path | `-timeout=10` (per-input) |

## When a crash is found → stable regression (the CI bridge)

CI stays on pinned stable and never runs nightly fuzzing. The durable net is a
regression test derived from each crash, which `cargo test -p protocol` (and
therefore Woodpecker CI) runs forever after:

1. **Minimize** the reproducer:
   ```bash
   cargo +nightly fuzz tmin <target> artifacts/<target>/crash-<hash>
   ```
2. **Port** the minimized bytes into the offending module's existing
   `#[cfg(test)] mod tests` block in `protocol/src/<module>.rs` as a
   `fn fuzz_regression_<short-hash>()` test. Assert the decoder returns `Err`
   (or whatever the fixed behaviour is) **without panicking** — e.g. feed the
   bytes to `decode_*` with the same dummy key constants used in the harness
   and `assert!(result.is_err())`.
3. **Fix** the product code, then confirm red → green:
   ```bash
   cargo test -p protocol fuzz_regression_<short-hash>
   ```

This keeps the discovery loop on nightly/local while the *guarantee* lives in
the stable test suite the whole team and CI already run.

## Scope

In scope: the nine binary blob decoders (`MY01 MYV1 MYS1 MYI1 MYP1 MYD1 MYA1
MYC1 MYW1`).

Out of scope (later phases): text/JSON parsers (`parse_account_number`,
`parse_saved_views_array`, `parse_kdf_params`, bip39 `normalize_user_phrase`,
`template::render`) and the std/fs-bound `MYB1` backup-container parser in
`src-tauri`.
