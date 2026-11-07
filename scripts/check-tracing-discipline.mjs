#!/usr/bin/env node
// The diagnostic log's content claim, machine-checked (myne-md/myne#860).
//
// # The claim, and why review alone was not enough
//
// `docs/threat-model.md` §7 states that the opt-in diagnostic log holds usage
// metadata and never note content, a note id, a path, an account hash, key
// material, a salt or a nonce. A claim in that document that no test holds can
// rot silently, and the DENY list in `src-tauri/AGENTS.md` says about itself
// that it is "reviewer-enforced; no automated lint". So the moment the sink
// moved from a terminal nobody reads to A FILE THE USER IS INVITED TO SEND ON,
// the discipline had to become a mechanism.
//
// # What is checked, and the level scoping is deliberate
//
// The file layer records `info` and above with its own fixed floor and ignores
// `RUST_LOG` entirely (`src-tauri/src/logging`), so a `%` Display formatter
// below `info` cannot reach disk. This guard therefore enforces the FILE's
// content claim exactly:
//
//   R1  no `%` Display formatter in a `tracing` call at `info`, `warn` or
//       `error`, unless the site carries a recorded reason. `%` is the shape
//       that reaches a record with no field name a rule could inspect, and it
//       is how an unbounded `Display` (an `io::Error`, a path-holding `String`,
//       a candle error wrapping `WithPath`) would arrive.
//
//       **The level set is per path, because the FILE's is.**
//       `src-tauri/src/logging` records one target below `info`
//       (`DEBUG_FILE_TARGETS`, `myne_core::agent`, `design-notes/ops/0768`),
//       so `debug` is a recorded level for the module that target belongs to and
//       for nothing else. Reading the levels from a single global list would
//       leave the one module whose `debug` reaches disk as the one module R1 does
//       not read, which is the hole inverted rather than closed.
//       `RECORDED_DEBUG_ROOTS` is the mirror of that const and the two are the
//       same list in two places by necessity: one decides what persists, the
//       other decides what is read from `core/src`, and neither can see the
//       other's tree.
//   R2  no unbounded value in a `tracing` call, at any level, in either of the
//       two shapes that reach a record under no field name a rule can inspect.
//       One is a value interpolated INTO the message (`info!("opening {}",
//       path)`), and the message is what a reader quotes. The other is a field
//       VALUE built by `format!`, `concat!`, `.to_string()`, `.to_owned()` or
//       `String::from`, a fresh string no rule can bound, which could carry a
//       path or a note title into a file the user is invited to publish. A
//       string literal, a `%` Display value or a `?` Debug value is accepted.
//   R3  a non-vacuity floor, because an extractor that matches nothing passes
//       silently, which is the one failure a guard like this cannot notice about
//       itself.
//
// # What it deliberately does NOT check, stated rather than implied
//
// - **`?` Debug formatting is not banned.** The `%` rule is sharp because `%`
//   is a closed syntactic shape; `?kind` on a closed enum is the SANCTIONED
//   pattern in `src-tauri/AGENTS.md`, and an allowlist of `?` value
//   expressions would be hundreds of entries of local binding names, i.e. a
//   second copy of the tree that rots. What keeps `?` honest is the closed-enum
//   mapping rule, review-enforced, plus the audit the feature's PRD records: no
//   site applies `?`/`%` to a raw `io::Error`, a path-holding `String` or any
//   DENY-listed type.
// - **A field NAME is not held to an allowlist.** The vocabulary is 111 names,
//   and a blanket allowlist would fail on the tree today. Honest scope beats a
//   fake-precise rule: this guard catches the shape that carries an unbounded
//   value, and a new field carrying a new secret class still needs a reviewer.
// - **`println!` / `eprintln!` / `dbg!` are not checked here.** They bypass
//   `tracing` and so bypass the file layer too, which is why they are a
//   separate concern with a separate check in
//   `src-tauri/src/cli_bridge/logging_discipline.rs` for the directory where a
//   path is actually handled.
// - **A macro reached through a crate rename or a re-export is not resolved.**
//   A direct alias (`use tracing::info as log_info;`, single or braced) is read,
//   because it is the same call site under a different name. Two shapes are not,
//   and neither appears in this tree: `use tracing as t;` followed by
//   `t::info!(%path)`, and `use crate::log::info;` followed by `info!(%path)` in
//   a file with no `use tracing` of its own. Resolving either would mean
//   tracking a module graph rather than reading a `use` statement.
//
// Zero dependencies, node built-ins only, matching the other guards here.
// Usage: `node scripts/check-tracing-discipline.mjs`.
//
// There is no `--self-test` flag here on purpose. The injected-defect evidence
// is the suite in `tests/scripts/tracingDiscipline.test.ts`, which drives
// `lintSource`, `scan` and the stale arm with fixtures and runs in `pnpm test`
// (and in CI's `vitest` step). A second copy of those fixtures inside this file
// would be a list that rots, which is the failure the stale-exception rule
// below exists to name.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The crates that ship in the desktop binary. */
export const SCANNED_ROOTS = [
  "core/src",
  "src-tauri/src",
  "format/src",
  "protocol/src",
  "cli/src",
  "tor-sidecar/src",
];

