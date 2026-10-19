// The pinned-digest guard: every `ghcr.io/…@sha256:<64 hex>` this project publishes to a
// self-hoster must RESOLVE, and the server image must resolve to a manifest list that
// carries both architectures.
//
// ── The failure this prevents ─────────────────────────────────────────────────
//
// Four files pin the server image by digest (the bundle's compose, its env example, the
// user guide's compose block, and the Helm chart's `values.yaml`), and the guide pins the
// web image too. A digest is opaque: a transposed character is not visible in review, the
// file renders, and the failure lands at the self-hoster as `manifest unknown` — or, for
// the tag-pinned case, as `exec format error` on an arm64 host while the amd64 path stays
// green. Measured on the real registry while writing this:
//
//   ghcr.io/myne-md/myne-server:0.8.0   -> a SINGLE amd64 manifest (not a manifest list)
//   ghcr.io/myne-md/myne-web:0.8.0      -> a list whose only real platform is amd64
//   ghcr.io/myne-md/myne-server:v0.9.0  -> does not exist at all, while two files claimed it
//
// ── Why this is pre-commit and NOT CI ────────────────────────────────────────
//
// It is the one guard here that needs the network, and a network dependency in a pipeline
// gate makes a red pipeline mean "GitHub was slow". The release-time gate is
// `operations/scripts/check-image-multiarch.sh` (run by the publish script and by the release
// checklist); this is the local net that catches a pin edited by hand, and it says out loud
// when it could not reach the registry rather than reporting a pass.
//
// Scope, stated rather than implied: `ghcr.io` only, because that is where this project
// publishes. The compose files also pin `docker.io/library/caddy` by digest, which is NOT
// checked here — a different registry's API, an upstream artifact this project does not
// build, and a broken one fails loudly at `docker compose up` rather than silently.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = (name) => [resolve(ROOT, name), resolve(ROOT, "..", "..", "..", name)];
const pick = (name, marker) =>
  CANDIDATES(name).find((c) => existsSync(join(c, marker))) ?? CANDIDATES(name)[0];

const OPS = process.env.MYNE_OPS_DIR ? resolve(process.env.MYNE_OPS_DIR) : pick("operations", "bundle");
const SERVER = process.env.MYNE_SERVER_DIR
  ? resolve(process.env.MYNE_SERVER_DIR)
  : pick("myne-server", "go.mod");
const WEBSITE = process.env.MYNE_WEBSITE_DIR
  ? resolve(process.env.MYNE_WEBSITE_DIR)
  : pick("myne-website", join("src", "content", "user-guide"));

/** Files that may carry a pin, and which are present in a given checkout. Every entry that
 * is absent is reported as UNCHECKED rather than silently skipped: a scan that covers less
 * than its name claims is the failure this file's neighbours exist to prevent. The split and
 * the floor below are declared after `OPS`/`SERVER`/`WEBSITE` are resolved. */

const DIGEST_RE = /ghcr\.io\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})/g;
/** A TAG reference, restricted to a release-shaped tag.
 *
 * The repo character class excludes `@`, so a digest reference cannot match here — which is
 * what keeps this from reporting `@sha256` as a tag. The version shape matters for a second
 * reason: these sources are PROSE as well as YAML, and a guard that fires on an illustrative
 * `ghcr.io/…:<tag>` or on a moving `:latest` (which is not a pin, and which the guide tells
 * operators not to use) would be a guard people learn to route around. */
const TAG_RE = /ghcr\.io\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+):(v?\d+\.\d+\.\d+)/g;

/** The pins live in the COMPANIONS (the bundle, the chart, the guide). When none of those is
 * present this cannot verify anything, and the honest answer is to say so rather than to fail
 * a fresh clone for being a fresh clone. `--require-companion` turns that into a failure. */
const COMPANION_SOURCES = [
  join(OPS, "bundle", "docker-compose.yml"),
  join(OPS, "bundle", "bundle.env.example"),
  join(SERVER, "deploy", "helm", "myne-server", "values.yaml"),
  join(SERVER, "deploy", "helm", "myne-web", "values.yaml"),
  join(WEBSITE, "src", "content", "user-guide", "sync-and-devices", "run-your-own-sync-server.md"),
  join(WEBSITE, "src", "content", "user-guide", "getting-started", "run-your-own-browser-client.md"),
];

/** Files in THIS repository that might name an image. Scanned when they exist, never counted
 * as coverage: they carry the prose references, not the pins. */
const REPO_SOURCES = [join(ROOT, "docs", "self-host-policy.md"), join(ROOT, "docs", "self-host-web.md")];

const SOURCES = [...COMPANION_SOURCES, ...REPO_SOURCES];

