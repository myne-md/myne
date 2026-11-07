// check-duplication.mjs — tree-level duplication has an owner (myne-md/myne#995).
//
// # The failure this prevents
//
// `least-code` (`agent-tooling/skills/pr-review/reviewers/least-code.md`, #984)
// asks "could this branch have been smaller", which is the right question, and
// it reads the branch DIFF. Duplication is a property of the TREE: the eleven
// existing `FieldLabel` copies under `mobile/src` are invisible to a review
// looking at a twelfth, and nothing re-fires on code that already shipped. Every
// copy therefore enters through a review that is structurally unable to notice
// it, and the repo's antidote so far has been one hand-written guard per concept
// AFTER a human happened to spot the pattern.
//
// # Two signals, because one is not enough
//
// **Clone groups.** jscpd over the same roots measured 1.85% duplicated LINES
// (2026-11-03). That number is not the complaint: the copies that matter are
// small, renamed and cross-surface, so every identifier differs and they sit
// under a token detector's floor. This scan compares a NORMALISED skeleton —
// comments stripped, string contents, numbers and non-keyword identifiers
// replaced with a placeholder — so a renamed copy still matches.
//
// That finds a copy whose body is identical. It does NOT find the `FieldLabel`
// family, and the reason is the whole point of the second signal: those eleven
// copies differ in prop order and in `marginTop`, so no body comparison at any
// threshold groups them, while a reader sees eleven definitions of one name. So
// the second signal is the cheapest one there is and needs no tool:
//
// **Repeated local definitions.** An UNEXPORTED `function`/`const`/`class` in a
// TypeScript file, defined under the same name in three or more files. Exported
// names are excluded on purpose — an exported `Button` shared across the tree is
// the answer, not the problem — and so is a list of conventional closure names
// (`toggle`, `commit`, `save`, ...) that every surface legitimately gives its own
// callback. Measured on the day this landed, that scan reports exactly the
// names myne#995 measured by hand: `FieldLabel` 11, `SectionLabel` 8, `pad2` 7,
// `assertNever` 6, `RowChevron` 6, `subscribe` 6.
//
// # A roster, not a ceiling, and why
//
// A ceiling on duplicated lines is the shape this repo has already measured as
// gameable and ignorable (`scripts/e2e-scenario-floor.json` and
// `scripts/manual-test-ratchet.json` carry that argument in their own headers),
// and it cannot tell "three copies of one idea" from "three ideas that look
// alike". It also cannot answer the question a reader has when it fires: WHICH
// duplication. So the record is a roster and the rule is per group.
//
// `scripts/duplication-groups.json` holds two things, and the difference between
// them is the discipline:
//
//   `verdicts`  the groups a human has EXAMINED. `consolidate` is owed work a
//               reader can pick up; `justified` is permanent duplication and its
//               reason says why (`protocol/src/*_blob.rs` is the canonical case:
//               a per-family AAD and error type at the call site is the crypto
//               discipline, and a macro there would hide the AAD).
//   `baseline`  the ids that were present at the last re-baseline and have no
//               verdict yet. Measured, not approved: it says "this existed on
//               that day", and it is the reason the guard can be adopted at all
//               without writing 380 reasons in one sitting.
//
// The ratchet is what the pair buys, in both directions:
//
//   1. a group that is neither in `verdicts` nor in `baseline` fails by name —
//      that is the forward direction, and the one a new copy hits;
//   2. a `verdicts` or `baseline` entry whose group is gone fails as stale, so
//      the roster cannot describe a tree that has moved;
//   3. a recorded group may SHRINK freely (fewer lines, fewer copies) and may
//      not GROW: growth is a re-baseline, which is a deliberate act, never a
//      silence;
//   4. `--emit` re-baselines DOWNWARD only. It drops what vanished, keeps what
//      is unchanged, and REFUSES to add a new group unless a verdict entry for
//      it already exists. A re-baseline cannot license what it found, so
//      "our gate is red, run --emit" is not an available move.
//
// `--bootstrap` is the one exception and it is a single act per record, taken in
// the change that introduces the guard: it seeds `baseline` with everything the
// tree has, and prints the counts so the commit that adds it states them. Running
// it a second time is not needed and is refused.
//
// # A group's identity is its files, not its bytes
//
// An edit INSIDE a duplicated block is ordinary work and must not revoke the
// record; introducing duplication between a new pair of files must. So a clone
// group's id is `a.ts + b.ts`, with ` #n` appended only when those files host
// more than one distinct cloned block (ordered by the block's normalised body,
// so an edit of one does not renumber the others). A repeated definition's id is
// just its name.
//
// # Usage
//
//   node scripts/check-duplication.mjs             # --check: tree vs record
//   node scripts/check-duplication.mjs --emit      # re-baseline (downward) + report
//   node scripts/check-duplication.mjs --bootstrap # seed a new record, once
//   node scripts/check-duplication.mjs --list      # every group, to stdout
//
// # Verifying this guard means breaking it
//
// Inject a copy: duplicate a helper whose body is unchanged into a second file
// and watch it fail naming both paths. Also rename a local helper into three
// files and watch the REPEAT half name it — that half has no body comparison to
// fall back on, so it is the only thing that catches a re-invented
// `FieldLabel`. Then delete one side of a recorded pair and watch it fail stale,
// which is the direction nobody tries. `tests/scripts/duplication.test.ts` drives
// every direction through injected sources.

