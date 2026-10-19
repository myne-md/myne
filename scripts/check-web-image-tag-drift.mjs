#!/usr/bin/env node
// The web client's image tag is written in three places, and they must name one
// release (audit 2026-10-18 A5, fixed 2026-10-19).
//
// # The failure this prevents
//
// `myne-server/deploy/helm/myne-web/values.yaml` pins the image the chart
// deploys; `Chart.yaml` carries the chart's own version (Helm's `--version`); and
// the user guide tells a self-hoster what to run, in two forms on ONE page — a
// compose `image:` and a `helm install --version`. Measured on 2026-10-19 that
// page said `myne-web:0.8.0` in the compose block and `--version 0.8.1` in the
// Kubernetes block, while the chart deploys tag `v0.8.1`: **two different
// releases, one page, neither sentence wrong on its own.**
//
// Nothing compared them. `check-referenced-digests.mjs` resolves each tag against
// the registry, and both `0.8.0` and `v0.8.1` DO resolve, so "it resolves" is not
// the question. `check-release-versions.sh` (in `myne-ops`) compares the shipped
// version across the repos' own manifests and never reads a guide page. And a
// Helm `--version` is a CHART version rather than the app's, so no rule that
// compares app versions catches the pair either.
//
// # The three rules
//
//   1. `image.tag` in the chart's `values.yaml` equals `v` + `Chart.yaml`'s
//      `version`. Two files in one chart, and the chart is what a Kubernetes
//      self-hoster actually runs.
//   2. Every `ghcr.io/myne-md/myne-web:<tag>` in the user guide equals that tag.
//   3. In any guide page carrying such a literal, every `--version <n>` equals
//      the chart's version. That is the pair the audit found, on one page.
//
// # Companions, like its neighbours
//
// The chart lives in `myne-server` and the guide in `myne-website`. In CI and in
// a fresh clone BOTH ARE ABSENT, so this prints what it could not check rather
// than a verdict; `--require-companion` turns that into a failure for a caller
// that knows better. `MYNE_SERVER_DIR` / `MYNE_WEBSITE_DIR` override the
// locations. It needs no network: the tags it compares are literals in three
// files, and whether they still resolve is `check-referenced-digests.mjs`'s job,
// by hand, before a publish.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATES = (name) => [resolve(ROOT, name), resolve(ROOT, "..", "..", "..", name)];
const pick = (name, marker) =>
  CANDIDATES(name).find((c) => existsSync(join(c, marker))) ?? CANDIDATES(name)[0];

const SERVER = process.env.MYNE_SERVER_DIR
  ? resolve(process.env.MYNE_SERVER_DIR)
  : pick("myne-server", join("deploy", "helm", "myne-web", "Chart.yaml"));
const WEBSITE = process.env.MYNE_WEBSITE_DIR
  ? resolve(process.env.MYNE_WEBSITE_DIR)
  : pick("myne-website", join("src", "content", "user-guide"));

const CHART = join(SERVER, "deploy", "helm", "myne-web", "Chart.yaml");
const VALUES = join(SERVER, "deploy", "helm", "myne-web", "values.yaml");
const GUIDE_DIR = join(WEBSITE, "src", "content");

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);

