// The bundle server the web E2E lane loads the app from (MYND-574 task 105).
//
// # Why not `vite preview`
//
// Because the suite has to exercise the REAL security headers. `vite preview`
// serves the built files with its own defaults: no CSP, no COOP, no COEP. A
// lane running against that would prove the app works in an environment the app
// is never deployed into — and would go green on exactly the misconfiguration
// `docs/self-host-web.md` names as fatal, because without cross-origin
// isolation `SharedArrayBuffer` is undefined and the sync backoff's blocking
// waiter (`core/src/task.rs`) cannot exist.
//
// So the headers come from `web/csp.ts::securityHeaders` — the same function
// the production deployment uses. Not a copy of it: a copy would drift, and the
// drift would be invisible in exactly the direction that matters (a test lane
// looser than production).
//
// # Why a server per test file
//
// OPFS is keyed by ORIGIN. Two concurrent vitest workers sharing one server
// share one origin, and one test's vault becomes visible to its neighbour. The
// port — and therefore the origin — comes from `worker-ports.ts`.
//
// # What it deliberately does NOT do
//
// No directory listing, no fallthrough to a parent directory, no symlink
// following. It serves bytes under one root and 404s everything else, because a
// test harness that can read outside its root is a test harness that can put a
// credential into a failure artifact.

import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { securityHeaders } from "../../web/csp";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

export interface BundleServerOptions {
  /** Directory to serve. The built web bundle in production use. */
  readonly root: string;
  /** Port. Defaults to this worker's band (`worker-ports.ts`). */
  readonly port?: number;
  /** The sync origin baked into the CSP's `connect-src`. */
  readonly syncOrigin: string;
}

export interface BundleServer {
  /** `http://127.0.0.1:<port>` — the test ORIGIN. */
  readonly origin: string;
  readonly port: number;
  /**
   * CSP violations the BROWSER reported, newest last (task 55).
   *
   * # Why a report endpoint and not a page-side listener
   *
   * A `securitypolicyviolation` listener can only be installed by running a
   * script in the document, and by then the document's own scripts have already
   * run — so every boot-time violation, which is the interesting kind, has
   * already fired and is unrecoverable. Installing the listener and then
   * navigating loses it with the document. (Tried; the collector read
   * `undefined` at the assertion, so the check was passing vacuously.)
   *
   * `Content-Security-Policy-Report-Only` is the mechanism the platform provides
   * for exactly this. It blocks nothing — the ENFORCED policy is unchanged and
   * is still what the page runs under — and the browser POSTs a report for
   * anything the report-only policy would have blocked, from the first byte.
   * Pointing a duplicate of the real policy at this endpoint therefore yields
   * the enforced policy's violations without altering it.
   */
  readonly cspViolations: readonly string[];
  close(): Promise<void>;
}

/**
 * Resolve a URL path to a file inside `root`, or `null` if it escapes.
 *
 * Exported for its own test. The check is on the RESOLVED path with a separator
 * appended, not on the raw string: `…/dist-evil` must not pass as a child of
 * `…/dist`, which a bare `startsWith` would allow — the same sibling-lookalike
 * bug `src-tauri/src/plugins/importer/` guards against with a component-wise
 * check.
 */
export function resolveWithinRoot(root: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes("\0")) return null;
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const base = resolve(root);
  const full = resolve(base, normalize(rel));
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** Serve `root` with the production security headers. Resolves once listening. */
export async function startBundleServer(opts: BundleServerOptions): Promise<BundleServer> {
  const port =
    opts.port ?? Number(process.env.MYNE_WEB_E2E_BUNDLE_PORT ?? "4545");
  const headers = securityHeaders({ syncOrigin: opts.syncOrigin });
  // A duplicate of the ENFORCED policy, in report-only mode, aimed at this
  // server. It changes nothing about what the page may do — report-only never
  // blocks — and is what makes boot-time violations of the real policy
  // observable. Built from the same header value so the two cannot drift: a
  // report-only copy that differed from the enforced one would report the wrong
  // violations, which is worse than reporting none.
  const enforced = headers["Content-Security-Policy"] ?? headers["content-security-policy"];

  // `report-uri` is deprecated in favour of `report-to`, and is kept because it
  // is the one both target browsers still honour without a `Reporting-Endpoints`
  // dance. It is test-harness-only and never reaches a deployed policy.
  const reportOnly: Record<string, string> =
    typeof enforced === "string"
      ? { "content-security-policy-report-only": `${enforced}; report-uri /__csp-report` }
      : {};

  /** Populated by the browser's own report POSTs. */
  const cspViolations: string[] = [];
  /** Where the report-only policy sends them. Same origin, so no CORS. */
  const REPORT_PATH = "/__csp-report";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;

      // The browser's violation reports. Same-origin, POST, `application/csp-report`.
      if (path === REPORT_PATH) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            "csp-report"?: Record<string, string>;
          };
          const r = body["csp-report"] ?? {};
          // Directive + what it blocked. Deliberately NOT the whole report: it
          // carries `document-uri` and `referrer`, and a failure artifact must
          // not accumulate URLs that could carry a note id (task 105).
          cspViolations.push(
            `${r["violated-directive"] ?? "?"} ← ${r["blocked-uri"] || "(inline)"}`,
          );
        } catch {
          cspViolations.push("(unparseable report)");
        }
        res.writeHead(204);
        res.end();
        return;
      }
      // A blank page on the app's ORIGIN, for seeding OPFS before the app boots
      // (task 105's fixture seeder). OPFS is origin-scoped, so the seed has to
      // run here; but on `/` the app has already read what it is going to read
      // by the time a driver can write anything.
      //
      // It exists ONLY in this harness — never in the production container —
      // which is what keeps the "zero production test hooks" rule intact. It is
      // not a hook in the bundle; it is a page the bundle does not know about,
      // served by a test server, carrying no script at all.
      if (path === "/__seed") {
        res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>seed</title>");
        return;
      }
      const file = resolveWithinRoot(opts.root, path);
      if (file === null) {
        res.writeHead(403, headers);
        res.end();
        return;
      }
      try {
        // A directory is a 404, never a listing: the app is a single page and a
        // listing would expose the harness's own layout in a failure artifact.
        if ((await stat(file)).isDirectory()) throw new Error("directory");
        const body = await readFile(file);
        res.writeHead(200, {
          ...headers,
          ...reportOnly,
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        // SPA fallback for a client route (`/editor/<uuid>` — task 64), which is
        // what a reload lands on. Everything else 404s.
        if (extname(file) === "") {
          try {
            const body = await readFile(join(resolve(opts.root), "index.html"));
            res.writeHead(200, { ...headers, ...reportOnly, "content-type": TYPES[".html"] });
            res.end(body);
            return;
          } catch {
            /* fall through */
          }
        }
        res.writeHead(404, headers);
        res.end();
      }
    })();
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });

  // The BOUND port, not the requested one. `port: 0` asks the OS to choose, and
  // reporting the request back would hand every caller `…:0` — a URL that fails
  // to connect with an error naming the wrong thing entirely.
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    origin: `http://127.0.0.1:${bound}`,
    port: bound,
    cspViolations,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}
