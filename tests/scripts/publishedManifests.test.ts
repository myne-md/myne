import { describe, expect, it } from "vitest";

import { audit } from "../../scripts/check-published-manifests.mjs";

/**
 * A fetch that answers from a route table.
 *
 * `audit` takes its fetch as a parameter for exactly this: the whole point of
 * the check is what it does with a beta manifest that lags stable, and the live
 * origin is only ever in one of those states.
 */
type Route = { status?: number; json?: unknown };

function fetcher(routes: Record<string, Route>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) throw new TypeError("fetch failed");
    const status = route.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => route.json,
    } as unknown as Response;
  };
}

const ORIGIN = "https://downloads.myne.md/releases/";
const ARTIFACT = `${ORIGIN}v0.10.0/Myne.app.tar.gz`;

/**
 * A `.sig` file's content: base64 of the four-line minisign blob the bundler signs with.
 *
 * This is the shape `tauri-plugin-updater` parses (it base64-decodes the manifest field, then
 * hands the result to minisign, which reads line 1 as the untrusted comment and line 3 as the
 * trusted one), so the fixture has to carry it or every case here would be testing a manifest
 * the updater rejects for a reason the test is not about.
 */
const SIG_TEXT = [
  "untrusted comment: signature from tauri secret key",
  "RUSvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  "trusted comment: timestamp:1793526600\tfile:Myne.app.tar.gz\tversion:0.10.0",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
].join("\n");
const SIG = Buffer.from(SIG_TEXT, "utf8").toString("base64");

/** The same envelope with a trusted comment of the caller's choosing. */
function signatureWithTrustedComment(comment: string): string {
  return Buffer.from(
    SIG_TEXT.split("\n")
      .map((line, index) =>
        index === 2 ? `trusted comment: ${comment}` : line,
      )
      .join("\n"),
    "utf8",
  ).toString("base64");
}

/** A signature that names `version`, which is what `tauri build` writes. */
const sig = (version: string) =>
  signatureWithTrustedComment(`timestamp:1793526600\tfile:Myne.app.tar.gz\tversion:${version}`);

/** Both limits of the client's own contract, spelled rather than read. */
const CLIENT_REQUIRES_VERSION = { ok: true, requireSignedVersion: true };
const CLIENT_ALLOWS_UNVERSIONED = { ok: true, requireSignedVersion: false };

function manifest(version: string, url = ARTIFACT, signature = sig(version)) {
  return {
    version,
    platforms: { "darwin-aarch64": { signature, url } },
  };
}

/** Both channels at the same version, artefacts present. */
function same(): Record<string, Route> {
  return {
    [`${ORIGIN}latest.json`]: { json: manifest("0.10.0") },
    [`${ORIGIN}latest-beta.json`]: { json: manifest("0.10.0") },
    [ARTIFACT]: { status: 200 },
  };
}

const run = (routes: Record<string, Route>, extra: Record<string, unknown> = {}) =>
  audit({ fetchImpl: fetcher(routes), base: ORIGIN, ...extra });

