// The deployment config may not claim a service worker the bundle does not have
// — myne-md/myne#556, the `web.deploy.bundle-update-live-tab` bullet.
//
// The roster row asked a person to redeploy the bundle under a live tab and
// judge what the browser did with its caches. Half of that question has no
// subject: **there is no service worker.**
//
//  * `web/container/Caddyfile` says `version.json` "is excluded from the service
//    worker's pinned cache (task 54)";
//  * a grep for `navigator.serviceWorker` over `web/` and `src/` returns
//    nothing at all;
//  * `web/src/sw/update-policy.ts` — the signed-update policy that worker was
//    going to obey — sits unregistered, and `scripts/check-unwired.mjs` already
//    records it as a violation ("UNWIRED — the service-worker update policy.
//    Test-only importer.").
//
// So the operator-facing comment describes a mechanism that is not deployed. It
// is not a security hole — nothing is doing the wrong thing, a thing is simply
// not there — but it is a claim in a file operators read to understand what
// their container does, and it is the kind of claim that gets believed. A
// reviewer walking the roster row would find nothing wrong, because the
// no-cache header IS set and `version.json` IS uncached; only the stated REASON
// is fiction.
//
// This test judges exactly that, in both directions: the claim may not survive
// while no registrar exists, and — the direction that matters more — the day a
// registrar DOES land, this fails and forces the pair to be re-examined
// together rather than one of them quietly going stale again.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();

const CADDYFILE = join(REPO_ROOT, "web/container/Caddyfile");
const UPDATE_POLICY = "web/src/sw/update-policy.ts";

/** Every TS/TSX source in the two trees a registrar could live in. */
function clientSources(): string[] {
  const out: string[] = [];
  for (const root of ["web/src", "src"]) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        if (name === "node_modules" || name === "dist") continue;
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) out.push(relative(REPO_ROOT, p));
      }
    };
    walk(abs);
  }
  return out;
}

/** Files that register (or unregister) a service worker. */
function registrars(): string[] {
  return clientSources().filter((rel) => {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    // Comments stripped: several modules DISCUSS the absent worker in prose,
    // and prose is not a registration.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return /navigator\s*\.\s*serviceWorker/.test(code);
  });
}

describe("the served bundle registers no service worker", () => {
  it("scans a non-empty tree", () => {
    // A walk that found nothing would report ok forever.
    expect(clientSources().length).toBeGreaterThan(200);
    expect(clientSources()).toContain(UPDATE_POLICY);
  });

  it("nothing calls navigator.serviceWorker", () => {
    expect(
      registrars(),
      "a service-worker registrar appeared. That is a real change and probably " +
        "a good one — but it means the update policy in web/src/sw/ is now live " +
        "code on the bundle-delivery path (threat-model A15/TB11), the " +
        "Caddyfile's pinned-cache comment finally describes something, and the " +
        "`web.deploy.bundle-update-live-tab` roster row has a subject again. " +
        "Re-derive it rather than deleting this assertion.",
    ).toEqual([]);
  });

  it("the update policy is still recorded as unwired", () => {
    // The guard that already knows. If the exemption goes away, either the
    // module was wired (see above) or it was deleted — both are events this
    // file's argument depends on.
    const guard = readFileSync(join(REPO_ROOT, "scripts/check-unwired.mjs"), "utf8");
    expect(
      guard.includes(UPDATE_POLICY),
      "check-unwired.mjs no longer records web/src/sw/update-policy.ts as " +
        "unwired, so either it gained a production importer or it is gone",
    ).toBe(true);
    expect(existsSync(join(REPO_ROOT, UPDATE_POLICY))).toBe(true);
  });
});

describe("the Caddyfile does not describe a cache nothing keeps", () => {
  it("reads the Caddyfile it claims to check", () => {
    expect(existsSync(CADDYFILE), "web/container/Caddyfile is gone").toBe(true);
    const text = readFileSync(CADDYFILE, "utf8");
    expect(text).toContain("version.json");
    expect(text.length).toBeGreaterThan(500);
  });

  it("makes no claim about a service worker's cache while none exists", () => {
    // Annotated rather than inferred: `node:fs` has no types in
    // `tsconfig.tests.json`, so `readFileSync` is `any` and every derived
    // binding below would be an implicit-any error under `noImplicitAny`.
    const text: string = readFileSync(CADDYFILE, "utf8");
    const offending: Array<readonly [number, string]> = text
      .split("\n")
      .map((line: string, i: number) => [i + 1, line] as const)
      .filter(([, line]: readonly [number, string]) => /service.worker/i.test(line));
    expect(
      offending.map(([n, line]: readonly [number, string]) => `${n}: ${line.trim()}`),
      "the Caddyfile describes a service worker's cache. Nothing in the bundle " +
        "registers one (see the suite above), so the sentence describes a " +
        "mechanism this container does not deploy — in a file operators read to " +
        "understand what their container does. Either wire the worker or state " +
        "the header's real reason.",
    ).toEqual([]);
  });

  it("still sets the no-store header the claim was attached to", () => {
    // The header itself is correct and load-bearing regardless: `version.json`
    // must describe the SERVED build so anyone can compare a running instance
    // against the published hash record. Removing the false sentence must not
    // take the real rule with it.
    const text = readFileSync(CADDYFILE, "utf8");
    const versionBlock = text.slice(text.indexOf("@version"), text.indexOf("@config"));
    expect(versionBlock).toContain("no-store");
  });
});
