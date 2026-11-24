// The web E2E lane's bundle server (MYND-574 task 105).
//
// Two properties, and neither is about serving files:
//
//  1. **It serves the PRODUCTION security headers.** A lane running against
//     `vite preview` would prove the app works in an environment it is never
//     deployed into, and would go green on exactly the misconfiguration
//     `docs/self-host-web.md` calls fatal — without cross-origin isolation
//     `SharedArrayBuffer` is undefined and the sync backoff's blocking waiter
//     (`core/src/task.rs`) cannot exist. The headers are asserted against
//     `web/csp.ts::securityHeaders` itself, so a copy cannot drift looser.
//  2. **It cannot read outside its root.** A harness that can is a harness that
//     can put a credential into a failure artifact.

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { securityHeaders } from "../../web/csp";
import { resolveWithinRoot, startBundleServer, type BundleServer } from "../../e2e-web/support/server";

const SYNC = "https://sync.example.org";
let live: BundleServer | null = null;

afterEach(async () => {
  await live?.close();
  live = null;
});

async function serveFixture() {
  const root = await mkdtemp(join(tmpdir(), "myne-web-e2e-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>myne</title>");
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "app.js"), "export const x = 1;");
  await writeFile(join(root, "secret.txt"), "not served under any name");
  // The sibling-lookalike: a directory whose name starts with the root's.
  const outside = `${root}-evil`;
  await mkdir(outside);
  await writeFile(join(outside, "stolen.txt"), "must never be reachable");
  live = await startBundleServer({ root, port: 0, syncOrigin: SYNC });
  return { root, outside };
}

describe("path resolution", () => {
  const root = "/srv/dist";

  it("maps the root to index.html", () => {
    expect(resolveWithinRoot(root, "/")).toBe("/srv/dist/index.html");
  });

  it("resolves a nested asset", () => {
    expect(resolveWithinRoot(root, "/assets/app.js")).toBe("/srv/dist/assets/app.js");
  });

  it("refuses traversal", () => {
    expect(resolveWithinRoot(root, "/../../etc/passwd")).toBeNull();
    expect(resolveWithinRoot(root, "/assets/../../outside")).toBeNull();
  });

  /** `…/dist-evil` is not a child of `…/dist`, and a bare `startsWith` on the
   *  resolved string would say it is — the same sibling-lookalike bug the Rust
   *  importer read seam guards against with a component-wise check. */
  it("refuses a sibling whose name merely starts with the root's", () => {
    expect(resolveWithinRoot(root, "/../dist-evil/stolen.txt")).toBeNull();
  });

  it("refuses an encoded traversal and a NUL", () => {
    expect(resolveWithinRoot(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveWithinRoot(root, "/a%00.js")).toBeNull();
  });
});

describe("the served headers", () => {
  it("are exactly the production set, not a copy of it", async () => {
    await serveFixture();
    const res = await fetch(`${live!.origin}/`);
    const want = securityHeaders({ syncOrigin: SYNC });
    for (const [name, value] of Object.entries(want)) {
      expect(res.headers.get(name), `${name} must match production`).toBe(value);
    }
  });

  /**
   * Named individually as well, because these three are the ones whose absence
   * makes the lane test a different product: without COOP+COEP there is no
   * cross-origin isolation, and without the CSP the zero-third-party rule is
   * untested rather than enforced.
   */
  it("carries the isolation pair and a real CSP", async () => {
    await serveFixture();
    const res = await fetch(`${live!.origin}/`);
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(res.headers.get("Content-Security-Policy")).toContain(SYNC);
  });

  it("carries them on a 404 too", async () => {
    await serveFixture();
    const res = await fetch(`${live!.origin}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });
});

describe("what it serves", () => {
  it("serves an asset with a real content type", async () => {
    await serveFixture();
    const res = await fetch(`${live!.origin}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("export const x");
  });

  /** A client route (`/editor/<uuid>`, task 64) is what a RELOAD lands on, and
   *  the web client's whole deep-link story depends on it resolving. */
  it("falls back to index.html for an extensionless client route", async () => {
    await serveFixture();
    const res = await fetch(`${live!.origin}/editor/0193e8d3-1234-7890-abcd-ef0123456789`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>myne</title>");
  });

  it("does not fall back for a missing ASSET — a 404 must stay a 404", async () => {
    await serveFixture();
    // Silently serving index.html for a missing `.js` is how a bundling bug
    // becomes a blank page with no error anywhere.
    expect((await fetch(`${live!.origin}/assets/gone.js`)).status).toBe(404);
  });

  it("never reaches a sibling directory outside the root", async () => {
    const { root } = await serveFixture();
    const escape = `/${"..".padEnd(2)}/${root.split("/").pop()}-evil/stolen.txt`;
    const res = await fetch(`${live!.origin}${escape}`);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("must never be reachable");
  });
});
