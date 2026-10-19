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
// # The rule
//
// **A client tree may not DECLARE an exported binding whose name `@myne/copy`
// exports.** That is the defect above, stated as a rule. It is scoped to the
// shared-tree roots rather than to the two files that had it, because the next
// one will be in a different file and the whole class is "a second place the
// value can drift".
//
// # What it deliberately does NOT check, and who owns each
//
//   - **Whether a name `@myne/copy` exports is used at all.** That is
//     `check-export-callers.mjs`'s question, one file over, and it already had a
//     budget for this exact file. It was briefly a warning here too; the
//     duplication was removed rather than kept, because two mechanisms for one
//     question is the failure `scripts/lib/shared-roots.mjs` and
//     `scripts/lib/woodpecker-configs.mjs` both exist to prevent.
//   - **Whether a name should be shared at all.** A judgement, not a scan.
//   - **A client's own local constant that duplicates one in copy under a
//     DIFFERENT name.** A paraphrase is invisible to any name-based check, which
//     is precisely why byte-identity has to be a construction rather than a
//     detection. This guard is the construction's enforcement, not its
//     substitute.
//
// Zero dependencies, hand-runnable: node scripts/check-copy-membership.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { presentSharedRoots } from "./lib/shared-roots.mjs";

const COPY_DIR = join("copy", "src");
const COPY_ENTRY = join("copy", "src", "index.ts");

/** Extensions the walk reads. */
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

  if (errors.length > 0) {
    console.error(
      `copy-membership: ${errors.length} problem(s):\n` +
        errors.map((e) => `    ${e}`).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `copy-membership: ok (${copyNames.size} export(s) in @myne/copy, ` +
      `${clientFiles.length} client file(s) scanned for a redefinition)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