describe("check-published-manifests", () => {
  it("passes when both channels carry the same version and their artefacts resolve", async () => {
    const { failures, verdict } = await run(same());
    expect(failures).toEqual([]);
    expect(verdict).toBe("ok");
  });

  it("fails when a signature carries one encoding too many, which no other gate sees", async () => {
    // The v0.11.3 defect, reproduced: the field was the `.sig` content base64'd a second time.
    // Every artefact resolved, every hash matched, and the updater would have answered
    // "Untrusted signature comment too long" on every platform at once.
    const routes = same();
    routes[`${ORIGIN}latest.json`] = { json: manifest("0.10.0", ARTIFACT, Buffer.from(SIG).toString("base64")) };
    const { failures, verdict } = await run(routes);
    expect(verdict).toBe("failed");
    expect(failures.join("\n")).toContain("not the .sig file's content");
  });

  it("fails when the beta document lags stable, naming the rule and the release it happened to", async () => {
    // The v0.10.0 failure, reproduced: stable published, beta left behind, and
    // every beta install told it was current. Nothing else in the tree compares
    // the two documents.
    const routes = same();
    routes[`${ORIGIN}latest-beta.json`] = { json: manifest("0.9.4") };
    const { failures, verdict } = await run(routes);
    expect(verdict).toBe("failed");
    const joined = failures.join("\n");
    expect(joined).toMatch(/BEHIND the stable one/);
    expect(joined).toMatch(/beta says 0\.9\.4, stable says 0\.10\.0/);
  });

  it("accepts a beta document AHEAD of stable, which is the prerelease case", async () => {
    const routes = same();
    routes[`${ORIGIN}latest-beta.json`] = { json: manifest("0.11.0-rc.1") };
    const { failures, verdict } = await run(routes);
    expect(failures).toEqual([]);
    expect(verdict).toBe("ok");
  });

  it("fails when a manifest names an artefact that is not there", async () => {
    const routes = same();
    routes[ARTIFACT] = { status: 404 };
    const { failures } = await run(routes);
    expect(failures.join("\n")).toMatch(/Publish the artefacts BEFORE/);
  });

  it("fails when a manifest itself does not resolve", async () => {
    const routes = same();
    routes[`${ORIGIN}latest-beta.json`] = { status: 404 };
    const { failures } = await run(routes);
    expect(failures.join("\n")).toMatch(/HTTP 404/);
  });

  it("fails when a platform carries no signature", async () => {
    const routes = same();
    routes[`${ORIGIN}latest.json`] = {
      json: { version: "0.10.0", platforms: { "darwin-aarch64": { url: ARTIFACT } } },
    };
    const { failures } = await run(routes);
    expect(failures.join("\n")).toMatch(/carries no signature/);
  });

  it("fails when a manifest points off the origin", async () => {
    const routes = same();
    routes[`${ORIGIN}latest.json`] = { json: manifest("0.10.0", "https://elsewhere/x.tar.gz") };
    const { failures } = await run(routes);
    expect(failures.join("\n")).toMatch(/which is not under/);
  });

  it("fails when a manifest ships an empty platform set", async () => {
    const routes = same();
    routes[`${ORIGIN}latest.json`] = { json: { version: "0.10.0", platforms: {} } };
    const { failures } = await run(routes);
    expect(failures.join("\n")).toMatch(/no platforms/);
  });

  it("fails by name on a version the rule cannot be evaluated for", async () => {
    const routes = same();
    routes[`${ORIGIN}latest-beta.json`] = { json: manifest("latest") };
    const { failures } = await run(routes);
    expect(failures.join("\n")).toMatch(/is not a `X\.Y\.Z` semver/);
  });

  it("fails when a signature names no version while the client refuses one, which is the v0.11.4 macOS defect", async () => {
    // Reproduced from the live v0.11.4 origin on 2026-11-03: the artefact, its hash and the
    // envelope were all correct, the trusted comment was `timestamp:…\tfile:Myne.app.tar.gz`,
    // and every macOS install failed with MissingSignedVersion AFTER a 208 MB download.
    const routes = same();
    routes[`${ORIGIN}latest.json`] = {
      json: manifest("0.10.0", ARTIFACT, signatureWithTrustedComment("timestamp:1793610073\tfile:Myne.app.tar.gz")),
    };
    const { failures, verdict } = await run(routes, { contract: CLIENT_REQUIRES_VERSION });
    expect(verdict).toBe("failed");
    const joined = failures.join("\n");
    expect(joined).toMatch(/names no version/);
    expect(joined).toMatch(/MissingSignedVersion/);
    expect(joined).toMatch(/--app-version 0\.10\.0/);
  });

  it("accepts the same unversioned signature when the client does not demand one", async () => {
    // The arm that proves the failure above is the CLIENT's contract and not the comment's shape:
    // same bytes, same manifest, one flag apart.
    const routes = same();
    routes[`${ORIGIN}latest.json`] = {
      json: manifest("0.10.0", ARTIFACT, signatureWithTrustedComment("timestamp:1793610073\tfile:Myne.app.tar.gz")),
    };
    const { failures, verdict } = await run(routes, { contract: CLIENT_ALLOWS_UNVERSIONED });
    expect(failures).toEqual([]);
    expect(verdict).toBe("ok");
  });

  it("fails when the signature names a version the manifest does not, whatever the config says", async () => {
    // SignedVersionMismatch is raised by the plugin regardless of `requireSignedVersion`: the
    // comment is covered by the signature, and a mismatch is the substitution that binding exists
    // to catch. It is also the rollback: an old artefact announced as a new version.
    const routes = same();
    routes[`${ORIGIN}latest.json`] = { json: manifest("0.10.0", ARTIFACT, sig("0.9.4")) };
    const { failures, verdict } = await run(routes, { contract: CLIENT_ALLOWS_UNVERSIONED });
    expect(verdict).toBe("failed");
    const joined = failures.join("\n");
    expect(joined).toMatch(/names version "0\.9\.4"/);
    expect(joined).toMatch(/SignedVersionMismatch/);
  });

  it("fails when the signed version carries whitespace the client will not parse", async () => {
    // The plugin compares `trim_start_matches('v')` of the signed version against the announced one
    // with no whitespace trimming, so ` 0.10.0` is not semver and fails the literal comparison. The
    // guard trimmed, which accepted a manifest the client refuses, and every fixture here was clean
    // enough that no test noticed. This case exists to make that specific regression go red.
    const routes = same();
    routes[`${ORIGIN}latest.json`] = { json: manifest("0.10.0", ARTIFACT, sig(" 0.10.0")) };
    const { failures, verdict } = await run(routes, { contract: CLIENT_REQUIRES_VERSION });
    expect(verdict).toBe("failed");
    expect(failures.join("\n")).toMatch(/names version " 0\.10\.0"/);
  });

  it("accepts a `v`-prefixed spelling of the version the manifest announces", async () => {
    // The plugin compares as semver after trimming a leading `v`, so this pair is one version. A
    // guard that compared the strings would fail an artefact the client installs happily.
    const routes = same();
    routes[`${ORIGIN}latest.json`] = { json: manifest("0.10.0", ARTIFACT, sig("v0.10.0")) };
    const { failures, verdict } = await run(routes);
    expect(failures).toEqual([]);
    expect(verdict).toBe("ok");
  });

  it("reports a client configuration it cannot read instead of passing the binding", async () => {
    // A moved `tauri.conf.json` must not turn this rule into a green tick: the guard stops asking
    // its question, so it says the binding is unverified.
    const { failures, verdict } = await run(same(), {
      contract: { ok: false, error: "ENOENT: no such file or directory" },
    });
    expect(verdict).toBe("failed");
    expect(failures.join("\n")).toMatch(/UNKNOWN/);
  });

  it("reports an unreachable origin as not-a-verdict rather than as a pass", async () => {
    const { failures, verdict } = await run({});
    expect(verdict).toBe("not-a-verdict");
    expect(failures.join("\n")).toMatch(/COULD NOT REACH/);
  });

  it("still asks the rule when only one side was reachable enough to read", async () => {
    // One manifest read and the other 404 is a real state (a bad publish), and
    // the missing half is already a failure; this pins that the pair rule does
    // not throw when one side is absent.
    const routes = same();
    delete routes[`${ORIGIN}latest-beta.json`];
    const { failures, verdict } = await run(routes);
    expect(verdict).toBe("failed");
    expect(failures.join("\n")).toMatch(/COULD NOT REACH .*latest-beta\.json/);
  });
});