import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

export const RECORD_PATH = join(HERE, "duplication-groups.json");
export const REPORT_PATH = join(ROOT, "docs", "dev", "duplication.md");

// The roots myne#995 measured, so the guard answers the question that filed it.
// `src-tauri/src`, `cli` and `mcp` join the two scanners' union: the issue's
// second measurement included them, and `src-tauri/src/cli_bridge/` carries a
// duplicated-by-design pair the roster has to verdict either way.
export const ROOTS = [
  "src",
  "core/src",
  "protocol/src",
  "editor/src",
  "dialect/src",
  "client-core/src",
  "web/src",
  "mobile/src",
  "src-tauri/src",
  "cli/src",
  "mcp/src",
];

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".rs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "dist-release",
  "pkg",
  "gen",
  "vendor",
  ".git",
  "__generated__",
]);

// Ten lines is the seed length: a copy shorter than that is a coincidence.
//
// Two floors, and the reason there are two is measured. A DENSE window (45 tokens,
// i.e. a real line of code every line) is a duplicated thought at ten lines. A LONG
// run (30 lines) is a copied region even when it is sparse — a verbatim copy of a
// JSX-heavy file has whole windows of `}` and `>` and clears no token floor at all,
// which is how the first version of this guard reported a 57-line verbatim copy of
// `src/components/primitives/FieldLabel.tsx` as NO duplication. Seeding is therefore
// loose (20 tokens, 6 lines that are more than punctuation) and the REPORT keeps a
// group only if it is dense or long:
//
//   dense  45 tokens per ten-line window — a line of real code every line
//   long   30 lines — a copy-pasted region whatever its density
//
// Measured on the tree at the day this landed: 2 157 files, 445 458 normalised lines,
// 425 clone groups holding 24 757 redundant lines, and 42 repeated local definitions.
// The issue's own hand measurement was 311 groups and ~6 700 redundant lines with a
// scanner that normalised identifiers the same way but tokenised differently; the two
// are the same order, and neither number is a target.
export const WINDOW_LINES = 10;
export const MIN_TOKENS = 45;
export const SEED_TOKENS = 20;
export const SEED_SUBSTANTIVE_LINES = 6;
export const LONG_RUN_LINES = 30;
export const MIN_REASON_LEN = 20;
export const PLACEHOLDER = "REASON REQUIRED";
export const VERDICTS = new Set(["consolidate", "justified"]);

// A local definition counts as repeated at three sites. Two is a sibling pair and
// usually a genuine parameterisation waiting to happen, which review catches on
// its own diff; three is a family.
export const MIN_REPEAT_SITES = 3;

// Sites kept per (window, file). The cap exists so one bucket cannot make the
// extension loop quadratic, and it is PER FILE for a measured reason:
// `cli/src/logging_discipline.rs` and `src-tauri/src/cli_bridge/
// logging_discipline.rs` share a long run of identical `(name, field!(name)),`
// lines, and a bucket-wide cap filled up with the first file's own repetitions
// before the second file was ever scanned. The pair then reported as zero
// duplication — a detector that misses the case an issue names is worse than no
// detector, because it reads as a clean tree.
const OCCURRENCES_PER_FILE = 4;

// Kept rather than replaced by `I`, because the skeleton these words carry IS the
// shape the scan compares: dropping them would make a `match` in Rust and an `if`
// in TypeScript read as the same construct.
const KEYWORDS = new Set([
  "return", "if", "else", "for", "while", "do", "switch", "case", "default",
  "break", "continue", "try", "catch", "finally", "throw", "new", "class",
  "extends", "implements", "interface", "type", "enum", "import", "export",
  "from", "as", "of", "in", "typeof", "instanceof", "delete", "void", "yield",
  "this", "super", "null", "undefined", "true", "false", "static", "const",
  "let", "var", "function", "async", "await", "get", "set", "public", "private",
  "protected", "readonly", "declare", "namespace", "satisfies", "keyof",
  "use", "pub", "fn", "struct", "impl", "trait", "match", "mut", "ref", "self",
  "Self", "mod", "where", "loop", "unsafe", "dyn", "box", "move", "crate",
  "Some", "None", "Ok", "Err", "Option", "Result", "String", "Vec", "str",
  "bool", "usize", "isize", "u8", "u16", "u32", "u64", "u128", "i8", "i16",
  "i32", "i64", "i128", "f32", "f64", "derive", "cfg", "test", "inline",
]);

