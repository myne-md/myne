#!/usr/bin/env node
// Platform-seam guard (phase3-web-client task 2).
//
// `src/platform/` is the ONE place the UI is allowed to reach Tauri. Every
// other file under `src/` must import the seam module instead, so the
// desktop-vs-web difference lives at a single boundary rather than being
// re-scattered across the tree the way it was before the seam existed
// (103 import sites in 78 files).
//
// A guard is what makes that durable: without one, the seam erodes on the
// next feature that adds `import { invoke } from "@tauri-apps/api/core"`
// somewhere convenient, and nothing notices until the web build breaks.
//
// Deliberately a grep-shaped script in the same pattern as lefthook's
// secret-scan / eof-newline / cargo-lock-singleton guards — NOT an ESLint
// rule. The repo has no JS linter, and adding one is a dependency decision
// (root CLAUDE.md: "Adding a dependency is a security decision"), not a side
// effect of a seam guard. Zero dependencies, node built-ins only.
//
// Runs in `pre-commit` (lefthook) and as a CI backstop, so `--no-verify`
// still gets caught.
//
// Usage:
//   node scripts/check-platform-seam.mjs             # scan the guarded roots
//   node scripts/check-platform-seam.mjs a.ts b.tsx  # scan only these files

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Guarded root → the seam directory that is exempt inside it.
//
// `src/` has `src/platform/`. The three shared SOURCE packages have no seam of
// their own and need none: they reach their host through `EditorHost`
// (`editor/src/host.ts`), which is a dependency-injection point rather than a
// directory, so `seam: null` means "nothing here is exempt — zero Tauri imports,
// full stop".
//
// `editor/`, `dialect/` and `copy/` joined with phase3-web-client task 76, which
// moved the six remaining call sites (`attachments/{insert,catalog,picker,
// voiceRecord,convert-command}.ts` and `host/notes/attachmentRef.ts`) behind the
// host and deleted the two `@tauri-apps/*` peerDependencies from
// `editor/package.json`. That combination is what lets a NON-Tauri client
// compile these packages at all: a module-scope import lands in the bundle
// whether or not the call ever fires.
const GUARDED = [
  { root: "src", seam: join("src", "platform") },
  { root: "editor", seam: null },
  { root: "dialect", seam: null },
  { root: "copy", seam: null },
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|cts)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

