#!/usr/bin/env node
// Every screen has a web verdict, and the excluded ones are really gone
// (phase3-web-client task 70).
//
// # Why a roster and not a table in a document
//
// The failure this prevents is not a wrong verdict — it is a screen that never
// got one. A new file under `src/screens/` inherits the web build by default:
// it compiles, it ships, and whether it works in a browser is discovered by a
// user. A prose table cannot notice that; this can, because it reads the
// directory and requires every file in it to be named below.
//
// # The four verdicts
//
//   ported     — runs on web as written; nothing about it is platform-specific
//   adapted    — runs on web, with a documented difference (a capability gate,
//                a substituted constant). The difference is the note.
//   excluded   — NOT in the web bundle: `web/vite.config.ts` substitutes the
//                module. `marker` is a string only the real module contains, and
//                this script fails if it appears in `web/dist`.
//   web-only   — lives in the shared tree but is reachable only on web.
//
// `excluded` is the only verdict with teeth beyond bookkeeping, and it needs
// them: "the route is hidden" is a claim about routing, "the string is not in
// the artefact" is a fact about what we serve. Same reasoning, and same
// mechanism, as `scripts/check-web-no-phrase.mjs`.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import {
  partitionAssets,
  unknownExtensionMessage,
} from "./lib/scanned-assets.mjs";
import { join, relative } from "node:path";

const SCREENS = join("src", "screens");
const DIST = join("web", "dist");

/**
 * The verdict for every file under `src/screens/`.
 *
 * Keys are paths relative to `src/screens/`. A file with no entry fails; an
 * entry with no file fails. Both directions matter — the second is what stops
 * this roster from quietly describing a tree that no longer exists.
 */
