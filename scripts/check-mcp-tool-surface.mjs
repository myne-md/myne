#!/usr/bin/env node
// The compiled MCP tool surface holds no outbound capability
// (external-mcp-connection, myne-md/myne#923).
//
// The rule this enforces is the load-bearing one in the feature's PRD: **no
// outbound tool, ever.** No fetch, no HTTP, no URL dereference, no mail, no
// shell, no process, no clipboard read. The moment Myne
// ships a tool that reaches outside the vault, Myne assembles all three legs of
// the lethal trifecta itself (private data, untrusted content, an outbound path)
// and becomes the exfiltration path rather than the data source.
//
// `mcp/src/tools_test.rs` already asserts this from inside the build. That is not
// enough on its own, for the reason this repository keeps stating: a check that
// only runs when somebody runs `cargo test` is a check that did not run. This is
// the same question asked from outside the build, in the guard set that runs on
// every commit and in CI.
//
// ## What it reads, and why that is "the compiled list"
//
// `mcp/src/tool_list.rs` is the declaration: a `vec![json!({…})]` over string
// literals and nothing else. This guard parses THAT FILE rather than a document
// about it, and it fails if the file stops being a constant expression (see
// `FORBIDDEN_CONSTRUCTION` below), so "the list is compiled in and never
// generated" is checked rather than assumed. Parsing prose that describes the
// tools would be the failure mode this exists to prevent.
//
// ## The two rosters are compared, not restated
//
// The tool names are held twice: this guard's `EXPECTED_TOOLS` and
// `tools_test.rs`'s own `EXPECTED_TOOLS`. They are compared in BOTH directions,
// so a tenth verb fails here until both are edited, and the guard is what makes
// the deliberate act of widening the surface traceable to a diff that says so.
// The capability vocabulary has ONE home (`tools_test.rs`), parsed here, because
// a second copy would be a second place for it to drift.
//
// Zero dependencies, hand-runnable:
//   node scripts/check-mcp-tool-surface.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => {
  try {
    return readFileSync(join(repoRoot, rel), "utf8");
  } catch {
    console.error(
      `check-mcp-tool-surface: cannot read ${rel}. The declaration moved or was renamed; ` +
        `this guard reads the list ITSELF, so it must be told where the list now lives.`,
    );
    process.exit(1);
  }
};

const TOOL_LIST_FILE = "mcp/src/tool_list.rs";
// The core crate keeps its own copy of the catalog names so Settings can render one
// switch per verb, and that copy is what the switch bank reads. A tenth verb added
// to the catalog and not here would leave nine switches and no way to switch it off.
const CATALOG_VERBS_FILE = "core/src/plugins/mcp/tools.rs";
const TOOLS_TEST_FILE = "mcp/src/tools_test.rs";

/// Written out here on purpose rather than derived from the file under test. A
/// roster compared against a second copy of itself cannot fail on the drift it
/// exists for, so this is a literal that a tenth verb has to edit twice.
const EXPECTED_TOOLS = [
  "note_search",
  "note_read",
  "vault_list",
  "vault_state",
  "note_create",
  "note_append",
  "note_move",
  "note_edit",
  // Four reads joined in myne-md/myne#1077: a file's extracted text, the calendar,
  // and the saved views. None of them fetches, and none of them takes a path; the
  // id-only rule below checks the second half structurally.
  "attachment_list",
  "attachment_read",
  "calendar_read",
  "view_list",
];

/**
 * The nouns this surface is allowed to point at, each one owned by the vault: a
 * note, the vault itself, an attached file, the calendar derived from note
 * frontmatter, a saved view. A new noun is a decision rather than a naming
 * preference, because the namespace is what a reader trusts when they read a tool
 * name in a model's transcript.
 */
const VAULT_NAMESPACES = ["note", "vault", "attachment", "calendar", "view"];

/**
 * The argument names that would mean a filesystem path or a network address, and
 * there is deliberately **no allowlist beside them**.
 *
 * Every verb here takes ids and vault folder names. An id was resolved inside the
 * grant by the host; a folder name is a vault noun the grant clamps. A `path`, a
 * `file`, a `url` is neither: it is whatever the caller typed, which is how a tool
 * reads something the user never approved. So the rule is absolute, and a verb that
 * genuinely needs one is a decision that adds a rule here rather than an entry.
 *
 * (`folder` is NOT in this list on purpose. It looks like a path and is not one:
 * the host canonicalises it and refuses it unless the grant covers it, which is
 * what makes `note_search`'s and `note_move`'s folder arguments safe.)
 */
const PATH_SHAPED = ["path", "file", "file_path", "filepath", "url", "uri", "href", "src"];