// Import/require/dynamic-import of a `@tauri-apps/*` specifier. Anchored on
// the quote so a prose mention in a comment ("routed via the seam's dialog
// module, formerly @tauri-apps/plugin-dialog") is not a violation — only an
// actual module specifier is.
const VIOLATION = /(?:^|[^A-Za-z0-9_$])(?:from|import|require)\s*\(?\s*(["'])(@tauri-apps\/[^"']+)\1/;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

function guardFor(file) {
  const rel = relative(process.cwd(), file);
  return GUARDED.find((g) => rel === g.root || rel.startsWith(g.root + sep));
}

const argv = process.argv.slice(2);
const files = argv.length
  ? argv.filter((f) => SOURCE_EXT.test(f))
  : GUARDED.flatMap((g) => walk(g.root, []));

const violations = [];
for (const file of files) {
  const guard = guardFor(file);
  if (!guard) continue;
  const rel = relative(process.cwd(), file);
  // `seam: null` roots have no exempt directory — every file is guarded.
  if (guard.seam !== null && (rel === guard.seam || rel.startsWith(guard.seam + sep))) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // staged-but-deleted file
  }
  text.split("\n").forEach((line, i) => {
    const m = VIOLATION.exec(line);
    if (m) violations.push({ file: rel, line: i + 1, spec: m[2], seam: guard.seam });
  });
}

if (violations.length) {
  console.error("Direct @tauri-apps/* import outside the platform seam:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  imports ${v.spec}`);
  }
  const seam = violations[0].seam;
  if (seam === null) {
    console.error(
      `\nNothing in editor/, dialect/ or copy/ may import @tauri-apps/* — these are` +
        `\nSHARED SOURCE packages compiled by every client, including one that is not` +
        `\nTauri at all. Reach the host through the EditorHost seam instead:` +
        `\n\n    import { getHost } from "<relative>/host";` +
        `\n    const rows = await getHost().attachments.catalogList();` +
        `\n\nIf the operation has no slot yet, ADD one to editor/src/host.ts and` +
        `\nimplement it in each client's host (src/editor-host.ts on desktop).` +
        `\nA module-scope @tauri-apps import lands in the bundle whether or not the` +
        `\ncall ever fires, so it breaks the web build rather than degrading it.`,
    );
    process.exit(1);
  }
  console.error(
    `\nOnly ${seam}/ may import @tauri-apps/*. Import the matching seam module` +
      `\ninstead (e.g. \`import { invoke } from "<relative>/${seam.split(sep).pop()}/core"\`),` +
      `\nor add the export to the seam module if it does not exist yet.` +
      `\nWhy: the web client compiles the same tree with a web implementation` +
      `\nbehind that boundary — a direct import breaks it (docs/decisions.md,` +
      `\nphase3-web-client).`,
  );
  process.exit(1);
}

// ── the wasm module belongs to the Worker, and only to the Worker ───────────
//
// phase3-web-client task 11, acceptance criterion 1 ("all vault IO and wasm
// execution in the Worker"). Same shape of rule as the Tauri ban above, and it
// needs a guard for the same reason: importing the glue from a main-thread
// module is convenient, compiles, and *appears* to work — right up until the
// first `createSyncAccessHandle`, which is dedicated-worker-only in every
// browser, or the first Argon2id derivation, which would then run on the thread
// that paints the unlock screen.
//
// A second instance is worse than slow. It means a second copy of `root_key` in
// a second linear memory, and two `FileSystemSyncAccessHandle`s on the same
// files — which OPFS refuses with `NoModificationAllowedError` **sometimes**,
// depending on ordering. An intermittent lock failure is a much harder bug than
// a rejected import.
const WASM_GLUE = /(?:^|[^A-Za-z0-9_$])(?:from|import|require)\s*\(?\s*(["'])([^"']*wasm\/pkg\/[^"']+)\1/;
const WASM_OWNER = join("web", "src", "worker", "worker.ts");

const wasmViolations = [];
for (const file of argv.length ? files : walk("web", []).filter((f) => SOURCE_EXT.test(f))) {
  const rel = relative(process.cwd(), file);
  if (rel === WASM_OWNER) continue;
  // `.d.ts` files declare the module's TYPE rather than importing it — the
  // declaration is exactly how the Worker's import stays type-checked without a
  // generated `.d.ts` (see `web/src/worker/wasm-module.d.ts`).
  if (rel.endsWith(".d.ts")) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    const m = WASM_GLUE.exec(line);
    if (m) wasmViolations.push({ file: rel, line: i + 1, spec: m[2] });
  });
}

if (wasmViolations.length) {
  console.error("The wasm module is imported outside the vault Worker:\n");
  for (const v of wasmViolations) {
    console.error(`  ${v.file}:${v.line}  imports ${v.spec}`);
  }
  console.error(
    `\nOnly ${WASM_OWNER} may import the wasm glue. Call it through the Worker` +
      `\ntransport instead (\`web/src/worker/host.ts\`, or the seam module` +
      `\n\`web/src/platform/core.ts\` from shared code).` +
      `\n\nWhy: \`createSyncAccessHandle\` is dedicated-worker-only in every browser` +
      `\nand Safari implements no \`createWritable\`, so the storage layer CANNOT` +
      `\nrun on the main thread — and a second wasm instance means a second copy of` +
      `\n\`root_key\` plus two sync access handles on the same OPFS files.`,
  );
  process.exit(1);
}

console.log(`platform-seam: ok (${files.length} file(s) checked)`);
