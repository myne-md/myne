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
//   R2  no value interpolated INTO the message, at any level. A value in the
//       message is invisible to every field-name rule, and the message is what
//       a reader quotes.
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
//
// Zero dependencies, node built-ins only, matching the other guards here.
// Usage: `node scripts/check-tracing-discipline.mjs [--self-test]`.

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
];

/** The floor R3 pins. Measured, not guessed: see the guard's own test. */
export const MIN_INVOCATIONS = 400;

/**
 * Extract every `tracing::<level>!( ... )` invocation's argument text.
 *
 * The balanced-paren scan is blind to parens inside string literals, because a
 * log message may contain either and a naive counter mis-reads both. Only
 * `tracing::<ident>!(` counts, so a `tracing::Level::TRACE` path or a
 * doc-comment mention is not a call site.
 */
export function tracingInvocations(source) {
  const out = [];
  let rest = stripComments(source);
  while (true) {
    const at = rest.indexOf("tracing::");
    if (at < 0) break;
    const after = rest.slice(at + "tracing::".length);
    const identEnd = after.search(/[^A-Za-z0-9_]/);
    const ident = identEnd < 0 ? after : after.slice(0, identEnd);
    const tail = after.slice(identEnd < 0 ? after.length : identEnd);
    if (!tail.startsWith("!(")) {
      rest = after;
      continue;
    }
    const open = 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = open; i < tail.length; i += 1) {
      const c = tail[i];
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
    if (end < 0) break;
    out.push({ level: ident, args: tail.slice(open + 1, end) });
    rest = tail.slice(end);
  }
  return out;
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

/** The field name a `%`-formatted argument belongs to, or `null`. */
export function displayField(arg) {
  const at = arg.indexOf("%");
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
 * Lint one source, returning its findings.
 *
 * Pure over `(path, text)` so the guard's own test can drive it with fixtures
 * rather than with the tree, and so a finding names the file the way a reader
 * greps for it.
 */
export function lintSource(path, text) {
  const findings = [];
  for (const invocation of tracingInvocations(text)) {
    // R2, at every level. Interpolation in `tracing` looks like `format!`:
    // `info!("opening {}", path)` puts the value in the MESSAGE, where no field
    // rule can see it and where a reader quotes it. The signal is a format
    // placeholder inside a string literal, which is what makes this rule
    // precise rather than a ban on bare identifiers (a bare identifier is
    // `tracing`'s field shorthand, `info!(detail)`, and this tree uses it 111
    // times).
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
      if (arg.includes("=")) continue;
      if (SHORTHAND.test(arg)) continue;
      findings.push({
        path,
        rule: "R2",
        message: `an argument that is neither the message, a \`field = value\`, nor a field shorthand: "${arg}"`,
      });
    }
    if (!RECORDED_LEVELS.includes(invocation.level)) continue;
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
      `${EXCEPTIONS.length} recorded exception(s))`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