// Conventional names a callback or a local accumulator is given at every surface.
// Excluding them is not a fudge: a `toggle` in two files is two different
// closures over two different states, and gating on it would make the roster
// unfalsifiable. Each entry names the convention it is, and an entry that no
// longer occurs in the tree fails as stale, so this list cannot rot into a
// blanket exemption nobody dares touch.
export const CLOSURE_NAMES = {
  add: "array/set append, the name every collection surface gives it",
  apply: "the command-dispatcher verb: apply the next state",
  choose: "a picker's onClick body, named for the choice not the choice's values",
  close: "the dismiss verb of a dialog or sheet",
  commit: "the write verb of an editor or form body",
  el: "a DOM element local in a render or measure routine",
  emit: "an event bus publish, named for its one call",
  field: "a generic form field accessor",
  flush: "a buffer drain, named after what it does to the buffer",
  handlePaste: "a paste event handler, named by the DOM event it binds",
  handleSubmit: "a form submit handler, named by the DOM event it binds",
  kind: "a discriminant accessor over one enum",
  label: "a display-string local in a render body",
  onKeyDown: "a keydown handler, named by the DOM event it binds",
  onPointerDown: "a pointer handler, named by the DOM event it binds",
  onPointerMove: "a pointer handler, named by the DOM event it binds",
  p: "a promise/value local in an async body",
  pad: "a string padder local to one formatting routine",
  pending: "an in-flight flag local to one async effect",
  read: "an IO verb, named after the call it wraps",
  reducer: "a reducer a component owns rather than shares",
  refresh: "a re-fetch verb, named after the call it wraps",
  remove: "array/set delete, the sibling of `add`",
  render: "a render body in a non-component file",
  row: "a table/list row local in a render body",
  run: "a job starter over one host handle",
  save: "a persist verb of one form body",
  slice: "an array/string slice local in one transform",
  submit: "a form submit body, the non-DOM-event spelling",
  teardown: "a cleanup body, named after the teardown it performs",
  toggle: "a boolean flip of one local state",
  walk: "a recursive visitor over the local model it was written for",
  write: "an IO verb, the sibling of `read`",
};

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Strip comments and string contents from a source text, one array entry per
 * line. String literals collapse to the marker `S`, so `"Cancel"` and
 * `"settings.title"` compare equal: the scan asks about shape, and the strings
 * differ in every copy by definition.
 *
 * Rust's `'` is left alone on purpose. It opens a lifetime far more often than a
 * char literal, and treating it as a quote would eat the rest of the line.
 */
export function stripCommentsAndStrings(text, lang = "ts") {
  const quotes = lang === "rs" ? ['"'] : ['"', "'", "`"];
  const lines = [];
  let line = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") {
          lines.push(line);
          line = "";
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (quotes.includes(c)) {
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        // An unterminated literal must not swallow the file.
        if (text[i] === "\n") break;
        i++;
      }
      line += "S ";
      continue;
    }
    if (c === "\n") {
      lines.push(line);
      line = "";
      i++;
      continue;
    }
    line += c;
    i++;
  }
  lines.push(line);
  return lines;
}

const NUMBER = /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b/g;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * One normalised skeleton line: numbers and non-keyword identifiers replaced,
 * whitespace collapsed. Returns `""` for a line that carries no structure.
 *
 * An `import`/`use` line normalises to `""` deliberately. Every file with a
 * dozen imports has the same skeleton there, and a roster that opens with "these
 * ten files import the same number of things" is the noise that gets a guard
 * ignored; the clause is also the one thing module boundaries make uninteresting,
 * because the import list is exactly what a resolver already checks.
 */
export function normaliseLine(line) {
  if (/^\s*(?:import|use)\b/.test(line) && !line.includes("= require(")) return "";
  const withNumbers = line.replace(NUMBER, "N");
  // A property name, a struct field or an object-literal key carries MEANING rather
  // than a name a copy would change, so it is kept. Without it every `{ display: …,
  // marginTop: … }` block in the tree collapsed into one 33-line skeleton that 42
  // files "shared", which was the largest group the scan reported and pure noise.
  //
  // Only at the START of a line, or right after `{` or `,`, because that is where an
  // object member lives. A parameter or a type annotation (`dir: string`) is not a key,
  // and treating it as one made a renamed copy differ at every signature — measured:
  // the `FieldLabel` pair matched from line 2 and reported 20 lines instead of 21.
  // `::` is excluded or every Rust path segment would be a key.
  const keepKeys = withNumbers.replace(/(^\s*|[{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:(?!:))/g, "$1\u0001$2$3");
  const withKeys = keepKeys
    .replace(IDENT, (m, offset, whole) => {
      if (whole[offset - 1] === "\u0001") return m;
      return KEYWORDS.has(m) ? m : "I";
    })
    .replace(/\u0001/g, "");
  return withKeys.replace(/\s*([()[\]{},;:.!?<>=+\-*/&|])\s*/g, "$1").trim();
}

/**
 * A whole file to its non-empty normalised lines, as `{ key, tokens }`.
 *
 * `key` is the comparable skeleton. `tokens` counts the line AS IT WAS WRITTEN, one
 * token per whitespace-separated piece, because that is the unit a density floor can
 * be calibrated on and explained in: a floor over the collapsed key would count
 * `fontSize: 12,` as one token and a run of braces as five, which is the opposite of
 * what the floor is for.
 */
export function normaliseSource(text, lang = "ts") {
  const out = [];
  for (const raw of stripCommentsAndStrings(text, lang)) {
    const key = normaliseLine(raw);
    if (key === "") continue;
    out.push({ key, tokens: raw.trim() === "" ? 0 : raw.trim().split(/\s+/).length });
  }
  return out;
}

// ── File walk ────────────────────────────────────────────────────────────────

function langOf(path) {
  return path.endsWith(".rs") ? "rs" : "ts";
}

function walk(dir, into) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), into);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot === -1 || !EXTENSIONS.has(entry.name.slice(dot))) continue;
    into.push(join(dir, entry.name));
  }
}

