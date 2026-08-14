#!/usr/bin/env node
// Regenerates `docs/decisions.md`, the index over `docs/decisions/<topic>/<NNNN>-<slug>.md`.
//
// The failure this prevents: `docs/decisions.md` says of itself that it is generated and must not
// be hand-edited, and without a generator in the tree that sentence is a request rather than a
// mechanism. The first person to add a decision would have edited the index by hand, because that
// is the only thing they could do, and from then on the index and the entries drift apart with
// nothing reporting it.
//
//   node scripts/decisions-index.mjs            rewrite the index from the entry files
//   node scripts/decisions-index.mjs --check    exit 1 if the committed index is stale
//
// `--check` is the CI-shaped half. It regenerates into memory and diffs, so a decision added
// without regenerating fails loudly instead of leaving a quietly wrong index behind.
//
// Three integrity rules it also enforces, because all three are silent otherwise:
//   - `seq` is unique across every topic. It is one global chronological sequence, not per
//     directory, and a duplicate breaks the property that sorting on it reconstructs the timeline.
//   - Every entry file parses: frontmatter with seq/date/topic/title, then its `### ` heading.
//     A file that does not parse is skipped by a naive generator and vanishes from the index while
//     still existing on disk, which is the worst of both.
//   - **No entry file contains a second dated heading.** This is the one that matters most and it
//     is here because the split that created these files lost 19 entries to exactly this shape.
//     The original log wrote 470 entries as `###` and 19 as `##`; a splitter matching only `###`
//     absorbed those 19 into the preceding entry's body, where they still read fine to a human and
//     are unreachable to everything else. The verification missed it because it counted `###` on
//     both sides, which is a roster compared against a second copy of itself. Matching `#{2,3}`
//     here catches a swallowed entry no matter which level it was written at.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const DOCS = "docs";
const ROOT = join(DOCS, "decisions");
const INDEX = join(DOCS, "decisions.md");

// The order topics appear in the table. A topic on disk that is missing here is an error rather
// than a silent append: adding one is a decision about how the log is navigated.
const TOPICS = {
  protocol: "Cryptography, key derivation, blob formats and magics, the account number, protocol versioning, cross-implementation vectors.",
  storage: "What lives where on disk, the per-blob families, migration, backup and restore, caches.",
  sync: "The sync server and its protocol, devices and their tokens, conflict resolution, CRDT work.",
  clients: "Desktop, web and mobile targets, the Tauri host, the platform seam, sidecars, packaging.",
  editor: "The CodeMirror engine, the markdown dialect, and how editing actually behaves.",
  ui: "Screens, components, the design system, theming, i18n, accessibility.",
  ai: "On-device AI, embeddings, transcription, providers.",
  security: "The threat model, hardening, exposure decisions, anything that changes what an adversary can do.",
  ops: "CI, build, release, packaging, repo guards, dependencies.",
  process: "How the project runs: terminology, the tracker, agents, spec discipline.",
};

const fail = (msg) => {
  console.error(`decisions-index: ${msg}`);
  process.exit(1);
};

if (!existsSync(ROOT)) fail(`${ROOT} does not exist; run this from the repository root`);

