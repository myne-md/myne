// The server's environment-variable roster (myne-md/myne#787).
//
// The failure this prevents: **there was no authoritative list of the sync server's
// environment variables anywhere except the comments in its own source.** Every other
// copy was hand-maintained, and they drifted in both directions at once:
//
//   - `myne-ops/bundle/bundle.env.example` shipped 8 real knobs it never mentioned,
//     including `MYNE_EXTENDED_RETENTION`, the one `self-host-policy.md` warns hardest
//     about because turning it on keeps deleted ciphertext past the horizon. The knob
//     an operator is most warned about was the one an operator could not find.
//   - The same file carried `MYNE_ACME_EMAIL` and `MYNE_TLS_INLINE`, which NOTHING in
//     `myne-ops` reads. TLS mode stopped being an environment variable and became a
//     Caddyfile selector (`MYNE_CADDYFILE`), and the live mechanism was undocumented
//     while the two dead knobs were documented.
//   - `myne-server/README.md` documented zero of them.
//
// None of that is visible to a compiler, a test, or any other guard in this repository:
// a new knob plus a forgotten example file is a green tree. That is the whole reason
// this exists.
//
// THREE RULES, because a flat set difference fails in both directions today:
//
//   1. Every variable the server reads is DOCUMENTED: it appears as a classified entry,
//      or in the file's explicit "deliberately NOT in this file" list with its reason.
//   2. Every entry classified `kind: server` ACTUALLY EXISTS in the server. This is the
//      dead-entry direction; `kind: bundle` entries are exempt, since the compose file
//      and Caddy read those.
//   3. No entry is UNCLASSIFIED. A variable in the example file with no `kind:` marker
//      is indistinguishable from a bundle variable, and that ambiguity is the defect.
//
// Rule 3 is why the classification lives IN THE FILE rather than in a hardcoded set
// here. A hardcoded classification cannot express "this one is deliberately absent",
// so the answer to a legitimate omission would be to delete the documentation, which is
// exactly what went wrong. This is the shape `check-web-command-coverage.mjs` already
// uses, where the roster carries the per-item judgement and the guard enforces that
// every item has one.
//
// COMPANION REPOS. The server is `myne-server` and the bundle is `myne-ops`, both
// nested at `<repo>/<name>`. **In CI and in a fresh clone neither is present**, so this
// guard must SAY WHAT IT COULD NOT CHECK rather than report success over half its name.
// `MYNE_SERVER_DIR` and `MYNE_OPS_DIR` override the locations, and exist for one
// reason: the absent branch is the branch that runs in CI, its bug is invisible, and
// without an override there is no way to exercise it on a machine that HAS the
// companions, which is every machine where anyone would think to test it.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, resolved from this file's own directory.
 *
 * NOT `new URL("..", import.meta.url).pathname + "../"`, which is what
 * `scripts/lib/shared-roots.mjs` uses and which is CORRECT THERE because that module
 * lives two levels deep. This file lives one level deep, so the same expression
 * resolved to the repository's PARENT: correct by accident in a shared checkout,
 * wrong in every worktree, which is the exact trap `check-clipper-identifiers.mjs`
 * documents in its own header. It was masked while testing because the companion
 * directories were being supplied by environment variable.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where a nested companion checkout is: both layouts, first hit wins. */
const CANDIDATES = (name) => [resolve(ROOT, name), resolve(ROOT, "..", "..", "..", name)];

const SERVER = process.env.MYNE_SERVER_DIR
  ? resolve(process.env.MYNE_SERVER_DIR)
  : (CANDIDATES("myne-server").find((c) => existsSync(join(c, "go.mod"))) ??
    CANDIDATES("myne-server")[0]);
const OPS = process.env.MYNE_OPS_DIR
  ? resolve(process.env.MYNE_OPS_DIR)
  : (CANDIDATES("myne-ops").find((c) => existsSync(join(c, "bundle"))) ??
    CANDIDATES("myne-ops")[0]);

const ENV_EXAMPLE = join(OPS, "bundle", "bundle.env.example");

