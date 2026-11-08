#!/usr/bin/env node
// Generate `public/THIRD-PARTY-LICENSES.txt` from the production dependency
// closure, and gate it (`--check`) so the shipped file cannot drift from the
// dependency set it describes. Closes the MYND-504 gap that the drawing-notes
// work left open on purpose: that file said, in its own text, that a
// whole-tree aggregated notice was still owed.
//
// ── WHY THE PACKAGE LIST IS NOT HAND-WRITTEN ────────────────────────────────
//
// A licence notice that is written by hand is a notice that is correct on the
// day it is written. The failure it produces is silent and legal rather than
// visible: a dependency is added, its licence text is never added with it, and
// the shipped artefact quietly stops being a complete notice. Nothing in this
// repository would have caught that, because nothing else reads this file.
// So the file is GENERATED, and `--check` holds it byte-equal, the
// `check-twin-inventory.mjs` contract.
//
// ── SCOPE, STATED PRECISELY, BECAUSE THE OBVIOUS WORDING IS WRONG ────────────
//
// This covers the PRODUCTION dependency closure (`dependencies`, not
// `devDependencies`) because those are what Vite bundles into the shipped app.
// That over-approximates "what is really bundled": a production dependency no
// client imports is listed and is not actually redistributed. The direction is
// deliberate. Over-inclusion is harmless in a notice; under-inclusion is the
// failure the file exists to prevent. The old header said "bundled into the
// Myne desktop build", which is a claim about a bundle graph this script does
// not build, and so a claim it could not check.
//
// ── THE ONE EXCLUSION, AND WHY IT IS NOT A HOLE IN THE ABOVE ────────────────
//
// A package whose own `package.json` declares `os`, `cpu` or `libc` is a
// prebuilt binary for ONE platform, and a different member of that family is
// what each platform's install contains: `fsevents@2.3.3` exists on macOS and
// not on Linux, and the canvas prebuild is `@napi-rs/canvas-darwin-arm64` on an
// Apple silicon Mac where CI gets `@napi-rs/canvas-linux-x64-gnu`. Measured on
// 2026-10-18: of the 300 production packages the macOS tree reports, exactly
// TWO are platform-restricted, and the Linux tree reports 299 with a different
// one of them.
//
// That is why this gate was red on `develop` with nothing actually wrong: the
// artefact was byte-equal only on the machine that generated it, and `--check`
// runs on another one. Excluding them is what makes the file ONE artefact
// instead of a per-platform one, and it costs a notice nothing: a
// platform-restricted package is a native binary, and a WebView bundle cannot
// contain or call one. Everything else stays listed, over-inclusive as before.
//
// The rule reads each package's own manifest rather than a hand-kept list, so
// it cannot go stale when a family gains a platform. What it CANNOT judge is
// whether some future native package is redistributed anyway; that needs the
// bundle graph this script does not build, which is the same limit the
// over-approximation above already states. The packages it drops are named on
// stdout, so any run shows them.
//
// ── WHY IT READS `node_modules` AND NOT ONLY THE LOCKFILE ──────────────────
//
// `pnpm licenses list` answers with names, versions and a licence expression.
// It does NOT answer with the licence TEXT, and the text is the part the
// permissive licences actually require you to reproduce (MIT and BSD are
// notice-preserving). So the text is read from each package's own directory as
// `pnpm licenses list --json` reports it, and the notice is complete rather
// than a list of names pointing at obligations nobody discharged.
//
// ── EXIT CODES ─────────────────────────────────────────────────────────────
//
//   0  the committed file matches what the tree produces (`--check`), or it was
//      written (`--emit`, the default)
//   1  the file differs: run the generator and commit the result
//   2  the gate could not evaluate: `pnpm` would not run, or answered with
//      something this script cannot read. Distinct from 1 for the reason
//      `check-npm-licenses.mjs` states: a gate that could not run is not a
//      finding, and reporting it as one sends the reader looking for a licence
//      that does not exist.
//
// `--store-dir <path>` is passed through as `--config.store-dir=` for the same
// reason and in the same spelling as its sibling: the `licenses` subcommand
// rejects the option's own name.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = "public/THIRD-PARTY-LICENSES.txt";
const OUT = join(ROOT, OUT_REL);

/** A file name that carries a licence text, in any of the spellings packages use. */
const LICENCE_FILE_RE = /^(licen[cs]e|copying|notice)/i;

