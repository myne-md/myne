#!/usr/bin/env node
// The published update manifests: both reachable, both pointing at real
// artefacts, and the beta one never BEHIND the stable one.
//
// # The failure this prevents
//
// It happened on v0.10.0, and the release evidence records it
// (`private-companion/releases/v0.10.0.md`): the stable manifest was published, the
// beta one was not, and every beta install reported "you are on the latest
// version" while a newer release sat on the other channel. The maintainer's own
// install was a beta build, so this was not a hypothetical user. Nothing
// reported it, because a client only ever reads its own channel's document and
// nothing compares the two.
//
// The rule is `decisions/clients/0701`: **the beta document is never older than
// the stable one**, so every version published to stable is offered to beta
// installs too. A beta manifest AHEAD of stable is legitimate and is the normal
// prerelease case; a beta manifest BEHIND it means a release was published to
// one channel only.
//
// The publishing half of the same rule is `emit-update-manifest.mjs --channel
// both`, which writes the two files from one descriptor. This script is the
// check that the publish actually happened, which is the half a rule cannot
// enforce from inside the build.
//
// # Why this runs BY HAND, and not in pre-commit or CI
//
// It reads the live origin, so it can only answer about a release that has
// already been published, and running it on every commit would make a red
// pipeline mean "the network was slow". It is a publish precondition, the same
// shape as `check-bundle-record.mjs --has` and `runbook/scripts/check-image-multiarch.sh`:
// it is named in `runbook/runbooks/desktop-self-update-publish.md` and in
// phase 8 of the release checklist, and it runs from the machine that published.
//
// Like its network-bound sibling `scripts/check-referenced-digests.mjs`, an
// unreachable origin prints what it could NOT check and exits 0 with an
// explicit "not a verdict", rather than reporting a pass.
//
// # What it does NOT cover, stated so it is not mistaken for more
//
// It does not verify a signature and it does not download an artefact: a HEAD
// says the URL resolves, not that the bytes are good. That is the client's own
// check at install time (minisign against the offline release key, which cannot
// be disabled), and re-implementing it here would be a second crypto path.
//
// What it does check is the ENVELOPE the updater parses, because that is the half
// that fails silently. See `signatureEnvelope` below: v0.11.3 published every
// platform's signature one encoding too deep and every other gate was green.
//
// And what it does check is the VERSION the signature was signed for
// (`signedVersion` below), a different question from the envelope and one that was
// green for two releases without being asked. This client ships
// `requireSignedVersion: true`, so `tauri-plugin-updater` refuses an artefact whose
// trusted comment names no version: `MissingSignedVersion`, raised AFTER the whole
// download. `tauri build` embeds the field itself; `tauri signer sign` omits it
// unless given `--app-version`, and prints only a warning, so a hand-signed
// artefact verifies cryptographically and is still un-installable. v0.11.3 shipped
// that on every platform and v0.11.4 on macOS alone (208 MB re-downloaded per
// retry, and the update screen states no cause by design).
//
// It does not read the `.sig` files beside the artefacts, which nothing fetches:
// the signature travels INSIDE the manifest.
//
// Zero dependencies, hand-runnable:
//   node scripts/check-published-manifests.mjs
//   MYNE_DOWNLOADS_BASE=https://… node scripts/check-published-manifests.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { manifestFilename } from "./emit-update-manifest.mjs";

/**
 * The origin the manifests live under.
 *
 * A NAMED SEAM, not a behaviour switch: it exists so a test can point this at a
 * fixture server, and so the "could not reach" path is drivable without
 * disconnecting the machine. Default is the real origin.
 */
const BASE = process.env.MYNE_DOWNLOADS_BASE ?? "https://downloads.myne.md/releases/";

/** The two channels, in the order the rule is stated: stable first. */
const CHANNELS = ["stable", "beta"];

