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

function manifest(version: string, url = ARTIFACT, signature = SIG) {
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

const run = (routes: Record<string, Route>) => audit({ fetchImpl: fetcher(routes), base: ORIGIN });

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