/** The minimum this guard will scan before it stops believing itself. MEASURED on the real
 * tree at the branch tip: 2 — one unique server digest (pinned in four files: the bundle's
 * compose, its env example, the chart's `values.yaml` and the guide's compose block) and one
 * web tag (the web chart's default `v0.8.1`, which the guide's compose block now names too).
 * The floor is the measurement, not a guess, so losing a pin entirely fails by name — which is
 * the drift this exists for.
 *
 * **It was 3, and the drop to 2 is the fix rather than a loss.** The guide's compose block
 * pinned `myne-web:0.8.0` while the chart deployed `v0.8.1`, which is two published tags for
 * one product; the audit's A5 fix made the block name the chart's tag, so the two web
 * references COLLAPSED into one unique pin. That is what "one release" means, and it is why
 * the second web reference is no longer a separate entry in the measured set
 * (`check-web-image-tag-drift.mjs` now holds the pair together). */
const REF_FLOOR = 2;

/** The server image must be a manifest list carrying both of these. The WEB image is
 * deliberately exempt: it is amd64-only today (a documented gap with its own decision to
 * make, `operations/runbooks/release.md` FAZ 5), and a guard that is permanently red is a
 * guard people learn to ignore. This one asserts the claim the project makes; that claim
 * is about the server image. */
const REQUIRED_ARCHES = ["amd64", "arm64"];
const MULTIARCH_REPOS = ["myne-md/myne-server"];

/** The registry base. A NAMED SEAM, not a behaviour switch: it exists so a test can point the
 * guard at a dead port and drive the "could not reach the registry" path, which is otherwise
 * only reachable by disconnecting the machine. Default is the real registry. */
const REGISTRY = process.env.MYNE_REGISTRY_BASE ?? "https://ghcr.io";

async function ghcrToken(repoPath) {
  const url = `${REGISTRY}/token?scope=repository:${repoPath}:pull&service=ghcr.io`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const body = await res.json();
  return body.token ?? null;
}

