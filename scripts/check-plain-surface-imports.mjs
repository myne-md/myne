#!/usr/bin/env node
// Plain-surface import guard (myne-md/myne#788).
//
// The plain-file surface (`src/plain/`) renders the user's own on-disk markdown
// with no vault at all: it works with a vault locked and on a device that has
// never had one. That property does not survive a single vault-coupled import.
// `src/notes/...`, `src/lib/vault-*.ts` and the IPC wrappers call `invoke` at
// module scope in several files, so the import alone reaches Tauri before any
// call fires, and the ambient reads (prefs on mount, the tag tree on a typed
// `#`, the spell pass) would then ask a vault that does not exist or is locked.
//
// The refusal the editor host performs (task 8) covers only what the editor
// calls THROUGH the host. A direct import never passes through it, which is why
// this guard exists beside that refusal rather than instead of it.
//
// What fails: any `.ts`/`.tsx` file under `src/plain/` whose import specifiers
// resolve into the vault-coupled list below. Relative specifiers are resolved
// against the importing file first, so `../notes/vaultIndices` in
// `src/plain/x.ts` is checked as `src/notes/vaultIndices`. The match is
// anchored on the quote (`from "…"`, `import("…")`, `require("…")`), so a
// prose mention of a module path in a comment is not a violation.
//
// What is allowed, and why the rule is a DENYLIST rather than an allowlist:
// `src/platform/*` (the seam), `src/components/*` (the design primitives),
// `src/lib/stage`, `@myne/editor`, `react`, `react-i18next`, i18n and the
// design tokens are all fine, and so is any future pure module nobody has
// written yet. An allowlist would need an edit for each such module and would
// start failing on a good change; the denylist names the couplings that
// actually break the no-vault guarantee, each carrying its reason, so a new
// pure module needs no change here.
//
// Zero dependencies, node builtins only, in the pattern of
// `check-platform-seam.mjs`. Usage:
//
//   node scripts/check-plain-surface-imports.mjs
//
// The analysis is EXPORTED (`analyse`) so `tests/scripts/plainSurfaceImports.test.ts`
// can drive the same code over injected fixtures rather than restating the
// rule: one implementation and two callers, the `check-web-command-coverage.mjs`
// precedent.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const PLAIN_ROOT = join("src", "plain");
const SOURCE_EXT = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

/**
 * A quoted import specifier after `from`, `import` or `require`. The leading
 * character class is what lets a bare `import "x"` (no binding) match while
 * `important` does not.
 */