const VERDICTS = {
  // ── excluded: substituted out of the web bundle ─────────────────────────
  "CreateVault.tsx": {
    verdict: "adapted",
    note:
      "SHIPS since decisions.md 2026-08-15, which reverses the 2026-07-26 ban on generating and " +
      "displaying the phrase in served code. Adapted rather than ported because the ORDER differs: " +
      "where sync is required the flow registers the account with the server between `commit` and " +
      "the phrase screen (`ProvisioningStep`), so the 24 words are never shown for an account that " +
      "does not exist. Desktop keeps display-then-commit; it has no server leg to fail.",
  },
  "VaultRecover.tsx": {
    verdict: "ported",
    note:
      "SHIPS since decisions.md 2026-08-15. The phrase-entry grid, the single non-distinguishing " +
      "failure, the full cell wipe, the no-lockout rule and the mandatory chained password reset " +
      "are the shared implementation, unchanged: what the core gained was the IO seam on its read " +
      "and write paths, threaded as ONE implementation rather than a wasm twin.",
  },
    "Welcome.tsx": {
    verdict: "excluded",
    marker: "welcome.create-cta",
    note: "Unreachable on web (an empty client routes to account-entry, task 85) and every door it offers — create, join, fresh-install restore — is an absent capability.",
  },
  "VaultPicker.tsx": {
    verdict: "excluded",
    marker: "picker.vault-row",
    note: "An origin holds exactly one container (constant vault id, task 85), so the >=2-vault branch that produces the picker stage cannot be reached.",
  },
  "RestoreBackup.tsx": {
    verdict: "excluded",
    marker: "restore.pick-file",
    note: "Backup is a decided absence on web (decisions.md 2026-07-26); every backend call this screen makes is answered Unsupported.",
  },

  // ── adapted: ships, with a stated difference ────────────────────────────
  "titlebar.ts": {
    verdict: "adapted",
    note: "Substituted so HAS_OVERLAY_WINDOW_CONTROLS is false: a Mac BROWSER has no traffic lights, and the shared userAgent test reserved 86px for them (task 70).",
  },
  "Editor.tsx": {
    verdict: "adapted",
    note: "Ships whole; affordances the platform cannot honour are omitted through the capability descriptor rather than by a fork (task 27).",
  },
  "Unlock.tsx": {
    verdict: "adapted",
    note: "Ships whole; the fail-closed CTA is the platform exit seam (task 95) and the restore door is capability-gated (task 70).",
  },

  // ── web-only: in the shared tree, reachable only here ───────────────────
  "AccountNumberEntry.tsx": {
    verdict: "web-only",
    note: "The first-run identity step. Desktop never routes to it — its empty state is 'make a vault' (tasks 30 + 85).",
  },
  "AccountBootstrap.tsx": {
    verdict: "web-only",
    note: "The first-run flow AROUND the identity step: account number → password → sync_join_account. Desktop never routes to it (same `account-entry` stage), and its two omissions are the point — no server-URL field (task 50 fixes the origin) and no TOFU fingerprint step (a page cannot see a leaf certificate). Task 85.",
  },
  "StorageLost.tsx": {
    verdict: "ported",
    note: "The local store vanishing underneath a live session (task 22). Renders on BOTH clients — a desktop directory can be unmounted or deleted too — but its CTA differs by `localOnlyVault`: server-held ⇒ erase and re-download, local-only ⇒ lock and re-probe, because handing a desktop user an erase button on a storage fault would destroy the only copy.",
  },
  "DeviceRevoked.tsx": {
    verdict: "web-only",
    note: "Revocation treated as TERMINAL — lock, erase this browser's copy, explain (task 94). Reachable only where `localOnlyVault` is absent: on desktop the same server signal keeps parking at re-enrol, because erasing a user's own machine on a server signal would be a new and unasked-for destructive power.",
  },
  "WebNoAccount.tsx": {
    verdict: "web-only",
    note: "The sync-required client's dead-end surface when no account is configured.",
  },

  // ── ported: nothing platform-specific ──────────────────────────────────
  "centerView.tsx": { verdict: "ported", note: "Pure view-state union." },
  "editorLayout.tsx": { verdict: "ported", note: "Pure layout state + persistence through the shared prefs." },
  "layoutClamp.ts": { verdict: "ported", note: "Pure arithmetic." },
  "responsiveCollapse.ts": { verdict: "ported", note: "Pure width thresholds; a browser resizes the same way." },

  // ── the creation and recovery step trees ───────────────────────────────
  //
  // Each is reached ONLY through its parent screen. Both groups became `ported`
  // on 2026-08-15, when creation and recovery shipped on this client. They are listed individually rather than by prefix because the
  // roster's job is to notice a NEW file, and a prefix rule would swallow one —
  // which is exactly what happened to `ProvisioningStep.tsx`, added by that same
  // change and caught by this gate rather than by a reviewer.
  "vault-creation/AccountStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/BriefingStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/ConfirmStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/EncryptingStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/index.ts": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/PasswordStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/PhraseStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/ReadyStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/reducer.ts": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/SessionLostStep.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/step-shell.tsx": { verdict: "ported", via: "CreateVault.tsx" },
  "vault-creation/ReadyLocalArtefacts.tsx": {
    verdict: "excluded",
    marker: "create.ready-backup-now",
    note:
      "The creation flow's two local-disk affordances: a `.myne-backup` write through a native " +
      "save dialog, and revealing the vault directory in an OS file manager. Both need a disk this " +
      "client does not have (`backup` and `nativeSaveAs` absent; OPFS has no path to reveal). " +
      "Extracted into its own module on 2026-08-15 for exactly this substitution — creation now " +
      "ships here, so its transitive imports are served code, and `src/lib/vault-backup.ts` is " +
      "itself an `excluded` surface.",
  },
  "vault-creation/ProvisioningStep.tsx": {
    verdict: "web-only",
    note:
      "Only ever rendered where sync is REQUIRED, i.e. on this client. It is the step that " +
      "registers the account with the server before the phrase is displayed; desktop creation has " +
      "no server leg and never enters it (decisions.md 2026-08-15).",
  },
  "vault-recover/DecryptingStep.tsx": { verdict: "ported", via: "VaultRecover.tsx" },
  "vault-recover/index.ts": { verdict: "ported", via: "VaultRecover.tsx" },
  "vault-recover/PasswordResetStep.tsx": { verdict: "ported", via: "VaultRecover.tsx" },
  "vault-recover/PhraseEntryStep.tsx": { verdict: "ported", via: "VaultRecover.tsx" },
  "vault-recover/RecoverySelectStep.tsx": { verdict: "ported", via: "VaultRecover.tsx" },
  "vault-recover/reducer.ts": { verdict: "ported", via: "VaultRecover.tsx" },
  "vault-recover/step-shell.tsx": { verdict: "ported", via: "VaultRecover.tsx" },
};

/** Every file under `src/screens/`, as roster keys. */
export function screenFiles(root = SCREENS) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

/** `{ missing, stale }` — files with no verdict, and verdicts with no file. */
export function rosterGaps(files, verdicts = VERDICTS) {
  const named = new Set(Object.keys(verdicts));
  return {
    missing: files.filter((f) => !named.has(f)),
    stale: [...named].filter((n) => !files.includes(n)),
  };
}

/** Concatenated text of every served asset, fail-closed on an unclassified
 *  extension (#273).
 *
 *  This read `.js`/`.css`/`.html`, so an absence MARKER present only in the
 *  `.mjs` chunk or the `.wasm` would have read as absent — and "the marker is
 *  gone" is exactly what this asserts. */
function bundleText(dist = DIST) {
  const { scan, unknown } = partitionAssets(dist);
  if (unknown.length > 0) {
    console.error(unknownExtensionMessage(unknown));
    process.exit(1);
  }
  // `latin1`: a `.wasm` is not valid UTF-8 and lossy decoding would mangle the
  // ASCII runs a marker is made of.
  return scan.map((f) => readFileSync(f, "latin1")).join("");
}