async function resolveManifest(repoPath, reference) {
  const token = await ghcrToken(repoPath);
  if (!token) return { ok: false, reason: "no anonymous pull token (private package, or ghcr.io unreachable)" };
  const accept =
    "application/vnd.oci.image.index.v1+json," +
    "application/vnd.docker.distribution.manifest.list.v2+json," +
    "application/vnd.oci.image.manifest.v1+json," +
    "application/vnd.docker.distribution.manifest.v2+json";
  const res = await fetch(`${REGISTRY}/v2/${repoPath}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return { ok: false, reason: "does not exist (404)" };
  if (!res.ok) return { ok: false, reason: `registry answered HTTP ${res.status}` };
  const ctype = res.headers.get("content-type") ?? "";
  const isIndex = ctype.includes("manifest.list") || ctype.includes("image.index");
  const body = await res.json();
  const arches = isIndex
    ? [...new Set((body.manifests ?? []).map((m) => m?.platform?.architecture).filter(Boolean))]
    : null;
  return { ok: true, isIndex, arches, digest: res.headers.get("docker-content-digest") };
}

const failures = [];
const notes = [];
const unchecked = [];
const fail = (m) => failures.push(m);

/** Does any companion exist? If not, this run cannot verify a pin and says so. */
const companionsPresent = COMPANION_SOURCES.some((f) => existsSync(f));

/** `--require-companion` turns the absent branch into a failure, for a caller that knows
 * better than "the companions are not here". Same escape hatch `check-server-env-roster.mjs`
 * exposes, and for the same reason. */
const REQUIRE_COMPANION = process.argv.includes("--require-companion");

// --- collect ------------------------------------------------------------------

/** ref → { kind, repo, reference, files }, so a failure names where to look. */
const refs = new Map();
function record(repo, reference, kind, file) {
  const key = `${repo}@${reference}`;
  if (!refs.has(key)) refs.set(key, { kind, repo, reference, files: [] });
  const entry = refs.get(key);
  const shown = file.slice(ROOT.length + 1);
  if (!entry.files.includes(shown)) entry.files.push(shown);
}

/** The HELM shape: `repository:` and `digest:`/`tag:` as sibling fields, so there is no
 * `ghcr.io/…@sha256:…` string for the patterns above to find. Without this the chart's pin —
 * the one operators never edit and the one a release must bump — was invisible to the scan,
 * which reported "2 references" over a tree that pins three. */
const IMAGE_REPO_FIELD = /^\s*repository:\s*(ghcr\.io\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\s*$/m;
const IMAGE_DIGEST_FIELD = /^\s*digest:\s*(sha256:[0-9a-f]{64})\s*$/m;
const IMAGE_TAG_FIELD = /^\s*tag:\s*"?(v?\d+\.\d+\.\d+)"?\s*$/m;

for (const file of SOURCES) {
  if (!existsSync(file)) {
    unchecked.push(file);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(DIGEST_RE)) record(m[1], m[2], "digest", file);
  // Strip the digest references first, so a tag scan cannot see the `sha256:` half of one.
  const withoutDigests = text.replace(DIGEST_RE, "<digest>");
  for (const m of withoutDigests.matchAll(TAG_RE)) record(m[1], m[2], "tag", file);

  const repoField = text.match(IMAGE_REPO_FIELD);
  if (repoField) {
    const digestField = text.match(IMAGE_DIGEST_FIELD);
    if (digestField) record(repoField[1].replace(/^ghcr\.io\//, ""), digestField[1], "digest field", file);
    else {
      const tagField = text.match(IMAGE_TAG_FIELD);
      if (tagField) record(repoField[1].replace(/^ghcr\.io\//, ""), tagField[1], "tag field", file);
    }
  }
}

if (refs.size < REF_FLOOR) {
  if (companionsPresent) {
    failures.push(
      `the scan found ${refs.size} pinned ghcr reference(s) while the companions are present,\n` +
        `         below the floor of ${REF_FLOOR}, so this guard is vacuous. Either the pins moved\n` +
        `         into files this list does not carry, or the shape of a reference changed.\n` +
        `         Failing by name rather than printing a pass over nothing.`,
    );
  } else {
    const message =
      "no companion carries the pins, so NOTHING was verified.\n" +
      `            Looked in: ${[...new Set([OPS, SERVER, WEBSITE])].join(", ")}\n` +
      "            This is the branch that runs in CI and in a fresh clone. The pins live in the\n" +
      "            bundle, the chart and the guide; set MYNE_OPS_DIR / MYNE_SERVER_DIR /\n" +
      "            MYNE_WEBSITE_DIR to check copies that live elsewhere.";
    if (REQUIRE_COMPANION) {
      fail(`--require-companion was passed and ${message}`);
    } else {
      notes.push("SKIPPED: " + message + "\n            Exit 0 here is an absence of evidence, not a pass.");
      console.log(`note: ${notes[notes.length - 1]}`);
      console.log("ok: NOTHING VERIFIED (no companion). This line is not a verdict on the pins.");
      process.exit(0);
    }
  }
}

// --- resolve ------------------------------------------------------------------

const offline = [];
for (const [key, entry] of [...refs].sort()) {
  let result;
  try {
    result = await resolveManifest(entry.repo, entry.reference);
  } catch (e) {
    offline.push(`${key} (${e.name === "TimeoutError" ? "timed out" : e.message})`);
    continue;
  }
  const pinned = `\n           pinned by: ${entry.files.join(", ")}`;
  if (!result.ok) {
    failures.push(
      `${key} (a ${entry.kind} reference)${pinned}\n           ${result.reason}\n` +
        `           A pin that names nothing is worse than a stale one: it fails far from here, at\n` +
        `           an operator's 'docker compose up'.`,
    );
    continue;
  }
  if (MULTIARCH_REPOS.includes(entry.repo)) {
    if (!result.isIndex) {
      failures.push(
        `${key}${pinned}\n` +
          `           resolves to a SINGLE-platform manifest, not a manifest list. On an arm64\n` +
          `           host that is 'exec format error', with nothing on the amd64 path to notice.\n` +
          `           Publish with operations/scripts/publish-server-image.sh, which builds both\n` +
          `           platforms as one list and verifies the result.`,
      );
      continue;
    }
    const missing = REQUIRED_ARCHES.filter((a) => !result.arches.includes(a));
    if (missing.length) {
      failures.push(
        `${key}${pinned}\n` +
          `           is a manifest list missing: ${missing.join(", ")} (has: ${result.arches.join(", ") || "none"})`,
      );
      continue;
    }
    notes.push(`ok ${key} (${entry.kind})${pinned}\n    architectures: ${result.arches.join(" ")}`);
  } else {
    notes.push(`ok ${key} (${entry.kind})${pinned}`);
  }
}

// --- report -------------------------------------------------------------------

for (const n of notes) console.log(`note: ${n}`);
if (unchecked.length) {
  console.log(
    `note: UNCHECKED (absent from this checkout, so any pin it carries was not verified):\n` +
      unchecked.map((f) => `        ${f.slice(ROOT.length + 1)}`).join("\n"),
  );
}
if (offline.length) {
  console.log(
    `note: COULD NOT REACH the registry for ${offline.length} reference(s), so they are NOT\n` +
      `      verified: ${offline.join("; ")}\n` +
      `      This is not a pass. Re-run where ghcr.io is reachable.`,
  );
}

if (failures.length) {
  console.error(`\ncheck-referenced-digests: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

const verified = notes.filter((n) => n.startsWith("ok ")).length;
console.log(
  verified > 0
    ? `ok: ${verified} pinned reference(s) resolve${offline.length ? `, ${offline.length} NOT verified (no network)` : ""}`
    : "ok: NOTHING VERIFIED (offline, or no pins found). This line is not a verdict on the pins.",
);