/** Every scanned source under `root`, as `{ path, text }` with repo-relative paths. */
export function readSources(root = ROOT, roots = ROOTS) {
  const files = [];
  for (const sub of roots) walk(join(root, sub), files);
  return files.sort().map((abs) => ({
    path: relative(root, abs).split("\\").join("/"),
    text: readFileSync(abs, "utf-8"),
  }));
}

// ── Clone groups ─────────────────────────────────────────────────────────────

/**
 * Groups over a list of `{ path, text }`. Returns a Map keyed by the group id
 * (see the header: the file set, plus ` #n` when one file set hosts more than
 * one distinct block) to `{ id, files, lines, copies, occurrences, body }`.
 *
 * A line-window clone detector: every `WINDOW_LINES`-line run whose token count
 * clears the floor is hashed, buckets with two or more sites are extended as far
 * as the skeletons agree in both directions, and runs that share an ANCHOR site
 * collapse into one group. The anchor keying is what stops the over-merge: on
 * shared-any-site grouping, X-with-Y and Y-with-Z chain until thirteen unrelated
 * files read as one 58-copy group, and a roster full of those is not a roster.
 */
export function cloneGroups(sources) {
  const skeleton = new Map();
  for (const src of sources) skeleton.set(src.path, normaliseSource(src.text, langOf(src.path)));

  const windows = new Map();
  for (const [path, lines] of skeleton) {
    const seen = new Map();
    for (let i = 0; i + WINDOW_LINES <= lines.length; i++) {
      let count = 0;
      let substantive = 0;
      for (let j = i; j < i + WINDOW_LINES; j++) {
        count += lines[j].tokens;
        if (lines[j].tokens >= 2) substantive++;
      }
      if (count < SEED_TOKENS || substantive < SEED_SUBSTANTIVE_LINES) continue;
      const key = lines
        .slice(i, i + WINDOW_LINES)
        .map((l) => l.key)
        .join("\n");
      const kept = seen.get(key) ?? 0;
      if (kept >= OCCURRENCES_PER_FILE) continue;
      seen.set(key, kept + 1);
      if (!windows.has(key)) windows.set(key, []);
      // All sites of one bucket hold the same content, so the density flag is the
      // bucket's, not the site's; it rides along so the report can tell a dense
      // ten-line match from a long sparse one.
      windows.get(key).push({ path, index: i, dense: count >= MIN_TOKENS });
    }
  }

  const runs = [];
  for (const sites of windows.values()) {
    if (sites.length < 2) continue;
    const anchor = sites[0];
    for (let s = 1; s < sites.length; s++) runs.push(extendRun(anchor, sites[s], skeleton));
  }

  const components = new Map();
  for (const run of runs) {
    const anchor = run.sites[0];
    const key = `${anchor.path}:${anchor.line}`;
    if (!components.has(key)) {
      components.set(key, { length: 0, body: "", anchor, sites: new Map(), dense: false });
    }
    const component = components.get(key);
    component.dense ||= run.dense;
    if (run.length > component.length) {
      component.length = run.length;
      component.body = run.body;
    }
    for (const site of run.sites) component.sites.set(`${site.path}:${site.line}`, site);
  }

  const raw = [];
  for (const component of components.values()) {
    // Copies, not window starts. Thirty near-identical consecutive lines produce
    // thirty window starts that are one region; the anchor keeps its own region
    // and a later site in the same file that overlaps a kept site is dropped,
    // which is what makes `copies` mean what a reader thinks it means.
    const anchorKey = `${component.anchor.path}:${component.anchor.line}`;
    const sorted = [...component.sites.values()].sort((a, b) => {
      const ak = `${a.path}:${a.line}`;
      const bk = `${b.path}:${b.line}`;
      if (ak === anchorKey) return -1;
      if (bk === anchorKey) return 1;
      return a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;
    });
    const keptSites = [];
    for (const site of sorted) {
      const clashes = keptSites.some(
        (other) =>
          other.path === site.path &&
          site.line < other.line + component.length &&
          other.line < site.line + component.length,
      );
      if (!clashes) keptSites.push(site);
    }
    // Dense OR long. See the two floors above: this is the rule that decides what
    // the roster talks about, and it is the difference between 3 000 groups of
    // markup that happen to line up and the ~460 a reader can act on.
    if (keptSites.length >= 2 && (component.dense || component.length >= LONG_RUN_LINES)) {
      raw.push({ body: component.body, length: component.length, occurrences: keptSites });
    }
  }

  // Drop a component whose sites are all inside a longer component's.
  raw.sort((a, b) => b.length - a.length || b.occurrences.length - a.occurrences.length);
  const kept = [];
  for (const run of raw) {
    const redundant = kept.some(
      (other) =>
        other.length >= run.length &&
        run.occurrences.every((o) =>
          other.occurrences.some(
            (p) => p.path === o.path && p.line >= o.line && p.line + run.length <= o.line + other.length,
          ),
        ),
    );
    if (!redundant) kept.push(run);
  }

  const byFileSet = new Map();
  for (const run of kept) {
    const files = [...new Set(run.occurrences.map((o) => o.path))].sort();
    const key = files.join(" + ");
    if (!byFileSet.has(key)) byFileSet.set(key, []);
    byFileSet.get(key).push({ ...run, files });
  }

  const groups = new Map();
  for (const [fileKey, runsInSet] of byFileSet) {
    runsInSet.sort((a, b) => (a.body < b.body ? -1 : a.body > b.body ? 1 : 0));
    runsInSet.forEach((run, i) => {
      const id = runsInSet.length > 1 ? `${fileKey} #${i + 1}` : fileKey;
      groups.set(id, {
        id,
        files: run.files,
        lines: run.length,
        copies: run.occurrences.length,
        occurrences: run.occurrences,
        body: run.body,
      });
    });
  }
  return groups;
}

