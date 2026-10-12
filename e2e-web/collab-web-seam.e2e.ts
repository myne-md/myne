// The web-only awareness seam (epic live-collab, sub-feature `collab-verification`
// task 4; SYNC-49). A single-session wiring scenario, NOT a two-session live
// convergence: SYNC-49 keeps the real two-browser co-edit as a manual item and
// leaves the shared convergence to the desktop lane once.
//
// # What belongs to the web lane, and only here
//
// The shared `src/` tree is covered once, on the desktop lane. What is
// web-SPECIFIC about live presence is the transport seam, and this file asserts
// the three web-only facts:
//
//   1. The Worker carries a `fetch` + `ReadableStream` reader, NOT `EventSource`
//      (which cannot set the `Authorization: Bearer` header the awareness route
//      authenticates with; see `web/src/worker/sync-loop.ts`).
//   2. The production security policy (`web/csp.ts::securityHeaders`, served
//      here by `e2e-web/support/server.ts`, the SAME function, not a copy)
//      admits the awareness origin in `connect-src`, and a fetch-streamed
//      request from the app origin to that origin actually connects under it.
//   3. The capability classification is correct: `liveCollabPeerPresence` is
//      PRESENT on web and `liveCollabMultiUser` is ABSENT (not disabled),
//      matching `web/src/platform/capabilities.ts` (cross-checked with
//      `web/wasm/src/capability.rs` by `scripts/check-web-capabilities.mjs`).
//
// # TODO(blocked): no live connect through a real sync session
//
// The fetch below talks to a minimal SSE fixture ORIGIN, standing in for the
// sync origin, because proving the CSP admits the awareness origin needs a
// server the policy names and nothing else. A genuine connect THROUGH the app's
// own reader needs an enrolled, unlocked browser session against a loopback sync
// origin, which is the two-session harness SYNC-49 deliberately keeps out of
// this lane (the real two-browser co-edit is a manual roster item). The reader
// itself is asserted present in the served bundle below.
//
// Vault-count precondition: 0, the CSP/capability facts are reachable on the
// first-run screen, and the fixture server carries no vault.

import { expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
// The web capability descriptor itself: the classification the guard cross-checks
// against `web/wasm/src/capability.rs`, asserted directly here.
import { has } from "../web/src/platform/capabilities";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;

/** Every `.js` file under `root`, recursively. */
function jsFiles(root: string): string[] {
  const out: string[] = [];
  let entries: { parentPath: string; name: string; isFile: () => boolean }[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true }) as unknown as {
      parentPath: string;
      name: string;
      isFile: () => boolean;
    }[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".js")) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

/**
 * A minimal SSE origin standing in for the sync server: it answers the awareness
 * route with the CORS + CORP headers a cross-origin `fetch` needs under the app
 * origin's `Cross-Origin-Embedder-Policy: require-corp`. It carries no vault and
 * one opaque frame.
 */
/** Minimal request/response shapes (the `node:http` types are absent here, so
 *  the callback params must be annotated explicitly or they read as implicit
 *  `any`). */
interface FixtureReq {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface FixtureRes {
  writeHead(code: number, headers?: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

async function startSseFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: FixtureReq, res: FixtureRes) => {
    const requestOrigin = req.headers.origin;
    const allow = {
      "Access-Control-Allow-Origin": typeof requestOrigin === "string" ? requestOrigin : "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      // Under COEP require-corp the response must opt in to being read
      // cross-origin, exactly as a real sync origin deployed behind the same
      // policy would.
      "Cross-Origin-Resource-Policy": "cross-origin",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, allow);
      res.end();
      return;
    }
    res.writeHead(200, { ...allow, "Content-Type": "text/event-stream" });
    res.write('data: {"room_id_hex":"00","frame_b64":""}\n\n');
    res.end();
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}

describeE2E("web awareness seam (SYNC-49)", () => {
  it("ships a fetch-stream reader admitted by the production CSP, with the right capability split", async () => {
    // 3. The capability classification. `liveCollabMultiUser` is ABSENT on web
    //    (omitted, never disabled) because a browser origin cannot hold a person
    //    identity, the same reasons `memberSharing` is absent
    //    (`web/src/platform/capabilities.ts`). Asserted directly against the web
    //    descriptor, the module `check-web-capabilities.mjs` cross-checks with
    //    `web/wasm/src/capability.rs`.
    expect(has("liveCollabPeerPresence"), "peer presence ships on web").toBe(true);
    expect(has("liveCollabMultiUser"), "multi-user is absent on web, not disabled").toBe(false);

    const fixture = await startSseFixture();
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: fixture.origin });
    try {
      // 1. The production policy admits the awareness origin, as served (the
      //    header IS `web/csp.ts`'s output, not a copy).
      const index = await fetch(`${server.origin}/index.html`);
      const csp = index.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(`connect-src 'self' ${fixture.origin}`);

      // 2. The Worker-side reader shipped: the asset(s) carrying the awareness
      //    route use `fetch` + `getReader` (ReadableStream) and never construct
      //    an `EventSource` (which cannot set `Authorization`).
      const route = "/sync/awareness";
      const carrying: string[] = [];
      for (const file of jsFiles(resolve(BUNDLE_DIR))) {
        const rel = relative(resolve(BUNDLE_DIR), file).split("\\").join("/");
        const body = await (await fetch(`${server.origin}/${rel}`)).text();
        if (body.includes(route)) carrying.push(body);
      }
      expect(carrying.length, "an asset carries the awareness route").toBeGreaterThan(0);
      for (const body of carrying) {
        expect(body, "the reader uses a ReadableStream reader").toContain("getReader");
        expect(body, "the reader does not fall back to EventSource").not.toContain(
          "new EventSource(",
        );
      }

      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("account-entry.input", { timeoutMs: 30_000 });

        // 2b. The policy does not merely NAME the origin: a fetch-streamed
        //     request from the app origin to the awareness origin CONNECTS under
        //     it (a CSP block would reject the fetch before a byte arrives; a
        //     COEP/CORP refusal would reject the body read).
        const probe = await browser.session.executeAsync<string>(
          "var cb = arguments[arguments.length - 1];" +
            "var url = arguments[0];" +
            "fetch(url + '/sync/awareness', { headers: { Authorization: 'Bearer e2e-seam' } })" +
            "  .then(function (res) {" +
            "    return res.body.getReader().read().then(function (first) {" +
            "      var text = first.value ? new TextDecoder().decode(first.value) : '';" +
            "      cb(JSON.stringify({ ok: true, status: res.status, hit: text.indexOf('data:') !== -1 }));" +
            "    });" +
            "  })" +
            "  .catch(function (e) { cb(JSON.stringify({ ok: false, name: String((e && e.name) || e) })); });",
          [fixture.origin],
        );
        const result = JSON.parse(probe) as { ok: boolean; status?: number; hit?: boolean; name?: string };
        expect(result.ok, `the policy admitted the awareness origin (${result.name ?? "ok"})`).toBe(
          true,
        );
        expect(result.status).toBe(200);
        expect(result.hit, "an SSE frame arrived over the fetch stream").toBe(true);

        // No CSP violation for the awareness origin reached this page.
        expect(server.cspViolations.join(" | ")).not.toContain(fixture.origin);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
      await fixture.close();
    }
  });
});
