#!/usr/bin/env node
// Comment-volume ratchet: a file may lose comments, never gain them.
//
// # The failure this prevents
//
// AGENTS.md rule 3 is "a comment earns its lines or it goes", and it was the one
// repository rule with NO guard among the others. It was also the one that
// decayed: measured 2026-11-08 the shared trees carried 235,850 comment lines
// against 567,087 of code (29%), and the worst files were 75-84% comments -
// `src/lib/prefs.ts` held 1,630 comment lines around 553 lines of code, and
// `client-core/src/capabilities.ts` 418 around 87. None of that is visible to a
// compiler, a linter or a reviewer scrolling a diff: a forty-line docblock looks
// like diligence, and forty of them look like a well-documented module.
//
// A one-off sweep does not hold. The volume came back twice in this repository's
// history (the decision split and the story catalogue both grew theirs back), and
// the reason is structural: writing a paragraph costs nothing at the moment it is
// written, and the cost lands on the next reader. So this records what each file
// carries today and fails when a file carries more.
//
// # What it does NOT do
//
// It does not ask for fewer comments than the file has, and it does not judge
// whether a comment earns its place - that is `/deslop-comments` and a review,
// and a script cannot read for meaning. It only makes the TOTAL a decision: to
// add forty lines of narration to `prefs.ts` you must delete forty elsewhere in
// the same file, or re-record with `--record`, which puts the growth in the diff
// where a reviewer sees it.
//
// `protocol/` is included rather than exempt. Its comments document crypto
// invariants (AAD bindings, magic guards, subkey roles) and are default-KEEP, so
// the recorded number there is legitimately high; including it stops the file
// that must not lose comments from quietly doubling them instead.
//
// # Usage
//
//   node scripts/check-comment-density.mjs            # gate
//   node scripts/check-comment-density.mjs --record   # re-baseline (shows in the diff)
//
// Zero dependencies, node built-ins only - same shape as the other guards here
// (root AGENTS.md: adding a dependency is a security decision).

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ROSTER = join(ROOT, "scripts", "comment-density.json");

/** Every tree that ships a comment-bearing source file. */
const TREES = [
  "core/src",
  "protocol/src",
  "format/src",
  "decrypt/src",
  "cli/src",
  "mcp/src",
  "theme-validator/src",
  "src-tauri/src",
  "mobile/src-tauri/src",
  "src",
  "web/src",
  "mobile/src",
  "client-core/src",
  "editor/src",
  "dialect/src",
  "copy/src",
];

/** A file needs this many code lines before its ratio means anything. */
const MIN_CODE_LINES = 50;

/**
 * A file nobody has recorded may not open above this ratio. Set at "more comment
 * than code": a module genuinely half explanation is unusual, and the escape is
 * one `--record` with the growth in the diff.
 */
const NEW_FILE_MAX_RATIO = 0.5;

const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "pkg", "coverage", ".worktrees"]);

const EXT = new Set([".rs", ".ts", ".tsx"]);

/** Walk one tree, yielding `[relPath, source]`. */
function walk(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Count whole-line comments and code lines.
 *
 * A line carrying code AND a trailing comment counts as CODE: this repository
 * writes whole-line comments, and counting trailing ones as comments would let a
 * file grow a thousand trailing notes for free. Block comments are tracked so a
 * `*` continuation line counts once, and Rust attributes (`#[...]`) are code, not
 * comments - `#[ignore = "..."]` has a reason string and is still behaviour.
 */
function count(source) {
  let comment = 0;
  let code = 0;
  let inBlock = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (inBlock) {
      comment++;
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*") || line.startsWith("{/*")) {
      comment++;
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("{/*")) {
      comment++;
      continue;
    }
    code++;
  }
  return { comment, code };
}

function measure() {
  const files = {};
  for (const tree of TREES) {
    for (const rel of walk(tree)) {
      const { comment, code } = count(readFileSync(join(ROOT, rel), "utf8"));
      if (code < MIN_CODE_LINES) continue;
      if (comment === 0) continue;
      files[rel.split("\\").join("/")] = comment;
    }
  }
  return files;
}

function main() {
  const recorded = existsSync(ROSTER) ? JSON.parse(readFileSync(ROSTER, "utf8")) : {};
  const current = measure();
  const record = process.argv.includes("--record");

  if (record) {
    const body = { $comment: recorded.$comment, files: current };
    writeFileSync(ROSTER, JSON.stringify(body, null, 2) + "\n");
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    console.log(
      `comment-density: recorded ${Object.keys(current).length} file(s), ${total.toLocaleString("en-US")} comment line(s).`,
    );
    return;
  }

  const known = recorded.files ?? {};
  const failures = [];

  for (const [path, count_] of Object.entries(current)) {
    const was = known[path];
    if (was === undefined) {
      const { code } = count(readFileSync(join(ROOT, path), "utf8"));
      const ratio = count_ / (count_ + code);
      if (ratio > NEW_FILE_MAX_RATIO) {
        failures.push(
          `${path} is new and ${Math.round(ratio * 100)}% comments (${count_} of ${
            count_ + code
          } non-blank lines). Trim it, or record it with \`--record\` so the growth is reviewable.`,
        );
      }
      continue;
    }
    if (count_ > was) {
      failures.push(
        `${path} grew from ${was} to ${count_} comment line(s) (+${count_ - was}). ` +
          "Trim elsewhere in the file, or `--record` so the growth shows in the diff.",
      );
    }
  }

  for (const path of Object.keys(known)) {
    if (current[path] === undefined) {
      failures.push(
        `${path} is recorded but carries no counted comment today (deleted, trimmed to " +
          "nothing, or dropped under the ${MIN_CODE_LINES}-code-line floor). Record it with \`--record\`.`,
      );
    }
  }

  if (failures.length) {
    console.error("check-comment-density: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      "\nA comment earns its lines or it goes (AGENTS.md rule 3). The rule this gate enforces is " +
        "not 'fewer comments': it is that the total is a DECISION rather than a habit.",
    );
    process.exit(1);
  }

  const total = Object.values(current).reduce((a, b) => a + b, 0);
  const baseline = Object.values(known).reduce((a, b) => a + b, 0);
  console.log(
    `comment-density: ok (${Object.keys(current).length} file(s), ${total.toLocaleString(
      "en-US",
    )} comment line(s); baseline ${baseline.toLocaleString("en-US")}). This number must only go down.`,
  );
}

main();