/// Constructs that would make the list something other than a constant
/// expression. Each one is a way for text this guard never sees to reach a tool
/// description, which is the injection path the compiled-in rule closes: a note
/// that could contribute to a description would influence every future call.
const FORBIDDEN_CONSTRUCTION = [
  { pattern: /\bformat!|\bformat_args!/, what: "format! (a description built at runtime)" },
  { pattern: /\bconcat!/, what: "concat! (a description assembled from parts)" },
  { pattern: /\binclude_str!|\binclude_bytes!/, what: "include_str!/include_bytes! (content from disk)" },
  { pattern: /\b(?:std::)?env!|\boption_env!|\bstd::env\b/, what: "env!/std::env (content from the environment)" },
  { pattern: /\.to_string\(\)|String::from\(|\.replace\(|\.join\(/, what: "a string method that rewrites a literal" },
];

/// The least number of capability words `tools_test.rs` may declare. A floor
/// rather than a count: it exists so emptying the vocabulary, which would make
/// this guard green while checking nothing, fails instead.
const MIN_CAPABILITIES = 12;

const failures = [];
const fail = (message) => failures.push(message);

/**
 * Remove Rust comments while preserving string literals, so a `//` inside a
 * description survives and a word in a doc comment does not become evidence.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += source.slice(start, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every string literal in a comment-stripped Rust source. */
function stringLiterals(source) {
  const found = [];
  // `[\s\S]` rather than `.`: a Rust string literal continues across lines with a
  // trailing backslash, and `.` matches no newline, so the naive form stopped at
  // the first continuation and left the rest of the description unscanned. That
  // defect was measured: a `web` planted after a continuation did not fire.
  const re = /"(?:[^"\\]|\\[\s\S])*"/g;
  for (const match of source.matchAll(re)) {
    found.push(match[0].slice(1, -1));
  }
  return found;
}

/** Split text into lower-cased whole words, the same rule `tools_test.rs` uses. */
function words(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Pull `CATALOG_VERBS` out of the core crate's tools module. */
function declaredCatalogVerbs(source) {
  const match = source.match(/pub const CATALOG_VERBS\s*:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Pull `EXPECTED_TOOLS` out of `tools_test.rs`. */
function declaredToolRoster(source) {
  const match = source.match(/const\s+EXPECTED_TOOLS\s*:\s*\[\s*&str\s*;\s*\d+\s*\]\s*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    fail(`${TOOLS_TEST_FILE}: could not find \`const EXPECTED_TOOLS: [&str; N] = […]\` — did it get renamed?`);
    return null;
  }
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Pull `NON_VAULT_CAPABILITIES` out of `tools_test.rs`. */
function declaredCapabilities(source) {
  const match = source.match(
    /const\s+NON_VAULT_CAPABILITIES\s*:\s*\[\s*&str\s*;\s*\d+\s*\]\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!match) {
    fail(`${TOOLS_TEST_FILE}: could not find \`const NON_VAULT_CAPABILITIES: [&str; N] = […]\` — did it get renamed?`);
    return null;
  }
  const capabilities = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1].toLowerCase());
  if (capabilities.length < MIN_CAPABILITIES) {
    fail(
      `${TOOLS_TEST_FILE}: NON_VAULT_CAPABILITIES declares ${capabilities.length} word(s), ` +
        `under the floor of ${MIN_CAPABILITIES}. Emptying the vocabulary would make this guard ` +
        `green while checking nothing.`,
    );
  }
  return capabilities;
}

// ── the list must be a constant expression ──────────────────────────────────

const toolListSource = read(TOOL_LIST_FILE);
const toolList = stripComments(toolListSource);

for (const { pattern, what } of FORBIDDEN_CONSTRUCTION) {
  if (pattern.test(toolList)) {
    fail(
      `${TOOL_LIST_FILE}: contains ${what}. The tool list must be a constant expression ` +
        `over string literals: a description this guard cannot read is a description a note ` +
        `could contribute to.`,
    );
  }
}

// ── the arguments ───────────────────────────────────────────────────────────
//
// A path argument is the outbound primitive in disguise: an id was resolved inside
// the grant, and a path is whatever the caller typed. So every tool's schema is
// read here and every property name is checked against the one allowlist above,
// rather than trusting the descriptions to have been written carefully.

/** The `inputSchema` object of each tool, by tool name, brace-matched. */
function schemasByName(source) {
  const out = new Map();
  const marker = /"name"\s*:\s*"([^"]*)"/g;
  let match;
  while ((match = marker.exec(source)) !== null) {
    const name = match[1];
    const from = source.indexOf('"inputSchema"', match.index);
    if (from < 0) continue;
    const open = source.indexOf("{", from);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.set(name, source.slice(open, end + 1));
  }
  return out;
}

/** The property names a schema declares, at the top level of `properties`. */
function propertyNames(schema) {
  const at = schema.indexOf('"properties"');
  if (at < 0) return [];
  const open = schema.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < schema.length; i += 1) {
    if (schema[i] === "{") depth += 1;
    else if (schema[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = schema.slice(open + 1, end);
  // Only the names at depth 1 of the properties object: a nested object's own keys
  // are not arguments of the tool.
  const names = [];
  let nested = 0;
  const tokens = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:|[{}]/g;
  let token;
  while ((token = tokens.exec(body)) !== null) {
    if (token[0] === "{") nested += 1;
    else if (token[0] === "}") nested -= 1;
    else if (nested === 0 && token[1]) names.push(token[1]);
  }
  return names;
}

for (const [name, schema] of schemasByName(toolList)) {
  for (const property of propertyNames(schema)) {
    if (!PATH_SHAPED.includes(property)) continue;
    fail(
      `${TOOL_LIST_FILE}: \`${name}\` declares a \`${property}\` argument, which is the one ` +
        `argument shape that can name something outside the vault. A verb reads a file by id; ` +
        `a verb that needs a path is a decision that adds a rule here, not an exception.`,
    );
  }
}

// ── the names ───────────────────────────────────────────────────────────────

const names = [...toolList.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
const uniqueNames = [...new Set(names)];

if (names.length !== uniqueNames.length) {
  fail(`${TOOL_LIST_FILE}: a tool name is declared twice (${names.length} entries, ${uniqueNames.length} distinct)`);
}

if (uniqueNames.length !== EXPECTED_TOOLS.length) {
  fail(
    `${TOOL_LIST_FILE}: ${uniqueNames.length} tool(s) declared, ${EXPECTED_TOOLS.length} expected. ` +
      `Nine is a ceiling, not a starting point: widening the surface is a decision that edits ` +
      `this guard's roster and tools_test.rs together.`,
  );
}

for (const name of uniqueNames) {
  if (!EXPECTED_TOOLS.includes(name)) {
    fail(
      `${TOOL_LIST_FILE}: \`${name}\` is not in the expected surface. If it is genuinely a new ` +
        `verb, add it to EXPECTED_TOOLS here AND in ${TOOLS_TEST_FILE}.`,
    );
  }
  const namespace = name.split("_")[0];
  if (!VAULT_NAMESPACES.includes(namespace) || !/^[a-z][a-z_]*$/.test(name)) {
    fail(
      `${TOOL_LIST_FILE}: \`${name}\` is outside the vault's own nouns ` +
        `(${VAULT_NAMESPACES.join("/")}), which is the only place this surface may point.`,
    );
  }
}

for (const name of EXPECTED_TOOLS) {
  if (!uniqueNames.includes(name)) {
    fail(`${TOOL_LIST_FILE}: expected tool \`${name}\` is declared by the expected surface but missing from the list`);
  }
}

// ── the two rosters have to agree ───────────────────────────────────────────

const testSource = read(TOOLS_TEST_FILE);
const testRoster = declaredToolRoster(testSource);
if (testRoster) {
  for (const name of testRoster) {
    if (!EXPECTED_TOOLS.includes(name)) {
      fail(`${TOOLS_TEST_FILE}: roster names \`${name}\`, which this guard does not expect`);
    }
  }
  for (const name of EXPECTED_TOOLS) {
    if (!testRoster.includes(name)) {
      fail(`${TOOLS_TEST_FILE}: roster is missing \`${name}\`, which this guard expects`);
    }
  }
}

// ── the switch bank reads a third copy, and nothing else compares it ────────

const catalogVerbs = declaredCatalogVerbs(read(CATALOG_VERBS_FILE));
if (catalogVerbs === null) {
  fail(`${CATALOG_VERBS_FILE}: could not find \`pub const CATALOG_VERBS: [&str; N] = […\]\` — did it get renamed?`);
} else {
  for (const name of catalogVerbs) {
    if (!EXPECTED_TOOLS.includes(name)) {
      fail(`${CATALOG_VERBS_FILE}: CATALOG_VERBS names \`${name}\`, which the catalog does not declare`);
    }
  }
  for (const name of EXPECTED_TOOLS) {
    if (!catalogVerbs.includes(name)) {
      fail(
        `${CATALOG_VERBS_FILE}: CATALOG_VERBS is missing \`${name}\`, so the Settings switch bank ` +
          `renders one switch fewer than the catalog advertises and that verb cannot be switched off`,
      );
    }
  }
}

// ── no capability outside the vault ─────────────────────────────────────────

const capabilities = declaredCapabilities(testSource);
if (capabilities) {
  const literals = stringLiterals(toolList);
  if (literals.length === 0) {
    fail(`${TOOL_LIST_FILE}: no string literals found at all — this guard would pass while reading nothing`);
  }
  // The whole tool, not only name and description: a property description is
  // also text the model reads, and it is where a capability arrives later.
  for (const literal of literals) {
    const inLiteral = new Set(words(literal));
    for (const capability of capabilities) {
      if (inLiteral.has(capability)) {
        fail(
          `${TOOL_LIST_FILE}: a description names \`${capability}\`, which is outside the vault. ` +
            `No outbound tool, ever: a surface that reaches outside the vault is the exfiltration ` +
            `path, not the data source. Text: ${JSON.stringify(literal.slice(0, 120))}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`check-mcp-tool-surface: ${message}`);
  }
  console.error(`\n${failures.length} problem(s) in the compiled MCP tool surface.`);
  process.exit(1);
}

const literalCount = stringLiterals(toolList).length;
console.log(
  `mcp tool surface: ok (${uniqueNames.length} tools, ${catalogVerbs?.length ?? 0} catalog verb(s), ` +
    `${literalCount} string literal(s) scanned, ${capabilities.length} capability word(s) refused)`,
);
