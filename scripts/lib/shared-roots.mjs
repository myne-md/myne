// The shared-tree roster, in ONE place (#273).
//
// The failure this prevents: each guard kept a private copy of "which trees are
// shared", and updating one copy did not update the others.
// `check-platform-seam.mjs` and `check-web-command-coverage.mjs` both learned
// about `editor/`, `dialect/` and `copy/` when those packages appeared;
// `check-i18n.mjs` never did — so `editor/src` holds 226 live `i18n.t()` keys
// that the catalog check has never seen, and `i18next.config.js` shares the
// blind spot, meaning a developer following the documented add-a-string
// procedure exactly still ships a raw dotted key.
//
// A guard that claims shared-tree scope imports this. A guard that deliberately
// scopes narrower says so in its own header and does not import it — the point
// is that the scope is a stated decision rather than a copy that fell behind.

import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname + "../";

/**
 * Every tree whose source is compiled into more than one client.
 *
 * All of them are now in-repo, so every root here is present in every checkout
 * and in every CI run — see {@link presentSharedRoots}, which used to be the
 * load-bearing part of this module and is now a formality.
 */
export const SHARED_ROOTS = Object.freeze([
  "src",
  "editor/src",
  "dialect/src",
  "copy/src",
  "ornaments/src",
  // `preview/src` is deliberately ABSENT. It is a captured ARTEFACT (the app's
  // own DOM and stylesheet, plus one plain-ESM helper), not source compiled into
  // a client — so the i18n scan has nothing to find there and the token-adoption
  // ratchet would count the app's own literals a second time. `check-platform-seam`
  // guards it through its own list, because "no Tauri import" IS meaningful for a
  // package the website consumes. Stated here so the omission reads as a decision.
  "web/src",
  "mobile/src",
]);

/**
 * Every Rust tree a guard scanning "the clients" means.
 *
 * `SHARED_ROOTS` above is the TS/JS roster and says nothing about Rust, so the
 * Rust guards each kept a private list, which is the same failure one language
 * over. It is a live one rather than a hypothetical: `check-crypto-registries.mjs`
 * listed `src-tauri/src`, `cli/src`, `web/wasm/src` and `e2e/fixture-gen/src`
 * and never learned about `mobile/src-tauri/src` after the mobile client moved
 * in-repo on 2026-08-13, so the guard that owns the HKDF-expand ownership rule
 * and the §10.3 magic registry had not seen a whole client for two days. Adding
 * it costs nothing today (46 more files, zero new violations), which is exactly
 * when a scope is free to widen.
 *
 * `protocol/src` and `core/src` are deliberately absent: they are the SHARED
 * crates, not clients, and a guard that wants them says so by naming them
 * alongside this list rather than by finding them in it.
 */
export const RUST_CLIENT_TREES = Object.freeze([
  "src-tauri/src",
  "mobile/src-tauri/src",
  "web/wasm/src",
  "cli/src",
  "tor-sidecar/src",
]);

/**
 * The roots that exist in THIS checkout.
 *
 * This used to matter: `myne-mobile` was a companion repo, gitignored here and
 * absent from every CI run, so a guard that walked the roster blindly meant one
 * thing locally and another on the runner. Every root is in-repo now, so
 * `missing` is expected to be empty and a non-empty one means a broken checkout
 * rather than a normal one. Kept as the single place that would notice.
 */
export function presentSharedRoots(rootDir = ROOT) {
  const present = [];
  const missing = [];
  for (const rel of SHARED_ROOTS) {
    if (existsSync(join(rootDir, rel))) present.push(rel);
    else missing.push(rel);
  }
  return { present, missing };
}
