// Content-Security-Policy construction for the self-host container
// (phase3-web-client tasks 49, 50, 55).
//
// The contradiction this resolves: a self-hoster points the client at **their
// own** sync server, so the server origin cannot be baked into the bundle — but
// CSP's `connect-src` has to name that exact origin, because a wildcard there
// would undo the whole point of the policy. A fixed CSP plus a variable server
// is a contradiction, so the policy is **generated from the runtime
// configuration at container start** and is exactly as tight for a self-hoster
// as for the hosted instance.
//
// Everything else in the policy is fixed, and fixed narrowly:
//
//   - `default-src 'none'` — start from nothing and name what is allowed. A
//     policy built by subtraction acquires holes as the app grows.
//   - **no `'unsafe-inline'`, no `'unsafe-eval'`, anywhere.** The app is a
//     bundled SPA; it needs neither. `'unsafe-eval'` in particular would be
//     load-bearing in the wrong direction — the wasm core is instantiated from
//     a fetched module, not from `eval`.
//   - **zero third-party origins.** This is not a CSP preference, it is the
//     commitment the security posture already makes (`threat-model.md` §6,
//     TB9), and it is what makes cross-origin isolation free rather than a
//     trade: COOP/COEP cost "no third-party origins", which is already paid.
//   - `frame-ancestors 'none'` — the app is never framed. Clickjacking against
//     an unlocked vault is a real attack and this is its whole defence.
//   - `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` — the app
//     has no plugins, no `<base>`, and posts no forms. Each of these is a
//     documented injection vector that costs nothing to close.
//
// `wasm-unsafe-eval` is the one that looks alarming and is not: it is the CSP
// keyword that permits **WebAssembly compilation** and nothing else. Without
// it the wasm core cannot instantiate at all. It does not enable `eval`.

/** Where the client is allowed to talk to. */
export interface CspConfig {
  /** The sync server's origin, e.g. `https://sync.example.org`. */
  syncOrigin: string;
}

export class InvalidSyncOriginError extends Error {
  constructor(value: string, reason: string) {
    super(`invalid sync origin ${JSON.stringify(value)}: ${reason}`);
    this.name = "InvalidSyncOriginError";
  }
}

/**
 * Validate and normalise a sync origin.
 *
 * Strict on purpose. This value goes straight into a security policy, so
 * anything ambiguous is refused rather than normalised into something the
 * operator did not intend:
 *
 *   - **`https` only**, except for loopback. Plain `http` to a remote host
 *     would let the browser downgrade the sync connection, and the whole A4
 *     story on web already rests on nothing but TLS.
 *   - **No path, query or fragment.** An origin is scheme + host + port; a CSP
 *     source with a path means something different and subtly narrower.
 *   - **No wildcard.** `*` cannot be combined with the credentialed requests
 *     the client makes, and accepting it would turn a typo into an open policy.
 */
export function normaliseSyncOrigin(raw: string): string {
  const value = raw.trim();
  if (value === "") throw new InvalidSyncOriginError(raw, "empty");
  if (value.includes("*")) throw new InvalidSyncOriginError(raw, "wildcards are not permitted");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidSyncOriginError(raw, "not a URL (expected scheme://host[:port])");
  }

  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new InvalidSyncOriginError(raw, "must be https (http is allowed only for loopback)");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new InvalidSyncOriginError(raw, "must be an origin only — no path, query or fragment");
  }
  return url.origin;
}

/**
 * Build the policy.
 *
 * Returned as a single line because that is how it is served; the directive
 * order is stable so a diff between two deployments is readable.
 */