function extendRun(a, b, skeleton) {
  const la = skeleton.get(a.path);
  const lb = skeleton.get(b.path);
  let before = 0;
  while (
    a.index - before - 1 >= 0 &&
    b.index - before - 1 >= 0 &&
    la[a.index - before - 1].key === lb[b.index - before - 1].key
  ) {
    before++;
  }
  let after = WINDOW_LINES;
  while (a.index + after < la.length && b.index + after < lb.length && la[a.index + after].key === lb[b.index + after].key) {
    after++;
  }
  const start = a.index - before;
  return {
    dense: Boolean(a.dense || b.dense),
    body: la
      .slice(start, a.index + after)
      .map((l) => l.key)
      .join("\n"),
    length: before + after,
    sites: [
      { path: a.path, line: start + 1 },
      { path: b.path, line: b.index - before + 1 },
    ],
  };
}

// ── Repeated local definitions ───────────────────────────────────────────────

const DEF_PATTERNS = [
  /^\s{0,2}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s{0,2}const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|function\b|\()/,
  /^\s{0,2}class\s+([A-Za-z_$][\w$]*)/,
];

/**
 * Unexported local definitions that the tree declares under the same name in
 * `MIN_REPEAT_SITES` or more files.
 *
 * Exported definitions are skipped: a name exported from one module and imported
 * elsewhere is the shared owner, and reporting it would make the signal exactly
 * backwards. Indented matches are only accepted at two spaces, so a definition
 * inside a `describe` body counts but a callback passed inline does not.
 */
export function repeatDefinitions(sources) {
  const defs = new Map();
  for (const src of sources) {
    if (!/\.(ts|tsx)$/.test(src.path)) continue;
    src.text.split("\n").forEach((line, i) => {
      if (/^\s*(?:export|declare)\b/.test(line)) return;
      for (const pattern of DEF_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        const name = match[1];
        if (!defs.has(name)) defs.set(name, []);
        defs.get(name).push({ path: src.path, line: i + 1 });
        return;
      }
    });
  }

  const repeats = new Map();
  const qualified = new Set();
  for (const [name, sites] of defs) {
    const files = [...new Set(sites.map((s) => s.path))];
    if (files.length < MIN_REPEAT_SITES) continue;
    qualified.add(name);
    if (name in CLOSURE_NAMES) continue;
    repeats.set(name, { name, sites, files });
  }
  return { repeats, qualified };
}

// ── Record ───────────────────────────────────────────────────────────────────

const EMPTY_RECORD = { clones: { verdicts: [], baseline: [] }, repeats: { verdicts: [], baseline: [] } };

export function loadRecord(path = RECORD_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return {
      clones: { verdicts: parsed.clones?.verdicts ?? [], baseline: parsed.clones?.baseline ?? [] },
      repeats: { verdicts: parsed.repeats?.verdicts ?? [], baseline: parsed.repeats?.baseline ?? [] },
    };
  } catch {
    return structuredClone(EMPTY_RECORD);
  }
}

