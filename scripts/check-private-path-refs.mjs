#!/usr/bin/env node
// Private-path references in the trees this repository publishes.
//
// ── THE FAILURE ──────────────────────────────────────────────────────────────
//
// `operations/`, `agent-tooling/` and `internal-service/` are companion repositories that
// stay private. A path into one of them, written into a `docs/` page or a source
// header, is a reference a reader who does not have that repository cannot
// follow, and the reader cannot tell the difference between "this is internal"
// and "this moved and nobody updated it". The pointer also carries a promise the
// publication does not keep: `docs/` is CC-BY-4.0 and meant to be reusable by
// independent implementations, and a third of it currently cites design sessions
// that are not published at all.
//
// An issue reference is NOT a path reference and is deliberately allowed:
// `example-org/agent-tooling#123` names a tracker item, which is a different object from
// a file. The pattern requires a `/` after the repository name for exactly that
// reason, so `agent-tooling#123` passes and `agent-tooling/reference/x.md` does not.
//
// ── WHY A RATCHET, AND WHY THE REASONS ARE CLASSES ───────────────────────────
//
// The honest baseline is large: about two hundred and fifty files under `docs/`,
// nearly all of them dated decision entries citing the grill session, PRD or RFC
// they came from. `docs/AGENTS.md` makes that log append-only and says never to
// rewrite a past entry, and the two rules meet here: the pointer is the entry's
// provenance, and the artefact it names is internal. So those are recorded, not
// fixed, and the reason is a CLASS rather than a sentence per file, because two
// hundred hand-written reasons would be two hundred copies of one argument.
//
// The SET of recorded files may shrink and may never grow. `--record` refuses a
// grown set, so the command its own failure message suggests cannot be used to
// make a finding disappear, and a new file has to be admitted by hand into a
// class whose reason then has to be true of it.
//
// ── WHAT IT DOES NOT CHECK ───────────────────────────────────────────────────
//
// It does not judge whether a reference is justified, only that the set of files
// carrying one is not growing. And it does not scan the companion repositories or
// `agent-tooling/` itself, which is where these paths are supposed to be.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = join(ROOT, "scripts", "private-path-refs.json");

/** The trees that get published. A root that is absent fails by name below. */
export const SCANNED_ROOTS = ["docs", "src", "mobile/src"];

/** Extensions whose bytes can carry a reader-facing path. */
export const SCANNED_EXTENSIONS = new Set([
  ".md",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".svg",
]);

/** Extensions that cannot carry one, each with the reason. Fail-closed: an
 *  extension in neither list is a question for a human, not a silent pass. */
export const IGNORED_EXTENSIONS = Object.freeze({
  ".png": "raster image; no text content at all",
});

/** The private repositories, as a path segment. `#` after the name is an issue
 *  reference and does not match, which is the point of requiring the slash. */
const REF = /\b(operations|agent-tooling|internal-service)\/([A-Za-z0-9._/-]*)/g;

/** Every private-path reference in one blob of text, as `repo/rest` strings.
 *  Paths are kept whole so the failure message can name what the reader would
 *  have chased rather than only the file. */
export function refsInText(text) {
  const found = new Set();
  for (const match of text.matchAll(REF)) {
    found.add(`${match[1]}/${match[2]}`);
  }
  return [...found].sort();
}

/** The classes a recorded file can belong to, with the reason each carries.
 *
 *  A class is an argument, and every file in it has to be an instance of that
 *  argument. That is the whole reason they are classes: a per-file reason would
 *  be a per-file argument nobody would read twice. */
export const CLASSES = Object.freeze({
  "append-only-record": {
    reason:
      "A file under design-notes/, the append-only log. The entry cites the grill session, PRD or RFC it " +
      "came from, and docs/AGENTS.md forbids rewriting a past entry, so the pointer is that entry's " +
      "provenance. The cited artefact is internal; the durable public record is the entry itself.",
    fix:
      "Nothing. This one is permanent by rule. If a NEW one appears, the entry should cite the decision " +
      "it belongs to rather than a session file, or the reference belongs in the entry's own prose.",
  },
  "living-document": {
    reason:
      "Debt. A living file (docs/dev, docs/spec, a source header) that points at an internal artefact " +
      "without being a historical record, so the pointer is supposed to be fixable: inline the substance, " +
      "or point at the public copy. Recorded so the set can only shrink.",
    fix:
      "Fix it: replace the path with the thing it was standing in for, or point at a published equivalent " +
      "(a design-notes entry, the user guide on myne.md).",
  },
});

/** One file's references: `{ path, refs }`. `path` is repo-relative with `/`. */
export function scanFile(absPath, relPath, read) {
  const text = read(absPath);
  const refs = refsInText(text);
  return refs.length > 0 ? { path: relPath, refs } : null;
}

/** Every scanned file under `root`, repo-relative, with the extension policy
 *  applied. Returns `{ files, unclassified }`; an unclassified extension is a
 *  failure at the call site rather than a smaller walk here. */