/** A version this guard is willing to order. Myne's manifests carry `X.Y.Z`,
 * optionally with a prerelease suffix, and a value outside that shape means the
 * rule cannot be evaluated rather than that the rule passed. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Compare two parsed versions. -1, 0 or 1.
 *
 * Semver's numeric triple, then prerelease presence: `1.2.3` outranks
 * `1.2.3-rc.1`. Two prereleases are compared on their identifier strings, which
 * is NOT the full semver rule (numeric identifiers would sort numerically) and
 * is stated here rather than implied: the question this guard answers is
 * "is beta behind stable", and that answer does not turn on the ordering of two
 * prereleases. */
function compareVersions(a, b) {
  for (const key of [0, 1, 2]) {
    if (a.numbers[key] !== b.numbers[key]) return a.numbers[key] < b.numbers[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Parse `X.Y.Z[-pre]`, or null with a recorded failure naming the channel. */
function parseVersion(text, channel, failures) {
  const m = typeof text === "string" ? VERSION_RE.exec(text) : null;
  if (m === null) {
    failures.push(
      `${manifestFilename(channel)}: version ${JSON.stringify(text)} is not a \`X.Y.Z\` semver, ` +
        `so the "beta is never behind stable" rule cannot be evaluated for it.`,
    );
    return null;
  }
  return {
    numbers: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ?? null,
  };
}

/**
 * Fetch and audit the two manifests.
 *
 * Exported and injectable (`fetchImpl`, `base`) so a test can drive it against
 * a fixture without the network.
 */
/**
 * The envelope `tauri-plugin-updater` parses, and nothing more.
 *
 * A manifest's `signature` is the CONTENT OF THE `.sig` FILE the bundler wrote, which is itself
 * base64 of a four-line minisign blob. The updater base64-decodes the field once and hands the
 * result to minisign, which reads line 1 as the untrusted comment and line 3 as the trusted one.
 * Encoding the field one level deeper still decodes to a string, so the mistake surfaces only at
 * install: "Untrusted signature comment too long", on every platform at once, from a release whose
 * artefacts, hashes and URLs were all correct. v0.11.3 shipped exactly that.
 *
 * `null` means the field is not in that shape. It says nothing about whether the signature is
 * valid: that is the client's check, at install time.
 */
export function signatureEnvelope(signature) {
  if (typeof signature !== "string" || signature.length === 0) return null;
  const text = Buffer.from(signature, "base64").toString("utf8");
  const lines = text.split("\n");
  if (lines.length < 4) return null;
  if (!lines[0].startsWith("untrusted comment: ")) return null;
  if (!lines[2].startsWith("trusted comment: ")) return null;
  return text;
}

/**
 * The version the artefact behind this signature was signed for, or null.
 *
 * `tauri signer sign --app-version <v>` appends `version:<v>` to the trusted comment as a
 * tab-separated field, and the signature's own global signature covers that comment. That is what
 * makes the binding meaningful: it stops a substituted manifest from pairing a new version number
 * with an older release's bytes. The field is read back exactly as
 * `tauri-plugin-updater` reads it (`signed_version` in its `updater.rs`): the third line, split on
 * tabs, the field that starts with `version:`. Anything else is invisible to the updater and so is
 * invisible here, whether it is a field on the second line or a space where a tab belongs.
 */
function signedVersion(envelope) {
  const line = envelope.split("\n")[2] ?? "";
  const comment = line.slice("trusted comment: ".length);
  const field = comment.split("\t").find((part) => part.startsWith("version:"));
  return field === undefined ? null : field.slice("version:".length);
}

/**
 * Whether this build's client DEMANDS a signed version.
 *
 * Read from `src-tauri/tauri.conf.json` rather than assumed: the failure this rule exists for is
 * a client that refuses the artefact, so the guard has to state the contract the client actually
 * ships (`plugins.updater.requireSignedVersion`, `true` since the updater landed), not a copy of
 * what the release assumed.
 *
 * A configuration this cannot read is a FAILURE, not a pass, and it is reported as one: a guard
 * that stops asking its question when a path moves is a guard that reports green while checking
 * nothing.
 */
function clientContract() {
  const path = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    return { ok: true, requireSignedVersion: config?.plugins?.updater?.requireSignedVersion === true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * Compare two version spellings the way the updater's own `verify_signed_version` does.
 *
 * Semver when both sides are one, so `1.2.3` and `v1.2.3` agree, with a literal fallback for a
 * version that is not semver (the plugin does the same, which is why a date-stamped version still
 * fails honestly rather than crashing the comparison).
 *
 * Two details are copied rather than tidied, because each one is a case where a tidier comparison
 * would ACCEPT an artefact the client refuses, which is the one direction this guard cannot be
 * wrong in. The plugin strips EVERY leading `v` (`trim_start_matches('v')`) and performs no
 * whitespace trimming at all, so `version: 0.10.0` with a space after the colon, or `vv0.10.0`,
 * parses as nothing on the client side and then fails the literal comparison. Trimming here made
 * the guard answer "fine" to a manifest the client rejects, and no test noticed, because every
 * fixture was clean.
 */
function versionsAgree(signed, announced) {
  const strip = (value) => (typeof value === "string" ? value.replace(/^v+/, "") : "");
  const a = strip(signed);
  const b = strip(announced);
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (ma !== null && mb !== null) {
    return (
      ma[1] === mb[1] &&
      ma[2] === mb[2] &&
      ma[3] === mb[3] &&
      (ma[4] ?? null) === (mb[4] ?? null)
    );
  }
  return a === b;
}

export async function audit({
  fetchImpl = fetch,
  base = BASE,
  channels = CHANNELS,
  contract = clientContract(),
} = {}) {
  const failures = [];
  const seen = new Map();
  let reached = 0;

  if (!contract.ok) {
    failures.push(
      `could not read src-tauri/tauri.conf.json (${contract.error}), so whether this client ` +
        `refuses a signature that names no version is UNKNOWN. Nothing was verified about the ` +
        `version binding.`,
    );
  }

  for (const channel of channels) {
    const url = `${base}${manifestFilename(channel)}`;
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      failures.push(
        `COULD NOT REACH ${url} (${error?.name ?? "network error"}). Nothing was verified about ` +
          `the ${channel} channel.`,
      );
      continue;
    }
    if (!response.ok) {
      failures.push(
        `${url}: HTTP ${response.status}. A manifest that does not resolve makes every client's ` +
          `check fail until it is corrected.`,
      );
      continue;
    }
    reached += 1;

    let manifest;
    try {
      manifest = await response.json();
    } catch {
      failures.push(`${url}: not valid JSON.`);
      continue;
    }

    const version = parseVersion(manifest?.version, channel, failures);
    const platforms = manifest?.platforms;
    if (platforms === null || typeof platforms !== "object" || Object.keys(platforms).length === 0) {
      failures.push(
        `${url}: no platforms, so this channel updates nobody. A release that shipped an empty ` +
          `platform set is the shape a wrong descriptor produces.`,
      );
      continue;
    }

    for (const [target, entry] of Object.entries(platforms)) {
      if (typeof entry?.signature !== "string" || entry.signature.length === 0) {
        failures.push(
          `${url}: platform ${target} carries no signature. The updater refuses an unsigned ` +
            `artefact, so the offer would be a dead end for that platform.`,
        );
      } else {
        const envelope = signatureEnvelope(entry.signature);
        if (envelope === null) {
          failures.push(
            `${url}: platform ${target}'s signature is not the .sig file's content. The updater ` +
              `base64-decodes this field once and then parses a four-line minisign blob, so an ` +
              `extra encoding layer (or the decoded blob pasted in) fails at install on every ` +
              `platform with "Untrusted signature comment too long".`,
          );
        } else if (contract.ok) {
          // The version binding. A different question from the envelope above, and the one that
          // was green for two releases without being asked.
          const signed = signedVersion(envelope);
          if (signed === null) {
            if (contract.requireSignedVersion) {
              failures.push(
                `${url}: platform ${target}'s signature names no version. This client ships ` +
                  `\`requireSignedVersion: true\` (src-tauri/tauri.conf.json), so ` +
                  `tauri-plugin-updater refuses the artefact with MissingSignedVersion AFTER the ` +
                  `whole download, and the update screen states no cause. \`tauri build\` embeds ` +
                  `the field; a hand \`tauri signer sign\` omits it unless given ` +
                  `\`--app-version ${manifest.version}\`, which is how v0.11.3 shipped it on every ` +
                  `platform and v0.11.4 on macOS only. Re-sign the published artefact and ` +
                  `re-publish both manifests.`,
              );
            }
          } else if (!versionsAgree(signed, manifest.version)) {
            failures.push(
              `${url}: platform ${target}'s signature names version ${JSON.stringify(signed)} but ` +
                `the manifest announces ${JSON.stringify(manifest.version)}. The updater refuses ` +
                `this with SignedVersionMismatch whatever the config says, because the comment is ` +
                `covered by the signature and a mismatch is the substitution it exists to catch. ` +
                `Re-sign with \`--app-version ${manifest.version}\`.`,
            );
          }
        }
      }
      const artifact = entry?.url;
      if (typeof artifact !== "string" || !artifact.startsWith(base)) {
        failures.push(
          `${url}: platform ${target} points at ${JSON.stringify(artifact)}, which is not under ` +
            `${base}. The whole manifest must name one origin.`,
        );
        continue;
      }
      let head;
      try {
        head = await fetchImpl(artifact, { method: "HEAD", signal: AbortSignal.timeout(15000) });
      } catch (error) {
        failures.push(
          `${url}: ${artifact} could not be reached (${error?.name ?? "network error"}). A ` +
            `manifest naming an absent artefact breaks the update for that platform.`,
        );
        continue;
      }
      if (!head.ok) {
        failures.push(
          `${url}: ${artifact} is HTTP ${head.status}. Publish the artefacts BEFORE the manifest ` +
            `that points at them, or every client's check fails until it is corrected.`,
        );
      }
    }

    seen.set(channel, version);
  }

  if (reached === 0) {
    return { failures, verdict: "not-a-verdict" };
  }

  // The rule. Only asked when both sides were read AND parsed: an unparseable
  // version is already a failure of its own, and comparing against it would
  // crash the check instead of reporting that failure.
  const stable = seen.get("stable") ?? null;
  const beta = seen.get("beta") ?? null;
  if (stable !== null && beta !== null && compareVersions(beta, stable) < 0) {
    failures.push(
      `the beta manifest is BEHIND the stable one: beta says ${formatVersion(beta)}, stable says ` +
        `${formatVersion(stable)}. Every beta install is offered nothing while a newer release ` +
        `sits on stable, and a beta install cannot switch channels to go and get it. This is the ` +
        `v0.10.0 failure. Republish the beta document with the stable version ` +
        `(\`emit-update-manifest.mjs --channel both\`).`,
    );
  }

  return { failures, verdict: failures.length === 0 ? "ok" : "failed" };
}

/** `X.Y.Z[-pre]`, for a failure message. */
function formatVersion(v) {
  return `${v.numbers.join(".")}${v.prerelease === null ? "" : `-${v.prerelease}`}`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // An async main rather than top-level `await`: this module is imported by
  // `tests/scripts/publishedManifests.test.ts`, and a top-level await in an
  // imported file is a module-target constraint the test tree does not need to
  // inherit for a CLI entry point.
  main();
}

async function main() {
  const { failures, verdict } = await audit();
  if (verdict === "not-a-verdict") {
    // Offline, or the origin is unreachable. Say so rather than pass.
    for (const message of failures) console.error(`  - ${message}`);
    console.log("published manifests: NOTHING VERIFIED (origin unreachable), which is not a verdict");
    return;
  }
  if (failures.length > 0) {
    console.error("published manifests: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log(`published manifests: ok (stable and beta both reachable at ${BASE})`);
}