export const PREAMBLE = `Myne — Third-Party Licenses
========================================================

Generated by \`scripts/gen-third-party-licenses.mjs\` from
\`pnpm licenses list --json --prod\`. Do not edit by hand: CI runs the same
script with \`--check\` and fails on any difference.

**Scope, stated precisely.** This file covers the PRODUCTION dependency closure
of the workspace, which is what Vite bundles into the shipped clients. That is
an over-approximation of "what is really bundled": a production dependency no
client imports is listed here and is not, in fact, redistributed. The direction
is deliberate, because over-inclusion is harmless in a licence notice and
under-inclusion is not.

**One exclusion, and its argument.** A package that declares \`os\`, \`cpu\` or
\`libc\` in its own manifest is a prebuilt binary for one platform, and each
platform's install carries a different one of them (\`fsevents\` on macOS, a
different \`@napi-rs/canvas-*\` prebuild per OS and architecture). Those are not
listed here, so this file is one artefact rather than a per-platform one, and
the gate that holds it byte-equal can hold at all. Nothing a notice owes is lost
by it: a platform-restricted package is a native binary, which no WebView bundle
can contain or call. Everything else in the production closure is listed above,
whether or not a client imports it. \`scripts/gen-third-party-licenses.mjs\`
carries the rule and names what it excluded when it runs.

The per-dependency rationale (why a package is a dependency at all) lives in
\`myne-agents/docs/dependency-policy.md\`; the project's own licensing map is \`LICENSING.md\`;
the bundled non-npm assets are the fonts below plus the model weights and
dictionaries those two files record.
`;

/** The vendored fonts, which are not npm packages and so are not in the generated list. */
export const VENDORED_SECTION = `================================================================================
Vendored assets that are not npm packages
================================================================================
Excalidraw hand-drawn fonts — SIL Open Font License, Version 1.1
--------------------------------------------------------------------------------
Vendored under \`public/excalidraw-assets/fonts/\` and served same-origin (no
CDN): Excalifont, Virgil, Nunito, Comic Shanns, Lilita One, Assistant, Cascadia
Code, Liberation Sans, Xiaolai. Each is licensed under the SIL Open Font
License 1.1. Bundled verbatim; not sold on their own; Reserved Font Names are
unmodified.

The two UI webfonts (Inter, JetBrains Mono) are also OFL-1.1 and keep their own
notice, which ships beside them at \`public/fonts/LICENSE.txt\`.

This Font Software is licensed under the SIL Open Font License, Version 1.1.

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership with
others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The fonts,
including any derivative works, can be bundled, embedded, redistributed and/or
sold with any software provided that any reserved names are not used by
derivative works. The fonts and derivatives, however, cannot be released under
any other type of license. The requirement for fonts to remain under this
license does not apply to any document created using the fonts or their
derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright Holder(s)
under this license and clearly marked as such. This may include source files,
build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright
statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or
substituting -- in part or in whole -- any of the components of the Original
Version, by changing formats or by porting the Font Software to a new
environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy of
the Font Software, to use, study, copy, merge, embed, modify, redistribute, and
sell modified and unmodified copies of the Font Software, subject to the
following conditions:

1) Neither the Font Software nor any of its individual components, in Original
or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy contains
the above copyright notice and this license. These can be included either as
stand-alone text files, human-readable headers or in the appropriate
machine-readable metadata fields within text or binary files as long as those
fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s)
unless explicit written permission is granted by the corresponding Copyright
Holder. This restriction only applies to the primary font name as presented to
the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software
shall not be used to promote, endorse or advertise any Modified Version, except
to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s)
or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under any
other license. The requirement for fonts to remain under this license does not
apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT,
INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR
FROM OTHER DEALINGS IN THE FONT SOFTWARE.
`;

/** The pnpm directory key for a package name (`@scope/name` -> `@scope+name`). */
function pnpmKey(name) {
  return name.replace("/", "+");
}

/** One row per `(name, version)`, sorted, with the directory its text comes from.
 *
 *  Sorted here rather than trusted from pnpm, because pnpm's ordering is an
 *  implementation detail and this file is held byte-equal. */
