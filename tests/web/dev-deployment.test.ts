/**
 * The dev server's deployment facts, held by a test rather than by a comment
 * (myne-md/myne#873).
 *
 * # What this is for
 *
 * `pnpm web:dev` refuses to boot unless the dev server reproduces the two things the
 * container supplies: cross-origin isolation (no COOP/COEP means `crossOriginIsolated`
 * is false and `SharedArrayBuffer` is undefined, which `web/src/environment-gate.ts`
 * checks at boot) and a `/config.json` naming the sync origin. Both live in
 * `web/vite.config.ts`, and until this file existed nothing in the tree asserted
 * either: a later edit that emptied the `headers` block or dropped `apply: "serve"`
 * from the plugin would leave `pnpm test`, `pnpm web:build` and every `check-web-*`
 * guard green while the advertised dev command silently regressed to the refusal
 * screen this change exists to remove.
 *
 * # Why it imports the config instead of grepping it
 *
 * A regex over config source passes on a comment that mentions the header name and
 * fails on a reformat, which is the shape `check-twin-inventory.mjs` records as a roster
 * compared against a second copy of itself. Importing the module asks the resolved
 * object the question directly.
 *
 * # The pair is compared against `web/csp.ts`, not against a literal
 *
 * The dev server IMPORTS `ISOLATION_HEADERS` from the container's own header set, so
 * what this asserts is that one declaration still feeds both, which is a property that
 * survives a value change and would be lost by a hardcoded expectation here. The third
 * case exists because Vite falls back to `server.headers` for the preview server
 * (`headers: preview?.headers ?? server.headers`), so without the explicit empty object
 * `pnpm web:preview` would start sending isolation while still sending no CSP and no
 * `/config.json`, and the sentence in `e2e-web/AGENTS.md` explaining why that lane serves
 * the bundle itself would quietly stop being true.
 */

import { describe, expect, it } from "vitest";

import config from "../../web/vite.config";
import { ISOLATION_HEADERS } from "../../web/csp";

interface PluginLike {
  name?: string;
  apply?: string;
}

const resolvedPlugins = (config.plugins ?? []).flat() as unknown as PluginLike[];

describe("web dev deployment (web/vite.config.ts)", () => {
  it("sends both isolation headers, from the container's own declaration", () => {
    expect(config.server?.headers).toEqual({ ...ISOLATION_HEADERS });
  });

  it("registers the /config.json middleware as serve-only", () => {
    const plugin = resolvedPlugins.find((p) => p.name === "myne:dev-deployment");
    expect(plugin).toBeDefined();
    expect(plugin?.apply).toBe("serve");
  });

  it("keeps the pair off `vite preview`, which sends no CSP and no config document", () => {
    const previewHeaders = config.preview?.headers ?? config.server?.headers;
    expect(previewHeaders).not.toHaveProperty("Cross-Origin-Opener-Policy");
    expect(previewHeaders).not.toHaveProperty("Cross-Origin-Embedder-Policy");
  });
});
