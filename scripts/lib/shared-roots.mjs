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
 * `myne-mobile/src` is here because it IS shared-consuming, and absent from a
 * fresh clone — see {@link presentSharedRoots}, which is what a guard should
 * actually walk.
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
  "myne-mobile/src",
]);

/**
 * The roots that exist in THIS checkout.
 *
 * `myne-mobile` is a companion repo, ignored here and absent from every CI run.
 * A guard that silently drops it reports a smaller number with no explanation;
 * one that fails on it is unrunnable in CI. So the roster reports which roots
 * it skipped, and the caller decides whether to say so.
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
