// The self-host BUNDLE drift guard (myne-md/myne#?): the runnable compose file, the
// annotated `.env` example and the user guide's copy of both must agree about what a
// self-hoster can actually set.
//
// ── The failure this prevents ─────────────────────────────────────────────────
//
// Found while writing it, in the shipped bundle: `bundle.env.example` documents 14
// knobs with `kind: server` that `bundle/docker-compose.yml` never forwarded into the
// container. Compose reads `.env` to interpolate `${...}` in the compose file; it does
// NOT inject the file into the container. So an operator who set `MYNE_INVITE_CODE`
// there, restarted, and believed registration was closed had done nothing at all, and
// neither file said so:
//
//   - `check-server-env-roster.mjs` compares the ROSTER against the SERVER'S SOURCE, so
//     it is satisfied by a knob the server reads and the deployment never passes;
//   - the server logs no "unknown variable" for one it never receives;
//   - the guide and the bundle can disagree about the image digest, which is the pin
//     every self-hoster's copy comes from.
//
// Three rules, all of them about the seam between the three files:
//
//   0. **The guide's compose block IS the bundle's compose file.** Structure and
//      values byte-for-byte, comments stripped (the bundle's carry internal ids
//      and private paths; the guide carries none). The page tells the reader
//      "Save it as docker-compose.yml" and "`bundle.env.example` is the file you
//      edit", and until this rule existed both sentences were FALSE: the guide's
//      block was a hand-written subset with LITERAL values, so editing `.env`
//      changed nothing, and fourteen knobs the same page documents could not
//      reach the container at all. `--emit` regenerates the block from the
//      bundle; `--check` (the default) holds the two byte-equal. This is the rule
//      that makes "the runnable copy" mechanical rather than a claim.
//   1. The guide's compose pins the SAME digest as the bundle. Two copies of the pin is
//      two places it can drift, and the guide is the copy most self-hosters follow.
//   2. Every environment variable the guide's server service sets EXISTS in the bundle's
//      server service (a knob documented in the guide that the runnable file cannot set
//      is a knob that silently does nothing).
//   3. Every `kind: server` entry in `bundle.env.example` is REFERENCED by the bundle
//      compose as `${NAME`, and its default matches the compose's default. This is the
//      rule that catches the class above; it is stated as a reference rather than as
//      "the value is right" because forwarding is what was missing.
//
// Rule 0 makes rules 1 and 2 redundant for the SERVER service, and they are kept
// rather than deleted for one reason: rule 0 can only run when both files are
// readable and its projection is the only definition of "the block", so if the
// projection ever stops matching reality (a renamed service, a different fence
// language) rules 1 and 2 still answer the question that matters, from the two
// documents as they are.
//
// Companion repos, like its neighbours: the guide is `myne-website`, the bundle is
// `myne-ops`, and in CI and in a fresh clone BOTH ARE ABSENT, so this prints what it
// could not check rather than a verdict. `MYNE_WEBSITE_DIR` / `MYNE_OPS_DIR` override
// the locations; `--require-companion` turns the absent branch into a failure for a
// caller that knows better.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATES = (name) => [resolve(ROOT, name), resolve(ROOT, "..", "..", "..", name)];

const WEBSITE = process.env.MYNE_WEBSITE_DIR
  ? resolve(process.env.MYNE_WEBSITE_DIR)
  : (CANDIDATES("myne-website").find((c) => existsSync(join(c, "src", "content", "user-guide"))) ??
    CANDIDATES("myne-website")[0]);
const OPS = process.env.MYNE_OPS_DIR
  ? resolve(process.env.MYNE_OPS_DIR)
  : (CANDIDATES("myne-ops").find((c) => existsSync(join(c, "bundle"))) ?? CANDIDATES("myne-ops")[0]);

const GUIDE = join(WEBSITE, "src", "content", "user-guide", "sync-and-devices", "run-your-own-sync-server.md");
const BUNDLE_COMPOSE = join(OPS, "bundle", "docker-compose.yml");
const BUNDLE_ENV = join(OPS, "bundle", "bundle.env.example");

const failures = [];
const notes = [];
let compared = false;
const fail = (m) => failures.push(m);

/** The first fenced block with the given info string that contains `marker`. */
function fencedBlock(text, info, marker) {
  const re = new RegExp("```" + info + "\\n([\\s\\S]*?)```", "g");
  for (const m of text.matchAll(re)) {
    if (m[1].includes(marker)) return m[1];
  }
  return null;
}

/**
 * The bundle compose as the guide must carry it: the whole file from `name:`
 * down, with comments removed.
 *
 * Comments go because the bundle's carry internal tracker ids, a private script
 * path and a main-repo reference, and the guide is a public page that carries
 * none of those (`grep -c 'MYND-\\|SYNC-'` on it is 0). Structure and values stay
 * exactly as they are, which is the whole point: `${MYNE_INVITE_CODE:-}` is what
 * makes the page's own "`bundle.env.example` is the file you edit" true.
 *
 * The leading block before `name:` is documentation rather than compose, so the
 * projection starts at `name:`.
 */