export function flatten(payload) {
  const rows = [];
  for (const licence of Object.keys(payload)) {
    for (const entry of payload[licence]) {
      const versions = entry.versions ?? [];
      for (const version of versions) {
        const paths = entry.paths ?? [];
        const want = `/${pnpmKey(entry.name)}@${version}/`;
        const dir = paths.find((p) => p.includes(want)) ?? paths[0] ?? null;
        rows.push({
          name: entry.name,
          version,
          license: entry.license ?? licence,
          declaredInGroup: licence,
          dir,
        });
      }
    }
  }
  rows.sort((a, b) =>
    a.name.toLowerCase() === b.name.toLowerCase()
      ? a.version.localeCompare(b.version)
      : a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : 1,
  );
  return rows;
}

/** Split the rows into what one notice can list on every platform, and what it cannot.
 *
 *  A package declaring `os`/`cpu`/`libc` exists to be a prebuilt binary for one
 *  platform, so which member of the family is installed depends on where
 *  `pnpm install` ran. A notice that names the macOS member on a Mac and the
 *  Linux member on CI is two different artefacts, and `--check` compares this
 *  one byte-for-byte, so it could never hold on both. See the header for why
 *  dropping them costs a notice nothing.
 *
 *  `readManifest` is injected so the rule can be driven over a fixture. A
 *  manifest that cannot be read leaves its row LISTED rather than dropped:
 *  keeping a package is the harmless direction, and a filesystem hiccup must
 *  not silently narrow a notice. */
export function platformRestricted(rows, readManifest) {
  const kept = [];
  const excluded = [];
  for (const row of rows) {
    let manifest;
    try {
      manifest = JSON.parse(readManifest(row.dir));
    } catch {
      kept.push(row);
      continue;
    }
    const restriction = {
      os: manifest.os ?? null,
      cpu: manifest.cpu ?? null,
      libc: manifest.libc ?? null,
    };
    if (restriction.os || restriction.cpu || restriction.libc) {
      excluded.push({ ...row, restriction });
    } else {
      kept.push(row);
    }
  }
  return { kept, excluded };
}

/** The licence text a package ships, concatenated over its `LICEN[CS]E*` files.
 *
 *  `readDir`/`readFile` are injected so the rule can be driven over a fixture.
 *  Returns `""` when the package ships none, which is a real and reportable
 *  state: the declared licence is then the only record there is. */
export function licenceText(dir, readDir, readFile) {
  if (!dir) return "";
  let names;
  try {
    names = readDir(dir);
  } catch {
    return "";
  }
  // No `statSync` filter: a name that is a directory fails to read and is
  // skipped by the same `catch`, which keeps the rule drivable by an injected
  // reader rather than by a real filesystem.
  const files = names.filter((f) => LICENCE_FILE_RE.test(f)).sort();
  let text = "";
  for (const f of files) {
    try {
      text += readFile(join(dir, f));
    } catch {
      // A directory, or a file this process cannot read. Neither is evidence of
      // no licence, but there is nothing else to do with it here; the block
      // below reports the package as shipping no readable text rather than
      // silently omitting it.
    }
  }
  return text.trim();
}

/** Normalise an upstream licence text for the artefact.
 *
 *  Two changes, both cosmetic and neither touching a word of the licence: line
 *  endings become LF, and trailing spaces are stripped from every line. The
 *  second is what the repository's own `whitespace` pre-commit check demands of
 *  every tracked text file, and a licence file authored on Windows or by an
 *  editor that pads is otherwise refused by the commit that adds it. */