/** The first `version:` / `tag:` scalar of a YAML file, unquoted. */
function scalar(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*("?)([^"\\n#]+)\\1\\s*$`, "m"));
  return m ? m[2].trim() : null;
}

/** Every `ghcr.io/myne-md/myne-web:<tag>` reference in `text`. */
const tagRefs = (text) => [...text.matchAll(/ghcr\.io\/myne-md\/myne-web:([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
/** Every `--version <n>` in `text`. */
const chartVersionRefs = (text) => [...text.matchAll(/--version\s+([0-9][A-Za-z0-9._-]*)/g)].map((m) => m[1]);

/** Every `.md` file under `dir`, repo-relative to it. */
function markdownFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const chartPresent = existsSync(CHART) && existsSync(VALUES);
const guidePresent = existsSync(GUIDE_DIR);
const REQUIRE_COMPANION = process.argv.includes("--require-companion");
let compared = false;

if (!chartPresent && !guidePresent) {
  const message =
    "neither the myne-server chart nor the myne-website guide is present, so NOTHING was compared.\n" +
    `            Looked in: ${CHART}\n                      ${GUIDE_DIR}\n` +
    "            This is the branch that runs in CI and in a fresh clone. Set MYNE_SERVER_DIR and\n" +
    "            MYNE_WEBSITE_DIR to check a pair that lives elsewhere.";
  if (REQUIRE_COMPANION) fail(`--require-companion was passed and ${message}`);
  else notes.push("SKIPPED: " + message + "\n            Exit 0 here is an absence of evidence, not a pass.");
} else if (!chartPresent || !guidePresent) {
  notes.push(
    `PARTIAL: ${!chartPresent ? `the chart is absent at ${CHART}` : `the guide is absent at ${GUIDE_DIR}`}, ` +
      "so the rules that need both were not evaluated.",
  );
} else {
  compared = true;
  const chartVersion = scalar(readFileSync(CHART, "utf8"), "version");
  const imageTag = scalar(readFileSync(VALUES, "utf8"), "tag");

  if (chartVersion === null) {
    fail(`${relative(ROOT, CHART)}: no \`version:\` found. This guard is looking at the wrong shape.`);
  }
  if (imageTag === null) {
    fail(`${relative(ROOT, VALUES)}: no \`tag:\` found. A chart with no image tag is not deployable.`);
  }

  // --- rule 1: one chart, one release ----------------------------------------
  if (chartVersion !== null && imageTag !== null && imageTag !== `v${chartVersion}`) {
    fail(
      `the chart deploys a different release than it is versioned as:\n` +
        `           Chart.yaml  version: ${chartVersion}\n` +
        `           values.yaml image.tag: ${imageTag}\n` +
        `         A self-hoster installing with \`--version ${chartVersion}\` runs the image in\n` +
        `         values.yaml, so the tag is what has to agree.`,
    );
  }

  // --- rules 2 and 3, per guide page ----------------------------------------
  let pagesWithTag = 0;
  for (const file of markdownFiles(GUIDE_DIR)) {
    const text = readFileSync(file, "utf8");
    const tags = tagRefs(text);
    if (tags.length === 0) continue;
    pagesWithTag++;
    const rel = relative(ROOT, file);
    for (const tag of tags) {
      if (imageTag !== null && tag !== imageTag) {
        fail(
          `${rel}: names the web image tag \`${tag}\`, and the chart deploys \`${imageTag}\`.\n` +
            `         Two published tags can both resolve, so this is not a broken link: it is the\n` +
            `         compose path and the Kubernetes path serving different builds of one product.`,
        );
      }
    }
    for (const v of chartVersionRefs(text)) {
      if (chartVersion !== null && v !== chartVersion) {
        fail(
          `${rel}: installs the chart with \`--version ${v}\` while the chart is versioned\n` +
            `         ${chartVersion}, and the same page carries a web-image tag. One page, two\n` +
            `         releases; update both or neither.`,
        );
      }
    }
  }
  if (pagesWithTag === 0) {
    // A scan that finds no reference passes every rule inside it. The guide is
    // where a self-hoster reads the tag from, so an empty set is a broken input
    // rather than a clean tree.
    fail(
      `no user-guide page under ${relative(ROOT, GUIDE_DIR)} references a\n` +
        `         \`ghcr.io/myne-md/myne-web:<tag>\` image, so rules 2 and 3 were not evaluated.`,
    );
  }

  notes.push(
    `Compared the myne-web chart (version ${chartVersion}, image tag ${imageTag}) against ` +
      `${pagesWithTag} guide page(s) that name the image.`,
  );
  notes.push(
    "NOT checked: whether either tag still RESOLVES, or whether the chart is the release anybody\n" +
      "            meant. Resolution is `check-referenced-digests.mjs` (needs the network, by hand).",
  );
}

for (const n of notes) console.log(`note: ${n}`);
if (failures.length > 0) {
  console.error(`\ncheck-web-image-tag-drift: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(
  compared
    ? "ok: the web chart and every guide page that names its image agree on one release"
    : "ok: NOTHING COMPARED (a companion is absent). This line is not a verdict.",
);