/** The levels the file layer records, i.e. `LevelFilter::INFO` and above. */
export const RECORDED_LEVELS = ["info", "warn", "error"];

/**
 * The directories whose `debug` records reach the file, mirroring
 * `DEBUG_FILE_TARGETS` in `src-tauri/src/logging`.
 *
 * A root rather than a target name because this guard reads source, and the
 * source it reads is organised by module: every `debug!` under
 * `core/src/plugins/agent/` carries the target that const admits, and a target
 * name here would have to be re-derived from a `target:` literal at each call
 * site, where the value comes from the macro's default instead. The direction of
 * the safety is what matters: a root listed here that no longer reaches the file
 * makes the guard STRICTER than the sink, which costs an exception entry; the
 * reverse (a sink widened without this list) is the leak, and it is what the two
 * places being adjacent in two files is meant to make hard to miss.
 */
export const RECORDED_DEBUG_ROOTS = ["core/src/plugins/agent/"];

/** The levels whose records reach the file for this path. */
export function recordedLevelsFor(path) {
  return RECORDED_DEBUG_ROOTS.some((root) => path.startsWith(root))
    ? [...RECORDED_LEVELS, "debug"]
    : RECORDED_LEVELS;
}

/**
 * Recorded `%` sites at a recorded level, each with the reason it is bounded.
 *
 * Keyed by file, level and FIELD rather than by line, because a line number in
 * a record like this is a number that goes stale on the next edit above it (and
 * `AGENTS.md` already records a guard whose stale entries outlived their
 * subject). A site that stops matching its entry fails as stale, so the list
 * cannot outlive the fact it describes.
 */
export const EXCEPTIONS = [
  {
    file: "core/src/plugins/prefs/commands.rs",
    level: "info",
    field: "entry",
    reason:
      "an ASCII-lowercase grammar token validated against the closed period vocabulary before the write, not user text; the site's own comment carries the argument, and the VALUE (a folder path) is never logged",
  },
  {
    file: "core/src/plugins/sync/engine.rs",
    level: "warn",
    field: "signer",
    reason:
      "the 16-byte author slot of a signed head, rendered by this site from a fixed-size array as exactly 32 lowercase hex characters or the literal `unknown`, so the only input that can lengthen it is a compile-time constant; it is the ONE datum an unresolved-signer wedge needs and no closed enum can carry it (myne-md/myne#1032)",
  },
  {
    file: "core/src/plugins/agent/host_commands.rs",
    level: "error",
    field: "reason",
    reason:
      "a parse error over a compile-time `include_str!` constant, so it can only name a JSON key or a type mismatch and never a path or user data; the field was removed in this change and restored because it was the only classification that arm carried",
  },
];

/** The floor R3 pins. Measured, not guessed: see the guard's own test. */
export const MIN_INVOCATIONS = 400;

/**
 * The macros a `tracing` call site may spell, qualified or bare.
 *
 * A bare name counts only in a file that also imports from `tracing`, because
 * that import is what makes the name refer to this crate. A direct alias
 * (`use tracing::info as log_info;`) joins these names; see
 * `tracingMacroAliases`.
 */
export const TRACING_MACROS = ["trace", "debug", "info", "warn", "error"];

/**
 * The macro each `use tracing::<name> as <alias>` binds an identifier to.
 *
 * The widened extractor admitted a bare macro name only when it was one of the
 * five level names, so `use tracing::info as log_info;` followed by
 * `log_info!(%path)` read as zero invocations and zero findings, the same hole
 * the bare-spelling widening closed one name over (myne#860 review). An alias
 * is that call site under a different name, so it is read the same way, and it
 * carries the name it aliases so `info` under an alias still counts as the
 * level the file layer records rather than as an unknown one.
 *
 * The two shapes are a single rename (`use tracing::info as log_info;`) and the
 * braced form (`use tracing::{info as log_info, warn as log_warn};`). Both are
 * read from `code`, i.e. after comments are stripped, so an alias named in a
 * comment does not widen the scan.
 */