const IMPORT = /(?:^|[^A-Za-z0-9_$])(?:from|import|require)\s*\(?\s*(["'])([^"'`\n]+)\1/g;

/**
 * The vault-coupled denylist, each entry carrying the reason it is coupled.
 *
 * `test` runs against the path TAIL, meaning the part under `src/` with any
 * extension stripped (`notes/vaultIndices`, `lib/prefs`, …), so the real tree
 * (`src/plain/x.ts` resolving `../notes/vaultIndices`) and a fixture built
 * under a temp directory (`/tmp/.../src/plain/x.ts`) are checked by the same
 * predicate.
 */
const VAULT_COUPLED = [
  {
    test: (t) => t === "notes" || t.startsWith("notes/"),
    reason:
      "src/notes/ is the notes domain (the tag index, rename hooks and tab signals read or write vault state)",
  },
  {
    test: (t) => t === "hooks" || t.startsWith("hooks/"),
    reason:
      "src/hooks/ holds vault-lifecycle React hooks (usePrefs and friends) that assume an unlocked vault",
  },
  {
    test: (t) =>
      t === "lib/vault" || t.startsWith("lib/vault-") || t.startsWith("lib/vault/"),
    reason: "src/lib/vault-*.ts are the direct IPC wrappers for vault commands",
  },
  {
    test: (t) => t === "lib/prefs" || t.startsWith("lib/prefs/"),
    reason:
      "src/lib/prefs reads and writes vault.prefs, which is unreadable while the vault is locked or absent",
  },
  {
    test: (t) => t === "lib/attachments" || t.startsWith("lib/attachments/"),
    reason: "src/lib/attachments reaches the attachment catalog and blob IPC",
  },
  {
    test: (t) => t === "lib/spell" || t.startsWith("lib/spell/"),
    reason: "src/lib/spell reads and writes the MYD1 personal dictionary through IPC",
  },
  {
    test: (t) => t === "lib/writing-assistant" || t.startsWith("lib/writing-assistant/"),
    reason: "src/lib/writing-assistant reaches the on-device AI backend",
  },
  {
    test: (t) => t === "lib/voice-record" || t.startsWith("lib/voice-record/"),
    reason: "src/lib/voice-record drives mic capture into the vault's attachments",
  },
  {
    test: (t) => t === "lib/transcribe" || t.startsWith("lib/transcribe/"),
    reason: "src/lib/transcribe reaches the on-device speech backend",
  },
];

/**
 * The path under `src/`, extension stripped, or `null` when the target is not
 * under a `src/` directory at all (a bare package specifier).
 *
 * Anchored on the LAST `/src/` so both the relative real tree (`src/…`) and an
 * absolute fixture path (`/tmp/…/src/…`) yield the same tail. The direction is
 * fail-safe: a fixture that puts its decoy module under its own nested `src/`
 * is matched, not skipped.
 */
function tailUnderSrc(resolved) {
  const norm = resolved.split(sep).join("/");
  const at = norm.lastIndexOf("/src/");
  let tail;
  if (at !== -1) tail = norm.slice(at + "/src/".length);
  else if (norm.startsWith("src/")) tail = norm.slice("src/".length);
  else if (norm === "src") return null;
  else return null;
  return tail.replace(SOURCE_EXT, "");
}

/** The denylist reason for a resolved target, or `null` when it is allowed. */
function vaultCoupledReason(resolved) {
  const tail = tailUnderSrc(resolved);
  if (tail === null) return null;
  for (const entry of VAULT_COUPLED) {
    if (entry.test(tail)) return entry.reason;
  }
  return null;
}

// `withFileTypes` rather than a `statSync` per entry: same reason as the
// platform-seam walk, the kind is already known.
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Scan every `.ts`/`.tsx` file under `root` and return what violates the rule.
 * Pure: reads files, prints nothing, exits nothing, so the spec can assert on
 * the return and the CLI below can format it.
 *
 * `checked` counts files actually read. The CLI refuses a zero-file run by
 * name: a walk that found nothing prints the same "ok" as a clean tree, which
 * is how a guard for a renamed directory stops guarding silently.
 */
export function analyse(root = PLAIN_ROOT) {
  const findings = [];
  const files = walk(root, []);
  let checked = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // staged-but-deleted file
    }
    checked += 1;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(IMPORT)) {
        const spec = match[2];
        if (!spec.startsWith(".")) continue;
        const resolved = normalize(join(dirname(file), spec));
        const reason = vaultCoupledReason(resolved);
        if (reason !== null) {
          findings.push({ file, line: index + 1, spec, resolved, reason });
        }
      }
    });
  }
  return { findings, checked };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(PLAIN_ROOT)) {
    console.error(
      `plain-surface-imports: ${PLAIN_ROOT}/ does not exist.\n\n` +
        `The guard's denominator is the plain-file surface. If the tree moved, move the\n` +
        `guard's PLAIN_ROOT with it rather than letting the scan silently cover nothing.`,
    );
    process.exit(1);
  }

  const { findings, checked } = analyse();

  if (checked === 0) {
    console.error(
      `plain-surface-imports: no .ts/.tsx files under ${PLAIN_ROOT}/, so the scan is vacuous.`,
    );
    process.exit(1);
  }

  if (findings.length) {
    console.error("Vault-coupled import inside the plain-file surface:\n");
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  imports "${f.spec}"`);
      console.error(`    ${f.reason}`);
    }
    console.error(
      `\nThe plain surface renders with the vault locked or absent, so it may not reach\n` +
        `vault state even indirectly. Route the operation through the EditorHost seam\n` +
        `(the host answers emptily while the plain surface is active, see\n` +
        `src/plain/surfaceMode.ts), or take the value as a prop if it comes from the\n` +
        `caller. If the module is genuinely vault-free, name the coupling it avoids\n` +
        `and move it out of the denylisted path.`,
    );
    process.exit(1);
  }

  console.log(
    `plain-surface-imports: ok (${checked} file(s) checked under ${PLAIN_ROOT}/)`,
  );
}