export function walkRoot(root, dir, readDir = readdirSync, read = (p) => readFileSync(p, "utf8")) {
  const files = [];
  const unclassified = [];
  const visit = (d) => {
    for (const name of readDir(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      const ext = extname(name).toLowerCase();
      // No extension is treated as prose: `docs/LICENSE` is a text file, and a
      // rule that skipped it would be a rule with a hole shaped like a licence.
      if (ext && ext in IGNORED_EXTENSIONS) continue;
      if (ext && !SCANNED_EXTENSIONS.has(ext)) {
        unclassified.push(relative(join(ROOT, root), full));
        continue;
      }
      files.push(relative(join(ROOT, root), full).split("\\").join("/"));
    }
  };
  visit(dir);
  return { files: files.sort(), unclassified: unclassified.sort() };
}

/** The whole scan: `{ byClass, hits, missingRoots, unclassified }`. */
export function scan() {
  const hits = new Map();
  const missingRoots = [];
  const unclassified = [];
  for (const root of SCANNED_ROOTS) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) {
      missingRoots.push(root);
      continue;
    }
    const { files, unclassified: unknown } = walkRoot(root, abs);
    unclassified.push(...unknown.map((u) => `${root}/${u}`));
    for (const rel of files) {
      const hit = scanFile(join(abs, rel), rel, (p) => readFileSync(p, "utf8"));
      if (hit) hits.set(`${root}/${rel}`, hit.refs);
    }
  }
  return { hits, missingRoots, unclassified };
}

/** Group the hits into the classes, for the roster and for the report. */
export function classOf(docPath) {
  return docPath.startsWith("design-notes/") ? "append-only-record" : "living-document";
}

function readRecord() {
  if (!existsSync(RECORD)) return null;
  const parsed = JSON.parse(readFileSync(RECORD, "utf8"));
  const out = {};
  for (const key of Object.keys(CLASSES)) out[key] = parsed[key] ?? [];
  return out;
}

function writeRecord(grouped) {
  writeFileSync(
    RECORD,
    JSON.stringify(
      {
        $comment:
          "Recorded private-path references, by class. The classes and the reason each carries live in " +
          "scripts/check-private-path-refs.mjs, which is what a reader should read; this file is the " +
          "roster. The SET may shrink and may never grow: `node scripts/check-private-path-refs.mjs " +
          "--record` refuses a grown set, so a new file is admitted by hand into a class whose reason " +
          "has to be true of it.",
        ...grouped,
      },
      null,
      2,
    ) + "\n",
  );
}

function main() {
  const record = process.argv.includes("--record");
  const { hits, missingRoots, unclassified } = scan();

  if (missingRoots.length > 0) {
    console.error(
      `private-path-refs: FAIL — scanned root(s) not found: ${missingRoots.join(", ")}.\n` +
        "  A root on the roster but absent from the checkout is a failure, not a smaller walk:\n" +
        "  the scan would report ok over a tree it never read.",
    );
    process.exit(1);
  }
  if (unclassified.length > 0) {
    console.error(
      `private-path-refs: FAIL — ${unclassified.length} file(s) with an extension this guard has not ` +
        "classified:\n" +
        unclassified.map((f) => `  ${f}`).join("\n") +
        "\n  Decide and say: can these bytes carry a reader-facing path (then add the extension to " +
        "SCANNED_EXTENSIONS), or can they not (then add it to IGNORED_EXTENSIONS with the reason)?",
    );
    process.exit(1);
  }

  const grouped = {};
  for (const key of Object.keys(CLASSES)) grouped[key] = [];
  for (const docPath of hits.keys()) grouped[classOf(docPath)].push(docPath);
  for (const key of Object.keys(grouped)) grouped[key].sort();

  const recorded = readRecord();

  if (record) {
    if (recorded !== null) {
      const before = new Set(Object.values(recorded).flat());
      const added = [...hits.keys()].filter((p) => !before.has(p)).sort();
      if (added.length > 0) {
        console.error(
          `private-path-refs: REFUSING to record ${added.length} new file(s).\n` +
            "  A grown set is a bigger promise that a published tree points at something a reader\n" +
            "  cannot open, and --record is not the way to accept one:\n" +
            added.map((f) => `  ${f}  (${hits.get(f).join(", ")})`).join("\n") +
            "\n  Fix the reference, or add the file to a class in the guard by hand and make the\n" +
            "  class reason true of it.",
        );
        process.exit(1);
      }
    }
    writeRecord(grouped);
    const total = Object.values(grouped).flat().length;
    console.log(
      `private-path-refs: recorded ${total} file(s)` +
        (recorded === null ? " (SEEDED: read the classes in the guard and confirm each holds)" : "") +
        ". Run without --record to check.",
    );
    return;
  }

  if (recorded === null) {
    console.error(
      "private-path-refs: FAIL — no roster at scripts/private-path-refs.json. Seed it with " +
        "`node scripts/check-private-path-refs.mjs --record`, then read the classes in that script and " +
        "satisfy yourself that each describes the files it now covers.",
    );
    process.exit(1);
  }

  const stale = Object.values(recorded)
    .flat()
    .filter((p) => !hits.has(p))
    .sort();
  const added = [...hits.keys()]
    .filter((p) => !new Set(Object.values(recorded).flat()).has(p))
    .sort();

  if (added.length > 0) {
    console.error(
      `private-path-refs: FAIL — ${added.length} file(s) newly point at a private repository:\n` +
        added.map((f) => `  ${f}  (${hits.get(f).join(", ")})`).join("\n") +
        "\n" +
        Object.entries(CLASSES)
          .map(([k, v]) => `  ${k}: ${v.fix}`)
          .join("\n"),
    );
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error(
      `private-path-refs: FAIL — ${stale.length} recorded file(s) no longer point at a private\n` +
        "  repository, so the roster claims something that is not true:\n" +
        stale.map((f) => `  ${f}`).join("\n") +
        "\n  Re-record with `node scripts/check-private-path-refs.mjs --record` (it only shrinks).",
    );
    process.exit(1);
  }

  console.log(
    `private-path-refs: ok (${hits.size} recorded file(s) across ${Object.keys(CLASSES).length} class(es); ` +
      `no new private path)`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-private-path-refs.mjs")) {
  main();
}