export function buildCsp(config: CspConfig): string {
  const sync = normaliseSyncOrigin(config.syncOrigin);
  return [
    "default-src 'none'",
    // The bundle only. `wasm-unsafe-eval` permits WebAssembly compilation and
    // nothing else — the wasm core cannot instantiate without it.
    "script-src 'self' 'wasm-unsafe-eval'",
    // Inline styles are the one concession: the UI styles through React's
    // `style={{}}` by project convention (`src/AGENTS.md` — no Tailwind, no CSS
    // modules), which produces inline style attributes. This does not permit
    // inline <script>.
    "style-src 'self' 'unsafe-inline'",
    // Self-hosted fonts only; a CDN font would be a third-party origin. The
    // typography faces and the 13 MB Excalidraw font tree are both served from
    // this origin (task 99), so `'self'` covers everything the app itself asks
    // for.
    //
    // `data:` is the one exception, and it is deliberately NOT the same
    // judgement as the `img-src data:` removal above. Found by opening a note on
    // the deployed origin: `@excalidraw/excalidraw`'s production chunk carries a
    // woff2 face inline as a `data:` URI **inside JavaScript**, and registers it
    // at runtime. Unlike task 99's checkerboard PNG — which lives in a
    // stylesheet and can therefore be extracted to an emitted asset at build
    // time — a base64 string in a vendored bundle is not something Vite can
    // rewrite, and patching a dependency's dist to satisfy a policy is worse
    // than the grant. The alternatives were: drop drawing on web (task 99
    // decided SHIP, for the good reason that drawing notes sync), or leave every
    // note open logging a CSP violation while the face silently fails to load.
    //
    // What the grant costs is bounded in a way `img-src data:` was not. A font
    // is a passive resource: it executes nothing, it is not a navigation target,
    // and `font-src` is not a path to script execution — an attacker who could
    // supply a `data:` font would need script execution already, which
    // `script-src 'self'` is what governs. The directive that made `data:`
    // dangerous was `img-src`, where a `data:` source is a general-purpose
    // exfiltration and content-injection channel; that removal stands.
    "font-src 'self' data:",
    // `blob:` is what the ATTACHMENT render path needs, and it is the narrow
    // grant rather than the convenient one (phase3-web-client task 44): a
    // `blob:` URL is an opaque same-origin handle to an object this origin
    // already holds — it cannot be forged from a string and it dies when
    // revoked — whereas `data:` carries its payload inline, so admitting it
    // admits ANY bytes any script can construct. Attachments never use `data:`.
    // The pending placeholder is a same-origin asset, covered by `'self'`.
    //
    // **`data:` is gone (phase3-web-client task 97).** It survived for two
    // pre-existing surfaces, neither an attachment: the share-card rasterisation
    // and the device-join QR, both of which serialised an SVG to a `data:` URI
    // for an `<img>`. Both now mint an object URL instead
    // (`noteImageCard.svgToObjectUrl`), which is the same handle attachments
    // already use and needs no policy of its own — so the directive narrowed
    // rather than the two features being dropped.
    //
    // Resolved HERE rather than by whichever task landed second: task 44's
    // criterion is that the policy admit object URLs *without* admitting remote
    // or `data:` content, and a `data:` source left in place for an unrelated
    // feature would have made that criterion quietly false.
    "img-src 'self' blob:",
    // Audio and video attachments only — no `data:` here, and none needed.
    "media-src 'self' blob:",
    // The one variable directive: the app's own origin plus exactly the
    // configured sync server. Never a wildcard.
    `connect-src 'self' ${sync}`,
    // Same-origin workers only. The wasm core runs in one of these.
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * The cross-origin isolation pair, named so that there is ONE declaration of it.
 *
 * `web/vite.config.ts`'s dev server sends these two and nothing else from the set
 * below, because they are the two `web/src/environment-gate.ts` probes at boot. It
 * imports this constant rather than repeating the strings, for the reason
 * `e2e-web/AGENTS.md` records about the bundle server: a copy would drift, and it
 * would drift in the one direction that matters, towards a lane looser than
 * production. A dev server whose pair no longer matched the container's would
 * reproduce an isolation posture nobody ships, and nothing would say so.
 */
export const ISOLATION_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * The complete header set the container serves.
 *
 * Kept together with the CSP because they are one security posture, not a
 * policy plus some extras: dropping COEP turns cross-origin isolation off, and
 * the client needs it. Which is why they are baked into the image rather than
 * described in a runbook (`decisions.md` 2026-07-26, "the web client ships
 * self-hostable as a container with security headers baked in").
 *
 * **The app cannot detect MOST of these, but COOP/COEP is the exception**
 * (myne#320). CSP, HSTS, CORP and Permissions-Policy have no in-page verdict —
 * a deployment missing them looks exactly like a correct one. Cross-origin
 * isolation does: the browser publishes `crossOriginIsolated`, and
 * `SharedArrayBuffer` is either constructible or not. The boot gate probes it
 * (`web/src/environment-gate.ts`), because its absence is not a weakened
 * posture but a client that unlocks fine and then dies at the first HTTP 429
 * from the sync server. This comment used to say the whole set was
 * undetectable, and that claim is what left the probe unwritten.
 */
export function securityHeaders(config: CspConfig): Record<string, string> {
  return {
    "Content-Security-Policy": buildCsp(config),
    // Cross-origin isolation. Costs "no third-party origins", which is already
    // committed; buys `SharedArrayBuffer` and precise timers.
    ...ISOLATION_HEADERS,
    "Cross-Origin-Resource-Policy": "same-origin",
    // Two years, subdomains included, preload-eligible: the bundle origin is
    // the one place a MITM is fatal (a MITM on the sync origin sees only
    // ciphertext), so it is the one most defended.
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // The app uses none of these. Denying them shrinks what a substituted
    // bundle could reach without the user noticing a permission prompt.
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  };
}
