#!/usr/bin/env node
// The desktop bundle's DECLARED payload, as a ratchet (ai-bundle-slim myne#190
// task 2). Modelled beat-for-beat on `check-web-bundle-budget.mjs`.
//
// # What this number is, and what it is NOT
//
// It is the byte total of everything the bundle configuration *declares* it
// will carry: every path under `bundle.resources`, plus `bundle.externalBin`
// and the release binary when a build has produced them.
//
// It is **not** the size of a DMG, an AppImage or a `.deb`. Those are
// compressed, they carry framework and installer chrome this script cannot see,
// and — the reason that matters — **CI never builds one**: `tauri-compile` runs
// `pnpm tauri build --no-bundle`, so there is no artifact on the Linux runner to
// measure. The declared payload is the measurable-in-CI proxy, and it is a good
// one because weights are incompressible: `bundle.resources` alone is ~650 MiB
// of the download, and a change there moves the installer ~1:1.
//
// So: a green run here means "the declared payload did not grow past the
// margin". It does not mean the installer did not grow, and it says nothing
// about a dependency that bloats the binary without touching a resource path —
// except through the `binary` component, which is only compared after a build.
//
// # Why a ratchet and not a number
//
// A budget invented before the payload exists is either trivially met or
// violated immediately. The baseline here was MEASURED from the tree, and this
// script's only opinion is that it must not grow much. Growth past the margin
// fails, which makes a payload increase a decision someone records rather than
// a drift nobody sees. `--update` re-baselines — deliberately an edit to a
// committed file, so it shows up in a diff with a number and an author.
//
// # `marginPct: 2`, not the web guard's 10
//
// 10% of a 650 MiB payload is 65 MiB of invisible growth — more than the whole
// whisper model. 2% (≈13 MiB) absorbs a dictionary update and stops a model.
//
// # Where the baseline lives, and why
//
// `src-tauri/payload-baseline.json`, beside the `tauri.conf.json` it measures —
// following `web/bundle-baseline.json`, which sits beside the thing it measures
// rather than in a baselines drawer. A reader who opens the bundle config to
// change `bundle.resources` sees the baseline in the same directory listing.
//
// # Three structural assertions, each covering a way the number could lie
//
//  1. **No measured file is a Git-LFS pointer.** A `GIT_LFS_SKIP_SMUDGE=1`
//     checkout turns `model.gguf` and the `.rten` weights into ~133-byte text
//     files beginning `version https://git-lfs.github.com/spec/v1`. Undetected,
//     the guard reports a tiny payload and passes forever — the failure mode of
//     every scanning guard.
//  2. **Every declared path exists.** A renamed directory must fail, not
//     silently contribute zero bytes.
//  3. **The `models/*` mapping set equals a recorded set, compared BOTH ways.**
//     An addition fails (a new bundled model is a decision). A removal fails
//     too — a silently dropped `models/ocr` breaks OCR-backed search, which
//     `src-tauri/scripts/ai-no-network-check.sh` check 3 guards on the code
//     side and nothing guarded on the packaging side. Bidirectional comparison
//     is `core/src/plugins/sync/no_bypass.rs`'s shape.

