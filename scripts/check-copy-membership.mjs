#!/usr/bin/env node
// Membership in `@myne/copy`: a name this package exports is DEFINED here and
// nowhere else (audit 2026-10-18 R0.1, fixed 2026-10-19).
//
// # The failure this prevents, and why nothing else caught it
//
// `copy/src/index.ts`'s header claimed the literals were "byte-identical across
// clients by construction — cross-client paraphrase is impossible", and
// `docs/dev/twin-inventory.md` recorded the desktop/mobile pair as "RESOLVED …
// both sides now re-export the shared family". Both sentences were true of the
// sync/enroll family and FALSE of eighteen per-note-export, clip-notice and
// settings literals, which `src/lib/load-bearing-copy.ts` and
// `mobile/src/lib/load-bearing-copy.ts` each declared:
//
//   desktop: 23 exported consts   mobile: 19   in both: 18   of the 18 in copy: 0
//
// Two of the eighteen were `UNLOCK_NON_DISTINGUISHING_BANNER` and
// `RECOVERY_NON_DISTINGUISHING_BANNER` — the non-distinguishing collapses
// `recovery-flow.md` §3.4/§7.3 pin and the E2E suite asserts by full-literal
// equality. It was LATENT: the two copies happened to be byte-identical that day,
// so nothing misrendered. What was missing was the mechanism, and that is the
// whole point — a `design-notes.md` event had to be two copy edits in two files
// with nothing failing if only one was made.
//
// The three guards that could have noticed, and why each did not:
//
//   - `check-twin-drift-ratchet.mjs` fires on a pair that STARTS differing. This
//     pair was already recorded as differing (each client has its own surface
//     copy), so a new hand-copy inside it changed no set membership.
//   - `check-twin-inventory.mjs` compares the two clients WITH EACH OTHER. Both
//     were wrong in the same direction, so the comparison was green.
//   - `check-i18n.mjs` refuses a load-bearing literal as a locale VALUE. It says
//     nothing about where the literal is declared.
//
// # The two rules, in the two directions
//
// 1. ERROR — a client tree may not DECLARE an exported binding whose name
//    `@myne/copy` exports. This is the defect above. It is scoped to shared-tree
//    roots rather than to the two files that had it, because the next one will be
//    in a different file and the whole class is "a second place the value can
//    drift".
// 2. WARNING — a name `@myne/copy` exports that nothing outside this package
//    mentions is dead. Deliberately a warning: a shared literal staged for a
//    surface that has not landed yet is a legitimate state (the beta-terms
//    clauses sat that way on mobile for months), and gating it would push an
//    author to delete a reviewed literal rather than keep it.
//
// It deliberately does NOT check, and says so rather than leaving it to be
// discovered: whether a name `@myne/copy` exports should be shared at all, and
// whether a client's OWN local constant duplicates one in copy under a different
// name (a paraphrase is invisible to any name-based check — that is what the
// by-construction rule exists to make unnecessary rather than to detect).
//
// Zero dependencies, hand-runnable: node scripts/check-copy-membership.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { presentSharedRoots } from "./lib/shared-roots.mjs";

const COPY_DIR = join("copy", "src");
const COPY_ENTRY = join("copy", "src", "index.ts");

/**
 * Directories a name may legitimately be CONSUMED in.
 *
 * The shared roots are the clients; the rest are the test and tooling trees,
 * which import `@myne/copy` directly (a test asserting a pinned literal by
 * identity is a first-class consumer, not a second declaration site — rule 1
 * does not scan these).
 */
const CONSUMER_EXTRA_ROOTS = [
  "tests",
  "e2e",
  "e2e-web",
  "scripts",
  "stories/src",
  "web/wasm",
  "web/container",
];

/** Extensions both walks read. */
const SOURCE_RE = /\.(ts|tsx)$/;

/**
 * Names `source` exports as bindings.
 *
 * Handles the declaration forms (`export const|let|var|function|type|enum|class|
 * interface NAME`) and the local re-export form (`export { A, B as C };` with no
 * `from`, which renames and therefore declares nothing new — reported under the
 * ORIGINAL name only when no `as` is present, since `B as C` exports `C`).
 */
export function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(
    /^export\s+(?:const|let|var|function|type|enum|class|interface)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
    for (const part of m[1].split(",")) {
      const spec = part.trim();
      if (spec === "") continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
      if (asMatch) names.add(asMatch[2]);
      else if (/^[A-Za-z_$][\w$]*$/.test(spec)) names.add(spec);
    }
  }
  return names;
}

