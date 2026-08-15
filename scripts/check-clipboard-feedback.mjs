#!/usr/bin/env node
// Guard: every clipboard write goes through the seam, and every copy through the
// policy module says what the user is told (myne-md/myne#390 + myne-md/myne#455).
//
// The failure this prevents, in the words of the audit that found it: eleven
// clipboard call sites across three trees, in FOUR different feedback patterns,
// two of which reported nothing on either outcome. The worst was the
// recovery-phrase step, where the phrase is shown once and never again, a failed
// Copy looked exactly like a successful one, so "I pressed Copy" was not evidence
// the phrase was anywhere. On mobile it was worse still: the note copy reached
// the WebView clipboard API directly, bypassing a seam whose plugin was never
// registered, so the UNHARDENED path worked and the hardened one did not.
//
// Neither compiler nor lint can see any of that. A dropped `.catch()`, a `void`
// on a promise, and a label that swaps only on success all typecheck.
//
// ── Rule 1: no raw WebView clipboard API ──────────────────────────────────────
//
// A single exemption, `web/src/platform/clipboardManager.ts`, because that file
// IS the web seam: on web the platform write and the raw call are the same thing,
// and the seam is where that stops being an accident and becomes a decision.
//
// The scan is a PLAIN STRING MATCH and that is deliberate. A comment-aware
// scanner is a scanner with a bypass, and a bypass in a prohibition guard is
// worse than a false positive in one. The cost is that prose must not spell the
// identifier either; the code that had to be reworded for this says so at the
// site, and rewording a comment is cheaper than trusting a parser.
//
// ── Rule 2: no copy without a stated outcome ──────────────────────────────────
//
// `copyText` / `copySecret` (`src/lib/clipboard.ts`, aliased `@myne/clipboard`)
// take a REQUIRED feedback pair, so TypeScript already stops a caller omitting
// it. This rule adds the one thing TypeScript cannot express: a `silent` arm
// must carry a NON-EMPTY reason.
//
// A `silent` arm without a reason is the exact state this feature started in: an
// absence that a reader cannot tell from an oversight. Two call sites are
// legitimately silent (the fail-closed diagnostics copy, the code-block icon
// flip) and both say why, at the site.
//
// **This header used to claim a third check**, that every call site "names its
// arms", and no such check exists. A reviewer injected exactly that defect (a
// call passing an opaque `Feedback` value rather than a literal) and the guard
// said nothing. The claim is cut rather than the check added, deliberately: a
// literal-only rule would reject a caller that legitimately builds its pair in a
// helper, and the property that matters is already carried by the type. What is
// NOT acceptable is a header describing a rule the code does not run, because
// the next author reads the header, believes the hole is covered, and stops.
//
// ── Verifying this guard ──────────────────────────────────────────────────────
//
// Per CLAUDE.md, verifying a guard means BREAKING it, in both directions:
//
//   1. Add `navigator.clipboard.writeText("x")` to a guarded file that is not the
//      web seam. This must fail and name that file.
//   2. Add `{ kind: "silent", reason: "" }` to a feedback pair. This must fail and
//      name that file.
//
// Both injections were performed and both were named. A guard verified by "the
// tree is still green afterwards" is not verified.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Extensions worth scanning. */
const SCANNED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);

/** Directories never worth walking. */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", "gen", "pkg"]);

/**
 * The ONE file allowed to name the raw API.
 *
 * It is the web platform seam: on web, `navigator.clipboard.writeText` IS the
 * seam's implementation. Adding a second entry here is the change this guard
 * exists to make someone argue for.
 */
const RAW_API_EXEMPT = new Set(["web/src/platform/clipboardManager.ts"]);

/** The raw API, spelled once, here. */
const RAW_API = "navigator.clipboard";

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SCANNED.has(entry.slice(entry.lastIndexOf("."))))  {
      out.push(full);
    }
  }
  return out;
}

const { present, missing } = presentSharedRoots(ROOT);
if (missing.length > 0) {
  console.error(
    `clipboard-feedback: shared roots missing from this checkout: ${missing.join(", ")}\n` +
      "  Every shared tree is in-repo now, so this means a broken checkout rather\n" +
      "  than a normal one. Refusing to report a pass over a tree that is not there.",
  );
  process.exit(1);
}

const files = [];
for (const root of present) walk(join(ROOT, root), files);

const rawViolations = [];
const silentViolations = [];

// A `silent` arm with an empty or whitespace-only reason. Written to tolerate the
// formatting a call site may use (the arm often spans lines), which is why the
// `kind` and the `reason` are matched as a pair rather than line by line.
const SILENT_NO_REASON =
  /kind\s*:\s*["']silent["']\s*,\s*reason\s*:\s*(["'`])\s*\1/g;

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");

  if (src.includes(RAW_API) && !RAW_API_EXEMPT.has(rel)) {
    for (const [i, line] of src.split("\n").entries()) {
      if (line.includes(RAW_API)) rawViolations.push(`${rel}:${i + 1}`);
    }
  }

  SILENT_NO_REASON.lastIndex = 0;
  let m;
  while ((m = SILENT_NO_REASON.exec(src)) !== null) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    silentViolations.push(`${rel}:${lineNo}`);
  }
}

let failed = false;

if (rawViolations.length > 0) {
  failed = true;
  console.error(
    `clipboard-feedback: ${rawViolations.length} raw clipboard call(s) outside the seam:`,
  );
  for (const v of rawViolations) console.error(`    ${v}`);
  console.error(
    "\n  Reach the clipboard through the platform seam instead:\n" +
      "    desktop / web   src/platform/clipboardManager.ts\n" +
      "    mobile          mobile/src/lib/clipboard.ts\n" +
      "    editor/         the host's `clipboardWrite` member\n" +
      "  A raw call bypasses the mobile native transport (no OS-enforced expiry,\n" +
      "  no device confinement for secrets) and, in a WebView, can be refused in\n" +
      "  situations the native path is not.\n" +
      "\n  If you are only MENTIONING the API in prose: reword it. The scan is a\n" +
      "  plain string match on purpose, see this file's header.",
  );
}

if (silentViolations.length > 0) {
  failed = true;
  console.error(
    `clipboard-feedback: ${silentViolations.length} silent feedback arm(s) with no reason:`,
  );
  for (const v of silentViolations) console.error(`    ${v}`);
  console.error(
    "\n  A `silent` arm must say why, because an unexplained silence is exactly\n" +
      "  what this feature was fixing: a reader cannot tell it from an oversight.\n" +
      "  Two call sites are legitimately silent and both carry their reason.",
  );
}

if (failed) process.exit(1);

console.log(
  `clipboard-feedback: ok (${files.length} file(s) across ${present.length} shared root(s); ` +
    `1 seam exemption)`,
);