const entries = [];
for (const topic of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  if (!(topic in TOPICS)) fail(`unknown topic directory "${topic}"; add it to TOPICS or move the entries`);
  for (const file of readdirSync(join(ROOT, topic)).filter((f) => f.endsWith(".md"))) {
    const path = join(ROOT, topic, file);
    const text = readFileSync(path, "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!fm) fail(`${path} has no frontmatter`);
    const field = (k) => {
      const m = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm[1]);
      if (!m) fail(`${path} frontmatter has no ${k}`);
      return m[1].trim();
    };
    // Match both heading levels on purpose. An entry written as `##` is still an entry, and a
    // file that contains two of them is a file that swallowed one.
    const headings = [...text.matchAll(/^#{2,3} (\d{4}-\d{2}-\d{2}[^\n]*)$/gm)];
    if (headings.length === 0) fail(`${path} has no dated heading`);
    if (headings.length > 1) {
      fail(
        `${path} contains ${headings.length} dated headings, so it swallowed ${headings.length - 1} entry/entries. ` +
          `Each decision is its own file. Swallowed: ${headings.slice(1).map((h) => h[1].slice(0, 60)).join(" | ")}`,
      );
    }
    const head = headings[0][1].trim();
    entries.push({
      seq: Number(field("seq")),
      date: field("date"),
      topic: field("topic"),
      // The title comes from the heading, not from frontmatter: the heading is what a reader sees
      // in the file, and the two drifting apart would make the index describe something else.
      title: head.includes("—") ? head.split("—").slice(1).join("—").trim() : head,
      path: relative(DOCS, path),
    });
  }
}

if (entries.length === 0) fail("no entries found; refusing to write an empty index");

const seen = new Map();
for (const e of entries) {
  if (!Number.isInteger(e.seq)) fail(`${e.path} has a non-integer seq`);
  if (seen.has(e.seq)) fail(`seq ${String(e.seq).padStart(4, "0")} is used twice: ${seen.get(e.seq)} and ${e.path}`);
  seen.set(e.seq, e.path);
}
entries.sort((a, b) => a.seq - b.seq);

const count = (t) => entries.filter((e) => e.topic === t).length;
const pad = (n) => String(n).padStart(4, "0");

const out = [
  "# Decisions",
  "",
  "> **The running log of every meaningful decision made on the Myne project.** One file per",
  "> decision, grouped by topic, numbered in chronological order. This page is the generated",
  "> index over all of them and is the entry point every other document links to.",
  "",
  "Entries are **append-only**. A decision is never edited or deleted after it lands. When one is",
  "reversed, a new entry supersedes it and says so in its own title, so the timeline stays readable",
  "backwards. This is not a replacement for `adr/`: an ADR is a deep single-decision document, and a",
  "decision entry is the scannable record that points at it.",
  "",
  "## How to add one",
  "",
  "1. Pick the topic directory it belongs to from the table below. When two fit, pick the one a",
  "   reader would look in first, and cross-reference the other in the body.",
  "2. Create `docs/decisions/<topic>/<NNNN>-<slug>.md`, where `NNNN` is the next number in the",
  "   global sequence. The number is chronological across every topic, not per directory, so the",
  "   whole timeline can be reconstructed by sorting on it.",
  "3. Keep the existing shape: frontmatter carrying `seq`, `date`, `topic` and `title`, then the",
  "   `### YYYY-MM-DD — <title>` heading, then a one-sentence **Decision**, a one-sentence",
  "   **Rationale**, and any **Reference** links.",
  "4. Run `node scripts/decisions-index.mjs` to regenerate this page. Never hand-edit it.",
  "",
  "A reversal gets a new file with a new number. Never rewrite the file it supersedes; name it in",
  "the new title instead, the way every existing supersession does.",
  "",
  "## Topics",
  "",
  "| Topic | Entries | What belongs here |",
  "|---|---:|---|",
  ...Object.entries(TOPICS).map(([t, d]) => `| [\`${t}\`](decisions/${t}/) | ${count(t)} | ${d} |`),
  "",
  `**${entries.length} decisions** in total, spanning ${entries[0].date} to ${entries[entries.length - 1].date}.`,
  "",
  "## Timeline",
  "",
  "Newest last, exactly as the single-file log read before it was split.",
  "",
  "| # | Date | Decision | Topic |",
  "|---:|---|---|---|",
  ...entries.map((e) => `| ${pad(e.seq)} | ${e.date} | [${e.title.replaceAll("|", "\\|")}](${e.path}) | \`${e.topic}\` |`),
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : "";
  if (current === out) {
    console.log(`decisions-index: up to date (${entries.length} entries)`);
    process.exit(0);
  }
  fail("docs/decisions.md is stale. Run: node scripts/decisions-index.mjs");
}

writeFileSync(INDEX, out);
console.log(`decisions-index: wrote ${INDEX} (${entries.length} entries across ${Object.keys(TOPICS).length} topics)`);