function projectedCompose(compose) {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l.startsWith("name:"));
  if (start === -1) return null;
  const out = [];
  for (const line of lines.slice(start)) {
    if (/^\s*#/.test(line)) continue;
    out.push(line.replace(/\s+#.*$/, "").replace(/\s+$/, ""));
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/** `{ start, end, body }` for the guide's compose fence, or null. */
function guideBlockSpan(text, marker) {
  const re = /```yaml\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) {
    if (m[1].includes(marker)) {
      return { start: m.index, end: m.index + m[0].length, body: m[1] };
    }
  }
  return null;
}

/** The body of a top-level `service:` mapping inside a compose document. */
function serviceBlock(compose, name) {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  \S/.test(line)) break; // the next service, or the volumes section
    out.push(line);
  }
  return out.join("\n");
}

/** `NAME: "value"` → Map(name → raw value) from an `environment:` block. */
function envMap(block) {
  const out = new Map();
  if (!block) return out;
  const envStart = block.split("\n").findIndex((l) => l.trim() === "environment:");
  if (envStart === -1) return out;
  for (let i = envStart + 1; i < block.split("\n").length; i++) {
    const line = block.split("\n")[i];
    if (/^\s{0,4}\S/.test(line) && !/^\s{6,}/.test(line)) break; // left the block
    const m = line.match(/^\s+([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/** `name@sha256:<hex>` for the myne-server image, from a compose document. */
function serverDigest(compose) {
  const m = compose.match(/ghcr\.io\/myne-md\/myne-server@(sha256:[0-9a-f]{64})/);
  return m ? m[1] : null;
}

/** unquote a YAML scalar for comparison purposes. */
const unquote = (v) => v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

/** The `${NAME:-default}` default the compose uses for NAME, or null when it does not reference it. */
function composeDefault(compose, name) {
  const m = compose.match(new RegExp("\\$\\{" + name + ":-([^}]*)\\}"));
  if (m) return unquote(m[1]);
  // `${NAME}` with no default is also a reference (the value must come from .env).
  return new RegExp("\\$\\{" + name + "\\}").test(compose) ? "" : null;
}

const websitePresent = existsSync(GUIDE);
const opsPresent = existsSync(BUNDLE_COMPOSE) && existsSync(BUNDLE_ENV);
const REQUIRE_COMPANION = process.argv.includes("--require-companion");
const EMIT = process.argv.includes("--emit");

if (!websitePresent && !opsPresent) {
  const message =
    "neither the myne-website nor the myne-ops companion is present, so NOTHING was compared.\n" +
    `            Looked in: ${GUIDE}\n                      ${BUNDLE_COMPOSE}\n` +
    "            This is the branch that runs in CI and in a fresh clone. Set MYNE_WEBSITE_DIR and\n" +
    "            MYNE_OPS_DIR to check a pair that lives elsewhere.";
  if (REQUIRE_COMPANION) fail(`--require-companion was passed and ${message}`);
  else
    notes.push(
      "SKIPPED: " + message + "\n            Exit 0 here is an absence of evidence, not a pass.",
    );
} else if (!websitePresent || !opsPresent) {
  notes.push(
    `PARTIAL: ${!websitePresent ? `the guide is absent at ${GUIDE}` : `the bundle is absent at ${BUNDLE_COMPOSE}`}, ` +
      "so the rules that need both were not evaluated.",
  );
} else {
  compared = true;
  const guide = readFileSync(GUIDE, "utf8");
  const bundle = readFileSync(BUNDLE_COMPOSE, "utf8");
  const envExample = readFileSync(BUNDLE_ENV, "utf8");

  // --- rule 0: one compose file, two copies ----------------------------------
  const projected = projectedCompose(bundle);
  if (projected === null) {
    fail(`bundle/docker-compose.yml carries no top-level \`name:\` line, so the guide's\n` +
      `         block cannot be projected from it.`);
  } else if (EMIT) {
    const span = guideBlockSpan(guide, "name: myne-server");
    if (!span) {
      fail(`the guide carries no fenced yaml block containing "name: myne-server", so\n` +
        `         there is nothing to overwrite at ${GUIDE}.`);
    } else if (span.body === projected) {
      notes.push(`--emit: the guide's compose block already matches the bundle; left alone.`);
    } else {
      writeFileSync(GUIDE, guide.slice(0, span.start) + "```yaml\n" + projected + "```" + guide.slice(span.end));
      notes.push(`--emit: the guide's compose block was regenerated from bundle/docker-compose.yml.`);
    }
  } else {
    const span = guideBlockSpan(guide, "name: myne-server");
    // No span here is NOT failed from this branch: the block-presence check below
    // owns that message, and two failures describing one absence read as two
    // problems.
    if (span && span.body !== projected) {
      fail(
        `the guide's compose block is not the bundle's file. The page says "Save it as\n` +
          `         docker-compose.yml" and "bundle.env.example is the file you edit"; a block\n` +
          `         with different content or LITERAL values makes the second sentence false, so\n` +
          `         editing .env does nothing and every \${NAME} knob is unreachable.\n` +
          `         Run: node scripts/check-selfhost-bundle-drift.mjs --emit`,
      );
    }
  }

  if (EMIT) {
    // Write mode stops here: the rules below compare the two documents, and the
    // one it just rewrote is the guide's half of that comparison.
    for (const n of notes) console.log(`note: ${n}`);
    if (failures.length > 0) {
      console.error(`\ncheck-selfhost-bundle-drift --emit: ${failures.length} problem(s)\n`);
      for (const f of failures) console.error(`  ${f}\n`);
      process.exit(1);
    }
    console.log("ok: --emit finished. Run without --emit to check the result.");
    process.exit(0);
  }

  const guideCompose = fencedBlock(guide, "yaml", "name: myne-server");
  if (!guideCompose) {
    fail(
      `the guide carries no fenced yaml block containing "name: myne-server", so the\n` +
        `         compose file it tells a self-hoster to run could not be found at ${GUIDE}.\n` +
        `         If the block moved or changed its project name, this guard's marker is stale.`,
    );
  } else {
    // --- rule 1: one image pin, two copies -------------------------------------
    const guidePin = serverDigest(guideCompose);
    const bundlePin = serverDigest(bundle);
    if (!guidePin) {
      fail(`the guide's compose block pins no ghcr.io/myne-md/myne-server digest.`);
    } else if (!bundlePin) {
      fail(`bundle/docker-compose.yml pins no ghcr.io/myne-md/myne-server digest.`);
    } else if (guidePin !== bundlePin) {
      fail(
        `the image pin disagrees between the guide and the bundle:\n` +
          `           guide  (${GUIDE.slice(ROOT.length + 1)}): ${guidePin}\n` +
          `           bundle (runbook/bundle/docker-compose.yml): ${bundlePin}\n` +
          `         One of them is a self-hoster on the wrong build. Update both (the release\n` +
          `         checklist's phase-10 row lists every pin in one place).`,
      );
    }

    // --- rule 2: the guide may not document a knob the bundle cannot set -------
    const guideEnv = envMap(serviceBlock(guideCompose, "server"));
    const bundleEnv = envMap(serviceBlock(bundle, "server"));
    for (const name of [...guideEnv.keys()].sort()) {
      if (bundleEnv.has(name)) continue;
      fail(
        `${name} is set by the guide's server service but not by the bundle's, so the\n` +
          `         runnable copy cannot set it. Add it to bundle/docker-compose.yml (as\n` +
          `         \${${name}:-<default>}) or drop it from the guide.`,
      );
    }
  }

  // --- rule 3: every documented server knob reaches the container --------------
  const blocks = envExample.split(/\n\s*\n/);
  let checkedEntries = 0;
  for (const raw of blocks) {
    const lines = raw.split("\n");
    let kind = null;
    for (const line of lines) {
      const marker = line.match(/kind:\s*(server|bundle)/);
      if (marker) {
        kind = marker[1];
        continue;
      }
      const assign = line.match(/^#?\s*(MYNE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!assign) continue;
      if (kind !== "server") continue;
      if (line.trim().startsWith("#")) continue; // a commented example is not a setting
      const [, name, rhs] = assign;
      checkedEntries++;
      const want = unquote(rhs);
      const got = composeDefault(bundle, name);
      if (got === null) {
        fail(
          `${name} is a documented "kind: server" entry in bundle.env.example but\n` +
            `         bundle/docker-compose.yml never references it as \${${name}}. Compose reads\n` +
            `         .env to interpolate THIS file; it does not inject .env into the container, so\n` +
            `         the operator's value never reaches the server and nothing says so.`,
        );
        continue;
      }
      if (got !== want) {
        fail(
          `${name} has two different defaults: bundle.env.example says "${want}" and\n` +
            `         bundle/docker-compose.yml falls back to "${got}". One of the two files is\n` +
            `         lying about the shipped value.`,
        );
      }
    }
  }

  if (checkedEntries === 0) {
    fail(
      `no "kind: server" entry with an active assignment was found in bundle.env.example,\n` +
        `         so rule 3 was not evaluated. A roster that has been emptied or reworded must\n` +
        `         fail by name rather than pass over nothing.`,
    );
  }

  notes.push(
    `Compared the guide's compose block against bundle/docker-compose.yml (image pin) and ` +
      `${checkedEntries} documented server knob(s) against the compose's forwarding.`,
  );
  notes.push(
    "NOT checked: whether the bundle's own Caddyfile still deletes every IP-bearing log " +
      "field (that is `smoke-test.sh`'s assertion, and it needs a container), or whether a " +
      "knob's value is SENSIBLE.",
  );
}

for (const n of notes) console.log(`note: ${n}`);
if (failures.length) {
  console.error(`\ncheck-selfhost-bundle-drift: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(
  compared
    ? "ok: the guide, the bundle and the env example agree about what a self-hoster can set"
    : "ok: NOTHING COMPARED (a companion is absent). This line is not a verdict.",
);