/** `--emit`: re-baseline DOWNWARD only. New groups need a verdict entry first. */
export function buildRecord(actualClones, actualRepeats, previous) {
  const refused = [];
  const cloneVerdicts = new Map(previous.clones.verdicts.map((e) => [e.id, e]));
  const repeatVerdicts = new Map(previous.repeats.verdicts.map((e) => [e.name, e]));

  const cloneIds = [...actualClones.keys()].sort();
  const repeatNames = [...actualRepeats.keys()].sort();

  const cloneBaseline = [];
  for (const id of cloneIds) {
    if (cloneVerdicts.has(id)) continue;
    if (!previous.clones.baseline.includes(id)) {
      refused.push(`clone group ${id}`);
      continue;
    }
    cloneBaseline.push(id);
  }
  const repeatBaseline = [];
  for (const name of repeatNames) {
    if (repeatVerdicts.has(name)) continue;
    if (!previous.repeats.baseline.includes(name)) {
      refused.push(`repeated definition ${name}`);
      continue;
    }
    repeatBaseline.push(name);
  }

  // Numbers on a verdict entry follow the tree: a shrink is legitimate without
  // an edit, a growth is impossible to hide because the check compares them.
  const clones = [...cloneVerdicts.values()]
    .filter((entry) => actualClones.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      lines: actualClones.get(entry.id).lines,
      copies: actualClones.get(entry.id).copies,
      verdict: entry.verdict,
      reason: entry.reason,
    }));
  const repeats = [...repeatVerdicts.values()]
    .filter((entry) => actualRepeats.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      sites: actualRepeats.get(entry.name).sites.length,
      verdict: entry.verdict,
      reason: entry.reason,
    }));

  return {
    record: { clones: { verdicts: clones, baseline: cloneBaseline }, repeats: { verdicts: repeats, baseline: repeatBaseline } },
    refused,
  };
}

/** Failure strings; empty means the tree matches the record. */
export function checkGroups(actualClones, actualRepeats, record, qualifiedNames) {
  const failures = [];

  const cloneVerdicts = new Map(record.clones.verdicts.map((e) => [e.id, e]));
  const cloneBaseline = new Set(record.clones.baseline);

  for (const group of actualClones.values()) {
    const entry = cloneVerdicts.get(group.id);
    if (!entry && !cloneBaseline.has(group.id)) {
      const sites = group.occurrences.map((o) => `${o.path}:${o.line}`).join(", ");
      failures.push(
        `new clone group (${group.lines} lines x ${group.copies} copies): ${group.id} — at ${sites}. ` +
          `Consolidate it, or add a verdict entry to scripts/duplication-groups.json saying why the copy is permanent.`,
      );
      continue;
    }
    if (!entry) continue;
    const error = verdictFailure(entry.reason, entry.verdict);
    if (error) failures.push(`clone group ${group.id}: ${error}`);
    if (group.lines > entry.lines || group.copies > entry.copies) {
      failures.push(
        `clone group GREW: ${group.id} is now ${group.lines} lines x ${group.copies} copies, recorded as ${entry.lines} x ${entry.copies}. ` +
          `A ratchet only moves down: delete the extra copy, or change the verdict entry in the same change, deliberately.`,
      );
    }
  }
  for (const entry of record.clones.verdicts) {
    if (!actualClones.has(entry.id)) {
      failures.push(
        `stale clone verdict: ${entry.id} is no longer duplicated. Remove the entry in the same change that consolidated or deleted a copy.`,
      );
    }
  }
  const actualCloneIds = new Set(actualClones.keys());
  for (const id of record.clones.baseline) {
    if (!actualCloneIds.has(id)) {
      failures.push(`stale clone baseline entry: ${id} is no longer duplicated. Run \`--emit\` in the same change.`);
    }
  }

  const repeatVerdicts = new Map(record.repeats.verdicts.map((e) => [e.name, e]));
  const repeatBaseline = new Set(record.repeats.baseline);

  for (const repeat of actualRepeats.values()) {
    const entry = repeatVerdicts.get(repeat.name);
    if (!entry && !repeatBaseline.has(repeat.name)) {
      const sites = repeat.sites.map((s) => `${s.path}:${s.line}`).join(", ");
      failures.push(
        `new repeated local definition: \`${repeat.name}\` is defined in ${repeat.files.length} files — at ${sites}. ` +
          `Give it one owner, or add a verdict entry saying why each surface needs its own.`,
      );
      continue;
    }
    if (!entry) continue;
    const error = verdictFailure(entry.reason, entry.verdict);
    if (error) failures.push(`repeated definition ${repeat.name}: ${error}`);
    if (repeat.sites.length > entry.sites) {
      failures.push(
        `repeated definition GREW: \`${repeat.name}\` is now defined ${repeat.sites.length} times, recorded as ${entry.sites}.`,
      );
    }
  }
  for (const entry of record.repeats.verdicts) {
    if (!actualRepeats.has(entry.name)) {
      failures.push(
        `stale repeat verdict: \`${entry.name}\` is no longer defined in ${MIN_REPEAT_SITES} files. Remove the entry in the same change.`,
      );
    }
  }
  const actualRepeatNames = new Set(actualRepeats.keys());
  for (const name of record.repeats.baseline) {
    if (!actualRepeatNames.has(name)) {
      failures.push(`stale repeat baseline entry: \`${name}\` is no longer repeated. Run \`--emit\` in the same change.`);
    }
  }

  // The closure-name exclusion list is a claim about the tree: an entry whose
  // name no longer repeats anywhere is an exemption nobody revalidated. Tested
  // against the names that QUALIFIED before the exclusion, not after it, or every
  // entry would fail by construction.
  for (const name of Object.keys(CLOSURE_NAMES)) {
    if (qualifiedNames.has(name)) continue;
    failures.push(
      `stale closure-name exclusion: \`${name}\` no longer appears as a repeated definition. Remove it from CLOSURE_NAMES.`,
    );
  }

  return failures;
}