/**
 * `undefined`-safe comment stripper for the declaration scan.
 *
 * Rule 1 is a scan over EXPORTED DECLARATIONS, and a doc comment above one
 * routinely writes the name (`/** The clip success notice's primary line …`),
 * so an unstripped scan can read prose as a declaration. Line comments only
 * matter for the `^export` anchor; block comments are removed wholesale.
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * `[path, name]` pairs where `files` declares a name in `copyNames`.
 *
 * Exported rather than inlined into `main` so the injection test can drive it
 * with a fixture, which is the only way to know the rule fires.
 */
export function redefinitions(files, copyNames) {
  const out = [];
  for (const [path, source] of files) {
    for (const name of exportedNames(stripComments(source))) {
      if (copyNames.has(name)) out.push([path, name]);
    }
  }
  return out;
}

/** Names in `copyNames` that `corpus` never mentions as a word. */
export function unconsumed(copyNames, corpus) {
  const out = [];
  for (const name of copyNames) {
    if (!new RegExp(`\\b${name}\\b`).test(corpus)) out.push(name);
  }
  return out;
}

/** Every `.ts`/`.tsx` file under `root`, as `[relativePath, source]`. */
export function readTree(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "target") continue;
        walk(full);
      } else if (SOURCE_RE.test(name)) {
        out.push([relative(".", full), readFileSync(full, "utf8")]);
      }
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return out;
}

function main() {
  const errors = [];
  const warnings = [];

  let copySource;
  try {
    copySource = readFileSync(COPY_ENTRY, "utf8");
  } catch {
    console.error(
      `copy-membership: ${COPY_ENTRY} not found. This guard has stopped checking — ` +
        `the package entry moved and the rule below it is now unreachable.`,
    );
    process.exit(1);
  }
  const copyNames = exportedNames(stripComments(copySource));
  if (copyNames.size === 0) {
    // A scan that finds no export passes every rule inside it, which is the
    // `check-platform-seam.mjs` failure one file over: an empty denominator
    // reporting ok.
    console.error(
      `copy-membership: no exported bindings found in ${COPY_ENTRY}. The scan shape ` +
        `no longer matches the file; teach it the new one rather than leaving it ` +
        `reporting ok over nothing.`,
    );
    process.exit(1);
  }

  const { present, missing } = presentSharedRoots();
  if (missing.length > 0) {
    errors.push(
      `shared root(s) absent from this checkout: ${missing.join(", ")}. Rule 1 cannot ` +
        `see a declaration in a tree that is not here.`,
    );
  }

  // Rule 1. Every shared tree except `copy/src` itself.
  const clientRoots = present.filter((r) => r !== COPY_DIR);
  const clientFiles = clientRoots.flatMap((r) => readTree(r));
  for (const [file, name] of redefinitions(clientFiles, copyNames)) {
    errors.push(
      `${file}: declares \`${name}\`, which \`@myne/copy\` already exports. A second ` +
        `declaration is a second place the value can drift, and the package's whole ` +
        `claim is that there is one — re-export it from \`@myne/copy\` instead.`,
    );
  }

  // Rule 2. Consumed anywhere outside `copy/`?
  const consumerRoots = [
    ...present.filter((r) => r !== COPY_DIR),
    ...CONSUMER_EXTRA_ROOTS,
  ];
  const consumerText = consumerRoots
    .flatMap((r) => readTree(r))
    .map(([, source]) => source)
    .join("\n");
  for (const name of unconsumed(copyNames, consumerText)) {
    warnings.push(
      `\`@myne/copy\` exports \`${name}\`, and nothing outside \`copy/\` mentions it. ` +
        `Either a surface that should use it does not, or the literal is staged for ` +
        `one that has not landed yet (a legitimate state — the beta-terms clauses ` +
        `sat that way on mobile for months). Recorded rather than failed.`,
    );
  }

  for (const message of warnings) console.warn(`copy-membership: WARNING — ${message}`);
  if (errors.length > 0) {
    console.error(
      `copy-membership: ${errors.length} problem(s):\n` +
        errors.map((e) => `    ${e}`).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `copy-membership: ok (${copyNames.size} export(s) in @myne/copy, ` +
      `${clientFiles.length} client file(s) scanned for a redefinition, ` +
      `${warnings.length} unconsumed export warning(s))`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