/**
 * How the server reads an environment variable. Matched on the CALL SHAPE rather than
 * by grepping the identifier, because a bare `MYNE_BACKUP_*` in a comment is not a
 * variable and reading one in as a knob would make this guard permanently red for a
 * reason no author can act on.
 */
const READ_CALL =
  /(?:os\.(?:Getenv|LookupEnv)|boolEnv|uintEnv|envOr|envDefault)\(\s*"(MYNE_[A-Z0-9_]+)"/g;

/** Recursively collect every `.go` file under a directory. */
function goFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "vendor" || entry === ".opencode") continue;
      out.push(...goFiles(p));
    } else if (entry.endsWith(".go") && !entry.endsWith("_test.go")) {
      // _test.go excluded on purpose. A test-only MYNE_ read is not an operator knob,
      // and a hardcoded exemption list in this script is the wrong place to say so: the
      // file's own header argues that a classification living in the script cannot
      // express "this one is deliberately absent". A genuinely test-only variable that
      // should be documented belongs in the example file's absent block with its reason.
      out.push(p);
    }
  }
  return out;
}

/** Every MYNE_* variable the server's own code reads. */
const missingRoots = [];
function serverVars() {
  const found = new Set();
  for (const root of SERVER_VAR_ROOTS) {
    const dir = join(SERVER, root);
    if (!existsSync(dir)) {
      missingRoots.push(root);
      continue;
    }
    for (const file of goFiles(dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(READ_CALL)) {
        found.add(m[1]);
      }
    }
  }
  return found;
}

/**
 * Parse the example file into blank-line-separated blocks.
 *
 * A block is the unit of classification, because one variable's entry is its comment
 * run plus its assignment, and a commented-out EXAMPLE of that same variable sits in
 * the same block. Keying on assignment lines alone would demand a marker for every
 * example line, which is noise rather than safety.
 */