export function normalise(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Render the whole artefact. `readDir`/`readFile` are injected for the tests. */
export function render(rows, readDir, readFile) {
  const undeclared = rows.filter((r) => r.declaredInGroup === "Unknown");
  const out = [];

  out.push(PREAMBLE.trimEnd());
  out.push("");
  out.push(VENDORED_SECTION.trimEnd());
  out.push("");

  out.push(`${"=".repeat(80)}
Packages (${rows.length})
${"=".repeat(80)}`);
  if (undeclared.length > 0) {
    out.push(
      `ATTENTION: ${undeclared.length} package(s) declare no licence at all: ` +
        undeclared.map((r) => `${r.name}@${r.version}`).join(", ") +
        ". Each one's own licence file, where it ships one, is reproduced below; " +
        "where it does not, the obligation has to be established from the package's " +
        "own repository before this notice can be called complete.",
    );
    out.push("");
  }
  for (const r of rows) out.push(`${r.name} ${r.version} — ${r.license}`);
  out.push("");

  out.push(`${"=".repeat(80)}
Package licence texts
${"=".repeat(80)}`);
  out.push(
    "One block per package, in the same order as the list above, holding the text\n" +
      "the package itself ships. A block that says the package ships no licence file\n" +
      "is reporting that its licence is recorded only in its manifest.",
  );
  out.push("");
  for (const r of rows) {
    out.push(`${"-".repeat(80)}\n${r.name} ${r.version} — ${r.license}\n${"-".repeat(80)}`);
    const text = normalise(licenceText(r.dir, readDir, readFile));
    out.push(
      text ||
        "(this package ships no readable licence file; the licence named above is its manifest's only record)",
    );
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Ask pnpm for the production closure. Throws with pnpm's own message on failure. */
export function pnpmLicences(storeDir) {
  const args = ["licenses", "list", "--json", "--prod"];
  if (storeDir) args.push(`--config.store-dir=${storeDir}`);
  const raw = execFileSync("pnpm", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`pnpm answered with something that is not JSON: ${raw.slice(0, 200)}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const i = argv.indexOf("--store-dir");
  const storeDir = i !== -1 ? argv[i + 1] : null;
  if (i !== -1 && !storeDir) {
    console.error("gen-third-party-licenses: --store-dir was given with no path after it");
    process.exit(2);
  }

  let payload;
  try {
    payload = pnpmLicences(storeDir);
  } catch (e) {
    console.error(
      "gen-third-party-licenses: COULD NOT EVALUATE — `pnpm licenses list --prod` failed:\n" +
        `  ${e.message.split("\n")[0]}\n` +
        "  Nothing was verified. This is exit 2, not a finding: the tree has not been\n" +
        "  compared with anything, so a green run before this one says nothing about\n" +
        "  the tree as it is now. If pnpm names a store, pass the install's path as\n" +
        "  `--store-dir` (the install and the gate must look at the same store).",
    );
    process.exit(2);
  }

  const rows = flatten(payload);
  if (rows.length === 0) {
    console.error(
      "gen-third-party-licenses: FAIL — pnpm answered with an EMPTY package set. " +
        "This tree has production dependencies; an empty answer means the read was " +
        "broken, not that the notice may be empty.",
    );
    process.exit(2);
  }

  const { kept, excluded } = platformRestricted(rows, (dir) =>
    readFileSync(join(dir, "package.json"), "utf8"),
  );
  if (excluded.length > 0) {
    console.log(
      `third-party-licenses: ${excluded.length} platform-restricted package(s) not ` +
        "listed, by the rule in this file's header: " +
        excluded.map((r) => `${r.name}@${r.version}`).join(", "),
    );
  }
  if (kept.length === 0) {
    console.error(
      "gen-third-party-licenses: FAIL — every production package came back " +
        "platform-restricted, so the notice would list nothing at all. That is a " +
        "broken read or a rule that has gone wrong, not a tree with no obligations.",
    );
    process.exit(2);
  }

  const generated = render(kept, readdirSync, (p) => readFileSync(p, "utf8"));

  if (check) {
    if (!existsSync(OUT)) {
      console.error(
        `gen-third-party-licenses: FAIL — ${OUT_REL} does not exist. Run ` +
          "`node scripts/gen-third-party-licenses.mjs` and commit it.",
      );
      process.exit(1);
    }
    const committed = readFileSync(OUT, "utf8");
    if (committed !== generated) {
      console.error(
        `gen-third-party-licenses: FAIL — ${OUT_REL} is stale. The dependency set ` +
          "and the shipped notice have diverged, which is exactly the drift this " +
          "gate exists for.\n" +
          "  Run:  node scripts/gen-third-party-licenses.mjs\n" +
          "  and commit the result.",
      );
      process.exit(1);
    }
    console.log(
      `third-party-licenses: ok (${kept.length} production package(s) reproduced ` +
        `verbatim in ${OUT_REL}; ${excluded.length} platform-restricted excluded)`,
    );
    return;
  }

  writeFileSync(OUT, generated);
  const undeclared = kept.filter((r) => r.declaredInGroup === "Unknown").length;
  console.log(
    `third-party-licenses: wrote ${OUT_REL} (${kept.length} package(s), ` +
      `${(generated.length / 1024).toFixed(0)} KiB` +
      `${undeclared > 0 ? `, ${undeclared} declaring no licence` : ""})`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("gen-third-party-licenses.mjs")) {
  main();
}
