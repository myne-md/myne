#!/usr/bin/env node
// check-story-catalogue.mjs, every story carries the metadata the workbench
// reads (myne-md/myne#845).
//
// The failure this prevents: `description` and `tags` are what the navbar search
// matches and what the inspector shows as the story's summary. A story without
// them is a story nobody can find by intent, and nothing else would notice, a
// missing description breaks no build and renders nothing wrong. It is the same
// shape as the coverage guard next door: a ratchet over the story files that the
// compiler cannot express.
//
// It also refuses the placeholder phrases the catalogue used to render as story
// content ("Modal body.", "Auth body", "Control"), so a specimen cannot quietly
// go back to demonstrating nothing.
//
// Fails both ways per story: a `state:` with no `description:` or `tags:` after
// it fails, and a `description:` or `tags:` with no `state:` near it fails too,
// so a copy-paste cannot leave an orphan annotation. The second direction is why
// this guard's own header is trustworthy rather than a promise: the first version
// of it claimed the reverse scan and did not perform one, which a review caught.
// `tags: []` fails as well, because an empty list is the same as no tags to
// search and the whole point is that a story is findable by intent.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STORIES_DIR = join(ROOT, "stories/src/stories");

/**
 * Placeholder phrases that mean a story is demonstrating nothing. Matched inside
 * a `render` body, which is where a specimen's visible text lives.
 *
 * `Control` is matched only as a whole JSX text node, because the word appears
 * legitimately in prose elsewhere.
 */
export const PLACEHOLDER_PHRASES = Object.freeze([
  "Modal body.",
  "Auth body",
  ">Control<",
]);

/** Every story file's text, keyed by its basename. */
export function storySources(dir = STORIES_DIR) {
  if (!existsSync(dir)) throw new Error(`story directory not found: ${dir}`);
  const out = new Map();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".tsx")) continue;
    out.set(entry, readFileSync(join(dir, entry), "utf8"));
  }
  return out;
}

/**
 * Annotated states: for each `state: "x",` line, whether a `description:` and a
 * `tags:` follow before the next `state:` or the end of the block.
 *
 * A line scan rather than an AST: the repo's guards are zero-dependency and this
 * shape is stable, and a parser that only has to be right about the descriptor
 * grammar is easier to trust than a general one.
 */
export function findings(sources = storySources()) {
  const problems = [];
  for (const [file, text] of sources) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const state = line.match(/^\s*state:\s*"([^"]+)",\s*$/);
      if (!state) return;
      // Everything up to the next `state:` (or the end of the run) is this
      // story's own descriptor.
      const rest = lines.slice(index + 1, index + 14);
      const stop = rest.findIndex((candidate) => /^\s*state:\s*"/.test(candidate));
      const scope = (stop >= 0 ? rest.slice(0, stop) : rest).join("\n");
      if (!/^\s*description:/m.test(scope)) {
        problems.push(`${file}:${index + 1}: state "${state[1]}" has no description`);
      }
      // `tags: []` is the same as no tags: search has nothing to match on. The
      // first version tested only for the opening bracket, so an empty list
      // passed while the rule said "at least one tag".
      if (!/^\s*tags:\s*\[[^\]]*[^\s\]]/m.test(scope)) {
        problems.push(`${file}:${index + 1}: state "${state[1]}" has no tags`);
      }
    });

    // The reverse direction: a story DESCRIPTOR's `description:` or `tags:` that
    // no `state:` owns. Exactly four spaces, because a fixture's own
    // `description:` (two spaces, inside an object literal) is not a story
    // annotation and has no `state:` to own it. The first version matched both
    // and reported five fixtures as orphans.
    lines.forEach((line, index) => {
      if (!/^ {4}(description|tags):/.test(line)) return;
      let owner = -1;
      for (let back = index - 1; back >= 0 && index - back <= 14; back -= 1) {
        if (/^\s*state:\s*"/.test(lines[back])) {
          owner = back;
          break;
        }
      }
      if (owner < 0) {
        problems.push(
          `${file}:${index + 1}: a "${line.trim().split(":")[0]}" with no "state:" to own it`,
        );
      }
    });

    for (const phrase of PLACEHOLDER_PHRASES) {
      if (text.includes(phrase)) {
        problems.push(`${file}: renders the placeholder phrase ${JSON.stringify(phrase)}`);
      }
    }
  }
  return problems;
}

/** A scan that finds no stories is a broken scan, not a pass. */
export function storyCount(sources = storySources()) {
  let count = 0;
  for (const text of sources.values()) {
    count += (text.match(/^\s*state:\s*"[^"]+",\s*$/gm) ?? []).length;
  }
  return count;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  const sources = storySources();
  const count = storyCount(sources);
  if (count === 0) {
    console.error("check-story-catalogue: FAIL: no stories found; the scan is broken");
    process.exit(1);
  }
  const problems = findings(sources);
  if (problems.length > 0) {
    console.error(`check-story-catalogue: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `check-story-catalogue: ok (${count} stories across ${sources.size} file(s); every one has a description and tags; no placeholder phrases)`,
  );
}