export function tracingMacroAliases(code) {
  const aliases = new Map();
  for (const match of code.matchAll(
    /use\s+tracing\s*::\s*([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/g,
  )) {
    aliases.set(match[2], match[1]);
  }
  for (const match of code.matchAll(/use\s+tracing\s*::\s*\{([^}]*)\}/g)) {
    for (const item of match[1].split(",")) {
      const alias = item.match(/^\s*([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)\s*$/);
      if (alias) aliases.set(alias[2], alias[1]);
    }
  }
  return aliases;
}

/**
 * Extract every `tracing::<level>!( ... )` and every bare `<level>!( ... )`
 * invocation's argument text.
 *
 * **Both spellings, and the bare half is not optional.** `use tracing::info;`
 * followed by `info!(%path)` is the idiomatic form, and a qualified-only scan
 * was blind to it: R1, R2 and the R3 floor all read zero invocations for such a
 * file, so a call site could carry a `%` path into the log the user is invited
 * to publish while this guard reported ok (myne#860 adversarial review). A bare
 * name is admitted when the same file imports from `tracing`, under its own
 * name or under a direct alias (`use tracing::info as log_info;`, and the
 * braced form), which is what makes the identifier refer to this crate rather
 * than to some other macro. A crate rename and a re-export are not read; the
 * limits list in the header names why.
 *
 * The balanced-paren scan is blind to parens inside string literals, because a
 * log message may contain either and a naive counter mis-reads both. Only a
 * macro invocation counts, so a `tracing::Level::TRACE` path or a doc-comment
 * mention is not a call site.
 */
export function tracingInvocations(source) {
  const code = stripComments(source);
  const importsTracing = /use\s+tracing\s*::/.test(code);
  // `!(` rather than `!`, so a macro NAME inside a string literal (this tree's
  // own tests quote `tracing::warn!` as data) is not read as a call site.
  const patterns = [/\btracing::([A-Za-z0-9_]+)!\(/g];
  if (importsTracing) patterns.push(/(?<![A-Za-z0-9_:.])([A-Za-z0-9_]+)!\(/g);
  const aliases = tracingMacroAliases(code);
  const bareNames = new Set([...TRACING_MACROS, ...aliases.keys()]);

  const sites = [];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of code.matchAll(pattern)) {
      const ident = match[1];
      // Qualified calls admit any identifier, as before, so a `tracing::event!`
      // or a re-exported macro is still read. Bare ones are restricted to the
      // five level macros and the aliases this file binds to them, or every
      // `assert!(` in an importing file would be scanned as a log record.
      if (index > 0 && !bareNames.has(ident)) continue;
      // An alias reports the macro it aliases, so `info` under an alias is
      // still the level the file layer records rather than an unknown name.
      const level = index > 0 ? aliases.get(ident) ?? ident : ident;
      // `match[0]` ends at the macro name and its `!`, so this is the `(`.
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = open; i < code.length; i += 1) {
        const c = code[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (inString) {
          if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') inString = true;
        else if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) continue;
      sites.push({ at: match.index, level, args: code.slice(open + 1, end) });
    }
  }
  // Source order, so a finding's line number reads the way the file does. The
  // two patterns each walk the whole file, which is why the sort is not
  // cosmetic.
  sites.sort((a, b) => a.at - b.at);
  return sites.map(({ level, args }) => ({ level, args }));
}

/**
 * Blank out line comments and block comments.
 *
 * A guard that reads comments is a guard that fails on the sentence explaining
 * it, and this tree's comments mention tracing call sites constantly.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Split an invocation's arguments on top-level commas. */
export function topLevelArgs(args) {
  const out = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i];
    if (inString) {
      current += c;
      if (c === "\\") {
        current += args[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/**
 * Split a `field = value` argument at its top-level `=`, or `null`.
 *
 * Top-level means outside string literals and brackets, and `==`, `!=`, `<=`,
 * `>=` and `=>` are not a field assignment. The value half is what R2 lints for
 * an unbounded shape; the field half names it in the finding.
 */
export function splitFieldAssign(arg) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < arg.length; i += 1) {
    const c = arg[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "=" && depth === 0) {
      const prev = arg[i - 1];
      const next = arg[i + 1];
      if (prev === "=" || prev === "!" || prev === "<" || prev === ">") continue;
      if (next === "=" || next === ">") continue;
      return { field: arg.slice(0, i).trim(), value: arg.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * The index of the `'` that closes a char literal opening at `open`, or `-1`
 * when that `'` opens a lifetime instead.
 *
 * A lifetime (`&'static str`) begins with the same character, so the two are
 * told apart by looking for the closing quote: `'%'` closes one character
 * later, while `'static` does not close at all.
 */
function charLiteralClose(arg, open) {
  let i = open + 1;
  if (arg[i] === "\\") {
    // An escape: `'\''`, `'\n'`, `'\x41'`, `'\u{25}'`. Past the backslash and
    // the character it escapes, the extras in the longer forms are never a
    // quote, so walking to the next `'` finds the close in every case.
    i += 2;
    while (i < arg.length) {
      if (arg[i] === "'") return i;
      i += 1;
    }
    return -1;
  }
  return arg[i + 1] === "'" ? i + 1 : -1;
}

/**
 * The index of the first `%` outside a string or char literal, or `-1`.
 *
 * The first revision read the first `%` ANYWHERE in the argument, so a message
 * containing a percent sign ("50% of the file was read") was read as a Display
 * formatter and R1 fired naming a fragment of that literal as the field, whose
 * only offered remedy was an EXCEPTIONS entry the stale arm then compares by
 * name. A percent sign inside a literal is not a formatter, which is the same
 * reason `splitFieldAssign` finds its `=` at the top level rather than by
 * `indexOf`.
 */
function formatterIndex(arg) {
  let inString = false;
  for (let i = 0; i < arg.length; i += 1) {
    const c = arg[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "'") {
      const close = charLiteralClose(arg, i);
      if (close >= 0) {
        i = close;
        continue;
      }
    }
    if (c === "%") return i;
  }
  return -1;
}

/** The field name a `%`-formatted argument belongs to, or `null`. */
export function displayField(arg) {
  const at = formatterIndex(arg);
  if (at < 0) return null;
  const before = arg.slice(0, at).trim();
  const eq = before.lastIndexOf("=");
  if (eq < 0) return before.length > 0 ? before : "(shorthand)";
  return before.slice(0, eq).trim();
}

/**
 * The meta fields `tracing`'s macros accept, which are neither a value nor a
 * message: `target: "myne::ai"` names the event's target, not user data.
 */
const META_FIELDS = /^(target|level|name)\s*:/;

/** A field shorthand: a bare identifier, or `%value` / `?value`. */
const SHORTHAND = /^[%?]?[A-Za-z_][A-Za-z0-9_:.]*$/;

/** A format placeholder inside a string literal, i.e. interpolation. */
const PLACEHOLDER = /\{(?!\{)[^}]*\}/;

/**
 * A field VALUE that builds an unbounded string, i.e. a fresh string no
 * field-name rule can bound. `format!` and `concat!` are the constructors,
 * `String::from` the constructor call, and `.to_string()` / `.to_owned()` the
 * conversions. The rule is deliberately this narrow: a string literal, a `%`
 * Display value and a `?` Debug value are all accepted, and so is any other
 * expression, because this guard catches the shape that produces a value
 * rather than holding every field expression to an allowlist.
 */
const UNBOUNDED_FIELD_VALUE =
  /(?:^|[^A-Za-z0-9_])(?:format!|concat!|String\s*::\s*from)\s*\(|\.\s*to_string\s*\(\s*\)|\.\s*to_owned\s*\(\s*\)/;

/**
 * Lint one source, returning its findings.
 *
 * Pure over `(path, text)` so the guard's own test can drive it with fixtures
 * rather than with the tree, and so a finding names the file the way a reader
 * greps for it.
 */
export function lintSource(path, text) {
  const findings = [];
  for (const invocation of tracingInvocations(text)) {
    // R2, at every level, in both of its shapes. (1) Interpolation in
    // `tracing` looks like `format!`: `info!("opening {}", path)` puts the value
    // in the MESSAGE, where no field rule can see it and where a reader quotes
    // it. The signal is a format placeholder inside a string literal, which is
    // what makes this rule precise rather than a ban on bare identifiers (a
    // bare identifier is `tracing`'s field shorthand, `info!(detail)`, and this
    // tree uses it 111 times). (2) A field VALUE built by `format!`, `concat!`,
    // `.to_string()`, `.to_owned()` or `String::from` is the same problem one
    // step to the right: the resulting string has no bound a rule can inspect.
    // The `=` split below is what reaches the value half of `field = value`.
    for (const arg of topLevelArgs(invocation.args)) {
      if (META_FIELDS.test(arg)) continue;
      if (arg.startsWith('"')) {
        if (PLACEHOLDER.test(arg)) {
          findings.push({
            path,
            rule: "R2",
            message: `a format placeholder in the message (${arg}), which interpolates a value where no field rule can inspect it`,
          });
        }
        continue;
      }
      const assignment = splitFieldAssign(arg);
      if (assignment !== null) {
        if (UNBOUNDED_FIELD_VALUE.test(assignment.value)) {
          findings.push({
            path,
            rule: "R2",
            message:
              `a field value that builds an unbounded string (\`${assignment.field} = ` +
              `${assignment.value}\`), which no field-name rule can bound. Log a literal, ` +
              `a \`%\` Display value or a \`?\` Debug value instead.`,
          });
        }
        continue;
      }
      if (arg.includes("=")) continue;
      if (SHORTHAND.test(arg)) continue;
      findings.push({
        path,
        rule: "R2",
        message: `an argument that is neither the message, a \`field = value\`, nor a field shorthand: "${arg}"`,
      });
    }
    if (!recordedLevelsFor(path).includes(invocation.level)) continue;
    // R1: a `%` Display formatter at a level the file records.
    for (const arg of topLevelArgs(invocation.args)) {
      const field = displayField(arg);
      if (field === null) continue;
      const excused = EXCEPTIONS.some(
        (e) => e.file === path && e.level === invocation.level && e.field === field,
      );
      if (excused) continue;
      findings.push({
        path,
        rule: "R1",
        message:
          `\`%\` Display formatting on field \`${field}\` at ${invocation.level} ` +
          `("${arg}"). The log records this level, and a Display value has no bound ` +
          `any rule can see. Reduce it to a closed enum or a &'static str label first, ` +
          `or record it in EXCEPTIONS with the reason it is bounded.`,
      });
    }
  }
  return findings;
}

/** Every `.rs` file under the scanned roots. */
export function rustFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (path.includes("/target/") || path.includes("/.git/")) continue;
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(path);
      else if (path.endsWith(".rs")) out.push(path);
    }
  };
  for (const scanned of SCANNED_ROOTS) walk(join(root, scanned));
  return out.sort();
}

/**
 * Recorded exceptions whose site is gone, or whose file has moved.
 *
 * Split out and given a `list` parameter so the guard's own test can inject a
 * stale entry: a list that cannot outlive the fact it describes is the property
 * `AGENTS.md` records `check-ipc-binding-callers.mjs`'s seeding path as having
 * broken (every entry there said its reason was missing, and the guard passed).
 */
export function staleExceptions(root = ROOT, list = EXCEPTIONS) {
  const findings = [];
  for (const exception of list) {
    const absolute = join(root, exception.file);
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      findings.push({
        path: exception.file,
        rule: "R1",
        message: `recorded exception for field \`${exception.field}\` names a file that does not exist`,
      });
      continue;
    }
    const stillThere = tracingInvocations(text).some(
      (inv) =>
        inv.level === exception.level &&
        topLevelArgs(inv.args).some((arg) => displayField(arg) === exception.field),
    );
    if (!stillThere) {
      findings.push({
        path: exception.file,
        rule: "R1",
        message: `recorded exception for field \`${exception.field}\` at ${exception.level} is stale: the site is gone`,
      });
    }
  }
  return findings;
}

/** The whole-tree scan, returning findings and the invocation count for R3. */
export function scan(root = ROOT) {
  const findings = [];
  let invocations = 0;
  for (const absolute of rustFiles(root)) {
    const path = relative(root, absolute);
    const text = readFileSync(absolute, "utf8");
    invocations += tracingInvocations(text).length;
    findings.push(...lintSource(path, text));
  }
  findings.push(...staleExceptions(root));
  return { findings, invocations };
}

function main() {
  const { findings, invocations } = scan(ROOT);
  if (findings.length > 0) {
    console.error(`tracing-discipline: ${findings.length} finding(s)`);
    for (const finding of findings) {
      console.error(`  ${finding.rule} ${finding.path}: ${finding.message}`);
    }
    process.exit(1);
  }
  if (invocations < MIN_INVOCATIONS) {
    console.error(
      `tracing-discipline: only ${invocations} tracing call sites found, floor is ` +
        `${MIN_INVOCATIONS}. The extractor or the scanned roots are broken, and a scan ` +
        `that matches nothing passes silently.`,
    );
    process.exit(1);
  }
  console.log(
    `tracing-discipline: ok (${invocations} tracing call site(s) across ${SCANNED_ROOTS.length} root(s); ` +
      `${RECORDED_LEVELS.join("/")} carry no unreasoned % formatter, no message interpolation; ` +
      `debug is held to the same rule in ${RECORDED_DEBUG_ROOTS.length} module(s); ` +
      `${EXCEPTIONS.length} recorded exception(s))`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