import { readFileSync, existsSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = join(ROOT, "src-tauri");
const CONF = join(TAURI_DIR, "tauri.conf.json");
const BASELINE = join(TAURI_DIR, "payload-baseline.json");

/**
 * Components the baseline GATES. Everything else is measured and printed but
 * never compared, because a number nobody can reproduce is not a ratchet:
 *
 *  - `resources` is committed, buildless and identical in every checkout, so it
 *    is the same number on a laptop and on the Linux runner. It gates.
 *  - `externalBin` depends on **which target triples happen to be staged** in
 *    `src-tauri/binaries/` — a developer who has cross-built for four triples
 *    measures four times the payload of a release that ships one. Recording
 *    that would enshrine one machine's staging as the budget.
 *  - `binary` exists only after a release build, and differs by target.
 *
 * Adding one here is a deliberate act: it means someone recorded it from a
 * controlled build and is prepared to defend the number.
 */
export const BASELINED = ["resources"];

/** The bundled-model set this build is allowed to declare. Both directions are
 *  compared against it: an addition and a removal are equally loud. */
export const EXPECTED_MODELS = ["ocr", "whisper"];

/** Git LFS pointer files begin with this exact line. */
const LFS_HEADER = "version https://git-lfs.github.com/spec/v1";

/**
 * Whether `buf` is a Git-LFS pointer rather than the blob it stands for.
 *
 * Reads only the first bytes: a real `.gguf` or `.rten` is hundreds of
 * megabytes and must never be slurped to answer this.
 */
export function isLfsPointer(buf) {
  return buf.subarray(0, LFS_HEADER.length).toString("latin1") === LFS_HEADER;
}

/** The `bundle.resources` source paths, relative to `src-tauri/`. */
export function declaredPaths(conf) {
  const res = conf?.bundle?.resources ?? {};
  return Array.isArray(res) ? [...res] : Object.keys(res);
}

/** The `models/<name>` mappings a config declares, as a sorted set. */
export function modelMappings(conf) {
  const names = declaredPaths(conf)
    .map((p) => /(?:^|\/)resources\/models\/([^/]+)\/?$/.exec(p)?.[1])
    .filter((n) => typeof n === "string");
  return [...new Set(names)].sort();
}

/** Both-directions comparison. Returns `{ added, removed }`, both sorted. */
export function compareModelSets(found, expected) {
  const f = new Set(found);
  const e = new Set(expected);
  return {
    added: [...f].filter((n) => !e.has(n)).sort(),
    removed: [...e].filter((n) => !f.has(n)).sort(),
  };
}

/** Every regular file under `abs`, recursively — or `[abs]` when it is a file. */
function filesUnder(abs) {
  const st = statSync(abs);
  if (!st.isDirectory()) return [abs];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    out.push(...filesUnder(join(abs, entry.name)));
  }
  return out;
}

/**
 * Total the bytes under each of `paths` (relative to `base`).
 *
 * Returns `{ bytes, files, missing, pointers }`. A missing path is reported
 * rather than skipped, and an LFS pointer is reported rather than counted —
 * both are ways the total could silently become meaningless.
 */