/**
 * User-facing text rendered as a literal instead of through `t()`
 * (phase3-web-client task 58).
 *
 * # Why this is checked on the web-only screens specifically
 *
 * `check-i18n.mjs` verifies that every `t("key")` HAS a catalog entry. It cannot
 * see the opposite mistake — a sentence typed straight into the JSX, which needs
 * no key, breaks no test, and renders in English in all 24 locales forever.
 *
 * On a ported screen a missed string is a translation bug someone eventually
 * files. On the **web-only** screens it is worse than that, because they are the
 * ones nobody has ever seen in another language: they were written for this
 * feature, they carry the refusal and data-loss copy, and there is no desktop
 * user to notice the gap. Task 58's obligation is "the English source lands with
 * the screen"; this is the half of that a machine can hold.
 *
 * # What it looks for, and what it deliberately does not
 *
 * JSX text nodes only — the run of characters between `>` and `<` — with at
 * least two words and an initial letter. That shape is a sentence someone typed.
 * It does NOT scan string literals: those are `data-testid`s, style values, IPC
 * command names, and `defaultValue` fallbacks (the unsupported-environment
 * refusal deliberately passes its English through as a default so an
 * untranslated locale renders a real sentence rather than a raw key). Flagging
 * those would produce noise, and a noisy guard gets an allowlist and then gets
 * ignored.
 */
function literalJsxText(source) {
  // Strip comments first — prose in a `//` or `/* */` block is not rendered.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  for (const m of code.matchAll(/>\s*([A-Za-z][^<>{}\n]*?)\s*</g)) {
    const text = m[1].trim();
    if (text.split(/\s+/).length < 2) continue;
    found.push(text);
  }
  return found;
}

function main() {
  const files = screenFiles();
  const { missing, stale } = rosterGaps(files);
  let failed = false;

  // Task 58: no unkeyed sentence on a screen only this client ever renders.
  const unkeyed = [];
  for (const [file, v] of Object.entries(VERDICTS)) {
    if (v.verdict !== "web-only") continue;
    const path = join(SCREENS, file);
    if (!existsSync(path)) continue;
    for (const text of literalJsxText(readFileSync(path, "utf8"))) {
      unkeyed.push([file, text]);
    }
  }
  if (unkeyed.length > 0) {
    console.error(
      `web screens: ${unkeyed.length} unkeyed sentence(s) on web-only screen(s):\n` +
        unkeyed.map(([f, t]) => `    ${f}: ${JSON.stringify(t)}`).join("\n") +
        "\n  Route it through `t()` and add the English to locales/en/common.json, or — if its\n" +
        "  exact wording is a privacy or security property — put it in load-bearing-copy.ts and\n" +
        "  render the constant. These screens are the ones nobody sees in another language, so a\n" +
        "  missed string here stays English in all 24 locales and nothing else will catch it.",
    );
    failed = true;
  }

  if (missing.length > 0) {
    console.error(
      `web screens: ${missing.length} file(s) under src/screens/ have no web verdict:\n` +
        missing.map((f) => `    ${f}`).join("\n") +
        "\n  Add one to VERDICTS in scripts/check-web-screens.mjs. A screen with no verdict " +
        "ships to the browser by default, and whether it works there is then found by a user.",
    );
    failed = true;
  }
  if (stale.length > 0) {
    console.error(
      `web screens: ${stale.length} verdict(s) name a file that no longer exists:\n` +
        stale.map((f) => `    ${f}`).join("\n"),
    );
    failed = true;
  }

  // The artefact half. Skipped — loudly — when the bundle has not been built,
  // so a local run without `pnpm web:build` reports the roster and says what it
  // could not check, rather than passing quietly.
  const markers = Object.entries(VERDICTS).filter(([, v]) => v.marker !== undefined);
  if (!existsSync(join(DIST, "index.html"))) {
    console.warn(
      "web screens: web/dist not built — roster checked, ABSENCE NOT CHECKED. " +
        "Run `pnpm web:build` first for the full gate.",
    );
  } else {
    const text = bundleText();
    const leaked = markers.filter(([, v]) => text.includes(v.marker));
    if (leaked.length > 0) {
      console.error(
        "web screens: excluded screen(s) are IN the served bundle:\n" +
          leaked
            .map(([f, v]) => `    ${f} — found "${v.marker}"\n      ${v.note ?? ""}`)
            .join("\n") +
          "\n  Excluded means absent from the artefact, not merely unreachable.",
      );
      failed = true;
    }
  }

  if (failed) process.exit(1);

  const by = (k) => Object.values(VERDICTS).filter((v) => v.verdict === k).length;
  console.log(
    `web screens: ok (${files.length} file(s): ${by("ported")} ported, ${by("adapted")} adapted, ` +
      `${by("excluded")} excluded, ${by("web-only")} web-only; ${markers.length} absence marker(s) checked)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { VERDICTS };