function parseExample(text) {
  const blocks = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const lines = raw.split("\n");
    // The absent block is identified by its own HEADING line, and only a variable that
    // appears in a COMMENTED assignment inside it counts. Matching the phrase anywhere
    // in the block let unrelated prose satisfy it, which is rule 1's escape hatch: a knob
    // the server reads and the roster omits passed because some other block said
    // "these are recorded in the server source".
    const isAbsentList = raw.split("\n").some((l) => /^#\s*[-*]{0,3}\s*deliberately NOT in this file/i.test(l.trim()));
    const mentions = new Set(raw.match(/MYNE_[A-Z0-9_]+/g) ?? []);

    // Kind is resolved PER ASSIGNMENT, against the nearest preceding marker, rather
    // than once for the block. Resolving it once let a second entry in the same block
    // silently inherit the first one's kind, so adding a "kind: bundle" line next to a
    // "kind: server" one without a blank line between them made the bundle entry look
    // like a dead server knob.
    const assigned = new Map();
    let kind = null;
    for (const line of lines) {
      const marker = line.match(/kind:\s*(server|bundle)/);
      if (marker) {
        kind = marker[1];
        continue;
      }
      const assign = line.match(/^#?\s*(MYNE_[A-Z0-9_]+)\s*=/);
      // Only these count as ENTRIES: something that assigns the variable.
      if (assign) assigned.set(assign[1], kind);
    }
    blocks.push({ text: raw, isAbsentList, mentions, assigned });
  }
  return blocks;
}

/** `--require-companion` turns the absent branch into a failure, for a caller that
 * knows better than "the companions are not here". Same escape hatch
 * `check-clipper-identifiers.mjs` exposes, and for the same reason. */
const REQUIRE_COMPANION = process.argv.includes("--require-companion");

/**
 * The measured non-vacuity floor for `serverVars()`.
 *
 * A loop over every setter passes trivially when the roster is empty or has silently
 * shrunk, and the empty case here was reachable in one step: a server layout change that
 * moved configuration out of `internal/` and `cmd/` empties the scanned set, every
 * remaining entry then falls under the `kind: bundle` exemption, all three rules find
 * nothing, and the closing line still reads "agrees in both directions". The count
 * floor plus the per-root presence check is the pair, exactly as `check-e2e-floor.mjs`
 * pairs its floor with its ceiling. Measured against `myne-server` at the branch tip.
 */
const SERVER_VAR_FLOOR = 26;

/**
 * `--min-vars=N` overrides the floor. It exists so a test can drive the guard over a
 * two-file fixture without either faking the roster size or weakening the default, and it
 * is the same shape as the `MYNE_*_DIR` overrides above: a named seam rather than a
 * behaviour switch nothing else uses.
 */
const minVarsArg = process.argv.find((a) => a.startsWith("--min-vars="));
const SERVER_VAR_FLOOR_EFFECTIVE = minVarsArg ? Number(minVarsArg.split("=")[1]) : SERVER_VAR_FLOOR;
const SERVER_VAR_ROOTS = ["internal", "cmd"];

const failures = [];
const notes = [];
/** What the run actually did, so the closing line cannot claim more than that. */
let compared = false;
const fail = (m) => failures.push(m);

// The two companions are named here as string literals, which is a private copy of the
// roster and can fall behind exactly the way this guard exists to prevent. So they are
// checked against the ONE list of siblings: workspace/manifest.txt. A companion renamed
// there fails this guard BY NAME, rather than quietly turning a scan into a no-op
// against a path nothing will ever populate.
const MANIFEST = join(ROOT, "workspace", "manifest.txt");
if (existsSync(MANIFEST)) {
  const listed = new Set(
    readFileSync(MANIFEST, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  for (const name of ["myne-server", "myne-ops"]) {
    if (!listed.has(name)) {
      fail(
        `${name} is read by this guard but is not in workspace/manifest.txt. Either the\n` +
          `         companion was renamed, or this guard's list is stale. Fix the one that is\n` +
          `         wrong: a silent no-op against a path nothing populates is the failure this\n` +
          `         guard exists to catch.`,
      );
    }
  }
}

// --- the companions -----------------------------------------------------------------

const serverPresent = existsSync(join(SERVER, "go.mod"));
const opsPresent = existsSync(join(OPS, "bundle", "bundle.env.example"));

if (!serverPresent && !opsPresent) {
  const message =
    "neither the myne-server nor the myne-ops companion is present, so NOTHING was compared.\n" +
    `            Looked in: ${SERVER}\n                      ${OPS}\n` +
    "            This is the branch that runs in CI and in a fresh clone. The roster cannot\n" +
    "            drift INTO a tree with no companions, but it can drift OUT of one, and that\n" +
    "            drift is invisible until someone runs this where the companions exist.\n" +
    "            Set MYNE_SERVER_DIR and MYNE_OPS_DIR to check a pair that lives elsewhere.";
  if (REQUIRE_COMPANION) {
    fail(`--require-companion was passed and ${message}`);
  } else {
    notes.push(
      "SKIPPED: " + message + "\n" +
        "            Exit 0 here is an absence of evidence, not a pass. Re-run with\n" +
        "            --require-companion where the companions exist.",
    );
  }
} else {
  if (!serverPresent) {
    notes.push(
      `PARTIAL: myne-server is absent at ${SERVER}, so rule 1 and rule 2 could not be evaluated.`,
    );
  }
  if (!opsPresent) {
    notes.push(`PARTIAL: myne-ops is absent at ${OPS}, so no roster file was read.`);
  }

  if (serverPresent && opsPresent) {
    compared = true;
    const code = serverVars();
    const blocks = parseExample(readFileSync(ENV_EXAMPLE, "utf8"));

    // Inside the absent block, a name counts when it appears on a COMMENT line, in any
    // shape. Requiring an assignment would be tighter still, but the block documents
    // omissions rather than settings, so a bare name with its reason is the honest form
    // and rule 1b below checks the name against the server's own reads.
    const absent = new Set();
    for (const b of blocks) {
      if (!b.isAbsentList) continue;
      for (const line of b.text.split("\n")) {
        if (!line.trim().startsWith("#")) continue;
        for (const v of line.match(/MYNE_[A-Z0-9_]+/g) ?? []) absent.add(v);
      }
    }

    /** var -> kind, for the assigned entries only. */
    const entryKind = new Map();
    for (const b of blocks) {
      for (const [v, kind] of b.assigned) {
        if (entryKind.has(v) && entryKind.get(v) !== kind) {
          fail(`${v}: classified twice in bundle.env.example (${entryKind.get(v)} and ${kind}). One variable, one classification.`);
        }
        entryKind.set(v, kind);
      }
    }

    if (missingRoots.length) {
      for (const root of missingRoots) {
        fail(
          `the server root ${root} does not exist at ${SERVER}, so this guard scanned\n` +
            `         nothing there. A scan that silently covers less than it claims is the\n` +
            `         failure this guard exists to catch; it fails by name rather than\n` +
            `         reporting a smaller roster as a passing one.`,
        );
      }
    }
    if (code.size < SERVER_VAR_FLOOR_EFFECTIVE) {
      fail(
        `the scan found ${code.size} server-read variables, below the measured floor of\n` +
          `         ${SERVER_VAR_FLOOR_EFFECTIVE}. Either the server's env reads moved somewhere this guard\n` +
          `         does not scan, or a read shape was added that the scanner does not\n` +
          `         recognise. Both make every rule below vacuous, so the count is gated\n` +
          `         rather than printed. Re-measure and state the reason when it is real.`,
      );
    }

    // Rule 1: every variable the server reads is documented.
    for (const v of [...code].sort()) {
      if (entryKind.has(v)) continue;
      if (absent.has(v)) continue;
      fail(
        `${v} is read by the server but does not appear in bundle.env.example.\n` +
          `         Add it as an entry with a "kind: server" marker, or list it in that file's\n` +
          `         "deliberately NOT in this file" block with the reason it is omitted.`,
      );
    }

    // Rule 2: every entry classified as a server knob really exists.
    for (const [v, kind] of [...entryKind].sort()) {
      if (kind !== "server") continue;
      if (code.has(v)) continue;
      fail(
        `${v} is classified "kind: server" in bundle.env.example but the server never reads it.\n` +
          `         That is a dead knob: setting it does nothing. Reclassify it as "kind: bundle" if\n` +
          `         the compose file or Caddy reads it, or delete the entry.`,
      );
    }

    // Rule 3: no entry is unclassified.
    for (const [v, kind] of [...entryKind].sort()) {
      if (kind === null || kind === undefined) {
        fail(
          `${v} appears in bundle.env.example with no "kind:" marker.\n` +
            `         Every entry says whether the SERVER reads it or the BUNDLE does, so a dead\n` +
            `         knob and a live one cannot look alike.`,
        );
      }
    }

    // Rule 1b: a name claimed as "deliberately absent" must really be absent.
    for (const v of [...absent].sort()) {
      if (entryKind.has(v)) {
        fail(
          `${v} is listed as "deliberately NOT in this file" and is also an entry. Pick one:\n` +
            `         the absent list is for documenting a reason, not for duplicating an entry.`,
        );
      }
      if (!code.has(v)) {
        fail(
          `${v} is in bundle.env.example's "deliberately NOT in this file" list but the server\n` +
            `         never reads it either, so the reason recorded for it is about nothing.`,
        );
      }
    }

    notes.push(
      `Compared ${code.size} server-read variables against ${entryKind.size} classified entries ` +
        `and ${absent.size} documented omissions in ${ENV_EXAMPLE}.`,
    );
  }
}

// --- report -------------------------------------------------------------------------

for (const n of notes) console.log(`note: ${n}`);
if (failures.length) {
  console.error(`\ncheck-server-env-roster: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
// The closing line states what the run did. An earlier version printed the same
// "agrees in both directions" line in the companion-absent branch, which is precisely
// the failure this file's own header describes: reporting ok while checking half of
// what the name claims.
console.log(
  compared
    ? "ok: server env roster agrees in both directions, and every entry is classified"
    : "ok: NOTHING COMPARED (a companion is absent). This line is not a verdict on the roster.",
);