export function measure(base, paths, io = { statSync, readFileSync, existsSync }) {
  let bytes = 0;
  let files = 0;
  const missing = [];
  const pointers = [];
  const perPath = [];
  for (const rel of paths) {
    const abs = join(base, rel);
    if (!io.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const before = bytes;
    for (const f of filesUnder(abs)) {
      const size = io.statSync(f).size;
      // Only a small file can be a pointer; reading every weight to check
      // would defeat the purpose of a fast guard.
      if (size < 1024 && isLfsPointer(io.readFileSync(f))) {
        pointers.push(f.slice(base.length + 1));
        continue;
      }
      bytes += size;
      files += 1;
    }
    perPath.push({ path: rel, bytes: bytes - before });
  }
  // Sorted here so a failure can name the largest contributors without the
  // caller re-deriving them — "it grew" is not actionable, "tag is 475 MiB" is.
  perPath.sort((a, b) => b.bytes - a.bytes);
  return { bytes, files, missing, pointers, perPath };
}

/** Whether `measured` is within `marginPct` of `baseline`. */
export function withinBudget(measured, baseline, marginPct) {
  return measured <= Math.floor(baseline * (1 + marginPct / 100));
}

function mib(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** The externalBin paths a staged build would have produced, per triple. */
function externalBinPaths(conf) {
  const declared = conf?.bundle?.externalBin ?? [];
  const dir = join(TAURI_DIR, "binaries");
  if (!existsSync(dir)) return [];
  const staged = readdirSync(dir);
  return declared.flatMap((d) => {
    const stem = d.split("/").pop();
    return staged.filter((f) => f === stem || f.startsWith(`${stem}-`)).map((f) => join("binaries", f));
  });
}

function main() {
  const update = process.argv.includes("--update");
  const conf = JSON.parse(readFileSync(CONF, "utf8"));

  // ---- assertion 3: the bundled-model set, both directions -----------------
  const { added, removed } = compareModelSets(modelMappings(conf), EXPECTED_MODELS);
  if (added.length > 0 || removed.length > 0) {
    console.error(
      "desktop payload: the bundled-model set changed.\n" +
        (added.length ? `    added:   ${added.join(", ")} — a new bundled model is a decision, not a drift.\n` : "") +
        (removed.length ? `    removed: ${removed.join(", ")} — dropping one breaks the feature it serves (models/ocr is OCR-backed search).\n` : "") +
        `  If deliberate, update EXPECTED_MODELS in ${"scripts/check-desktop-payload-budget.mjs"} and say why in the commit.`,
    );
    process.exit(1);
  }

  // ---- resources: mandatory, buildless -------------------------------------
  const paths = declaredPaths(conf);
  const resources = measure(TAURI_DIR, paths);
  if (resources.missing.length > 0) {
    console.error(
      `desktop payload: declared resource path(s) missing — a renamed directory must fail, not count as zero:\n` +
        resources.missing.map((p) => `    ${p}`).join("\n"),
    );
    process.exit(1);
  }
  if (resources.pointers.length > 0) {
    console.error(
      "desktop payload: Git-LFS pointer(s) found where a blob was expected — this checkout has no real weights,\n" +
        "so any total measured from it is meaningless (a green run here would be the guard lying):\n" +
        resources.pointers.map((p) => `    ${p}`).join("\n") +
        "\n  Run `git lfs pull`, or add `lfs: true` to the CI clone step.",
    );
    process.exit(1);
  }
  if (resources.bytes === 0 || resources.files === 0) {
    // The zero-assets rule: a scan that matches nothing reports a 0-byte
    // payload and passes forever.
    console.error("desktop payload: measured zero resource bytes — the scan is broken.");
    process.exit(1);
  }

  // ---- optional components: compared only when a build produced them -------
  const components = { resources: resources.bytes };
  const notMeasured = [];

  const binPaths = externalBinPaths(conf);
  if (binPaths.length > 0) {
    components.externalBin = measure(TAURI_DIR, binPaths).bytes;
  } else {
    notMeasured.push("externalBin (run `pnpm sidecar` to stage it)");
  }

  const binary = join(ROOT, "target", "release", "myne-desktop");
  if (existsSync(binary)) {
    components.binary = statSync(binary).size;
  } else {
    notMeasured.push("binary (run `pnpm tauri build --no-bundle`)");
  }

  if (update || !existsSync(BASELINE)) {
    const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
    const next = {
      note:
        "Measured from the tree with `node scripts/check-desktop-payload-budget.mjs --update`. " +
        "Only components in the script's BASELINED list are recorded and gated — today just " +
        "`resources`, the one that is committed, buildless and identical in every checkout. " +
        "`externalBin` and `binary` are measured and printed on runs that have them, and " +
        "deliberately not gated: their size depends on which target triples happen to be staged.",
      marginPct: prev?.marginPct ?? 2,
      marginReason:
        "2%, not the web guard's 10: 10% of a ~650 MiB payload is 65 MiB of invisible growth — more than the whole whisper model. 2% absorbs a dictionary update and stops a model.",
      components: {
        ...(prev?.components ?? {}),
        ...Object.fromEntries(
          Object.entries(components).filter(([k]) => BASELINED.includes(k)),
        ),
      },
    };
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `desktop payload: baseline written — ${Object.entries(components)
        .filter(([k]) => BASELINED.includes(k))
        .map(([k, v]) => `${k} ${mib(v)}`)
        .join(", ")} (gated); ` +
        `measured but not gated: ${Object.keys(components)
          .filter((k) => !BASELINED.includes(k))
          .join(", ") || "none"}.`,
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const failures = [];
  const contributors = resources.perPath
    .slice(0, 5)
    .map((p) => `        ${p.path} — ${mib(p.bytes)}`)
    .join("\n");
  for (const [name, measured] of Object.entries(components)) {
    const base = baseline.components?.[name];
    if (typeof base !== "number") continue;
    if (!withinBudget(measured, base, baseline.marginPct)) {
      const pct = (((measured - base) / base) * 100).toFixed(1);
      failures.push(
        `    ${name}: ${mib(measured)} — ${pct}% over the ${mib(base)} baseline ` +
          `(cap ${mib(Math.floor(base * (1 + baseline.marginPct / 100)))})` +
          (name === "resources" ? `\n      largest contributors:\n${contributors}` : ""),
      );
    }
  }
  if (failures.length > 0) {
    console.error(
      `desktop payload: FAIL — the declared payload grew past the ${baseline.marginPct}% margin.\n` +
        failures.join("\n") +
        "\n  Either shrink it, or re-baseline with `--update` and say why in the commit.",
    );
    process.exit(1);
  }

  const summary = Object.entries(components)
    .map(([k, v]) => `${k} ${mib(v)}`)
    .join(", ");
  console.log(
    `desktop payload: ok — ${summary} (${resources.files} resource file(s), ` +
      `models {${modelMappings(conf).join(", ")}})` +
      (notMeasured.length > 0 ? `; not measured: ${notMeasured.join(", ")}` : ""),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