function verdictFailure(reason, verdict) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text === PLACEHOLDER) return `still carries the --emit placeholder reason. Write \`consolidate\` or \`justified\` and say why.`;
  if (text.length < MIN_REASON_LEN) return `has no usable reason (${text.length} chars, need ${MIN_REASON_LEN}).`;
  if (!VERDICTS.has(verdict)) return `has verdict ${JSON.stringify(verdict)}; expected one of ${[...VERDICTS].join(", ")}.`;
  return null;
}

// ── Report ───────────────────────────────────────────────────────────────────

export function renderReport({ clones, repeats, record }, { scannedFiles, scannedLines }) {
  const cloneVerdicts = new Map(record.clones.verdicts.map((e) => [e.id, e]));
  const repeatVerdicts = new Map(record.repeats.verdicts.map((e) => [e.name, e]));

  const cloneRows = [...clones.values()].sort(
    (a, b) => b.lines * b.copies - a.lines * a.copies || (a.id < b.id ? -1 : 1),
  );
  const repeatRows = [...repeats.values()].sort(
    (a, b) => b.sites.length - a.sites.length || (a.name < b.name ? -1 : 1),
  );
  const redundant = cloneRows.reduce((sum, g) => sum + g.lines * (g.copies - 1), 0);
  const owed =
    record.clones.verdicts.filter((e) => e.verdict === "consolidate").length +
    record.repeats.verdicts.filter((e) => e.verdict === "consolidate").length;

  const out = [];
  out.push("# Duplication roster");
  out.push("");
  out.push("<!-- Generated by `node scripts/check-duplication.mjs --emit`. Do not hand-edit. -->");
  out.push("");
  out.push(
    "The tree-level half of the `least-code` review dimension (myne-md/myne#995). A branch review reads a",
  );
  out.push(
    "DIFF, so it cannot see the copies that already shipped; this roster asks the same question about the",
  );
  out.push("tree. `scripts/check-duplication.mjs` is the gate and its header is the discipline.");
  out.push("");
  out.push(
    `Measured over ${scannedFiles} files / ${scannedLines} normalised lines in ${ROOTS.length} roots: ` +
      `${cloneRows.length} clone groups holding ${redundant} redundant lines, and ` +
      `${repeatRows.length} local definitions repeated across ${MIN_REPEAT_SITES}+ files. ` +
      `${owed} groups are recorded as owed work.`,
  );
  out.push("");
  out.push("A group may shrink freely and may not grow. `consolidate` is work a reader can pick up;");
  out.push("`justified` is permanent duplication and its reason says why; `unreviewed` is measured and");
  out.push("not yet examined, which is what `--emit` records and what a verdict entry replaces.");
  out.push("");
  out.push("## Clone groups");
  out.push("");
  out.push("| Lines | Copies | Verdict | Id | Sites |");
  out.push("|---|---|---|---|---|");
  for (const group of cloneRows) {
    const entry = cloneVerdicts.get(group.id);
    const sites = group.occurrences
      .slice(0, 4)
      .map((o) => `${o.path}:${o.line}`)
      .join("<br>");
    const more = group.occurrences.length > 4 ? `<br>+${group.occurrences.length - 4} more` : "";
    out.push(`| ${group.lines} | ${group.copies} | ${entry ? entry.verdict : "unreviewed"} | \`${group.id}\` | ${sites}${more} |`);
  }
  out.push("");
  out.push("## Repeated local definitions");
  out.push("");
  out.push("| Sites | Verdict | Name | Where |");
  out.push("|---|---|---|---|");
  for (const repeat of repeatRows) {
    const entry = repeatVerdicts.get(repeat.name);
    const files = repeat.files.slice(0, 3).map((f) => `\`${f}\``).join("<br>");
    const more = repeat.files.length > 3 ? `<br>+${repeat.files.length - 3} more` : "";
    out.push(`| ${repeat.sites.length} | ${entry ? entry.verdict : "unreviewed"} | \`${repeat.name}\` | ${files}${more} |`);
  }
  out.push("");

  const reasons = [
    ...record.clones.verdicts.filter((e) => e.verdict === "justified" && e.reason !== PLACEHOLDER).map((e) => [`\`${e.id}\``, e.reason]),
    ...record.repeats.verdicts
      .filter((e) => e.verdict === "justified" && e.reason !== PLACEHOLDER)
      .map((e) => [`\`${e.name}\``, e.reason]),
  ];
  if (reasons.length > 0) {
    out.push("## Why these are permanent");
    out.push("");
    for (const [id, reason] of reasons) out.push(`- ${id} — ${reason}`);
    out.push("");
  }
  const debt = [
    ...record.clones.verdicts.filter((e) => e.verdict === "consolidate").map((e) => `\`${e.id}\``),
    ...record.repeats.verdicts.filter((e) => e.verdict === "consolidate").map((e) => `\`${e.name}\``),
  ];
  if (debt.length > 0) {
    out.push("## Recorded as owed work");
    out.push("");
    for (const id of debt) out.push(`- ${id}`);
    out.push("");
  }
  return out.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function measure(root = ROOT) {
  const sources = readSources(root);
  const scannedLines = sources.reduce(
    (sum, src) => sum + normaliseSource(src.text, langOf(src.path)).length,
    0,
  );
  const { repeats, qualified } = repeatDefinitions(sources);
  return {
    clones: cloneGroups(sources),
    repeats,
    qualified,
    scannedFiles: sources.length,
    scannedLines,
  };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const mode = process.argv[2];
  const record = loadRecord();

  if (mode === "--emit" || mode === "--bootstrap") {
    const actual = measure();
    const previous =
      mode === "--bootstrap"
        ? structuredClone(EMPTY_RECORD)
        : record;
    const { record: next, refused } = buildRecord(actual.clones, actual.repeats, previous);
    if (mode === "--bootstrap") {
      next.clones.baseline = [...actual.clones.keys()].sort().filter((id) => !next.clones.verdicts.some((e) => e.id === id));
      next.repeats.baseline = [...actual.repeats.keys()].sort().filter((name) => !next.repeats.verdicts.some((e) => e.name === name));
    }
    if (refused.length > 0 && mode === "--emit") {
      console.log("duplication: --emit refused, a new group needs a verdict entry first:");
      for (const r of refused) console.log(`  - ${r}`);
      console.log("Consolidate each one, or add it to scripts/duplication-groups.json with a verdict and a reason.");
      process.exit(1);
    }
    writeFileSync(RECORD_PATH, JSON.stringify(next, null, 2) + "\n");
    // Exactly one trailing newline: `renderReport`'s last section already ends with a
    // blank separator line, and the repo's `whitespace` hook refuses a blank line at EOF,
    // so appending `"\n"` to it produced a file no commit could carry.
    writeFileSync(REPORT_PATH, `${renderReport({ ...actual, record: next }, actual).trimEnd()}\n`);
    console.log(
      `duplication: record + report written (${next.clones.baseline.length} clone baseline, ` +
        `${next.repeats.baseline.length} repeat baseline, ${next.clones.verdicts.length + next.repeats.verdicts.length} verdicts).`,
    );
  } else if (mode === "--list") {
    const { clones, repeats, qualified } = measure();
    for (const group of [...clones.values()].sort((a, b) => b.lines * b.copies - a.lines * a.copies)) {
      console.log(`${group.lines}\tx${group.copies}\t${group.id}`);
      for (const o of group.occurrences) console.log(`\t\t${o.path}:${o.line}`);
    }
    for (const repeat of [...repeats.values()].sort((a, b) => b.sites.length - a.sites.length)) {
      console.log(`repeat\tx${repeat.files.length}\t${repeat.name}`);
      for (const site of repeat.sites) console.log(`\t\t${site.path}:${site.line}`);
    }
    const excluded = [...qualified].filter((name) => name in CLOSURE_NAMES).sort();
    if (excluded.length > 0) console.log(`excluded closure names (${excluded.length}): ${excluded.join(", ")}`);
  } else {
    const actual = measure();
    const failures = checkGroups(actual.clones, actual.repeats, record, actual.qualified);
    // The report is a committed projection of the same measurement, checked the
    // way `check-twin-inventory.mjs` checks its own: a stale report describes a
    // tree nobody has, and regenerating it is one command.
    let reportStale = false;
    try {
      const expected = renderReport({ ...actual, record }, actual).trim();
      reportStale = readFileSync(REPORT_PATH, "utf-8").trim() !== expected;
    } catch {
      reportStale = true;
    }
    if (reportStale) failures.push("docs/dev/duplication.md is stale. Run `node scripts/check-duplication.mjs --emit`.");
    if (failures.length > 0) {
      console.log("duplication: FAILED");
      for (const failure of failures) console.log(`  - ${failure}`);
      process.exit(1);
    }
    console.log(
      `duplication: ok (${actual.clones.size} clone groups, ${actual.repeats.size} repeated definitions, none new or grown).`,
    );
  }
}
