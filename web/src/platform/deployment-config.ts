// The web arm of the deployment-configuration seam (phase3-web-client task 50).
//
// Reads `/config.json`, which the container writes at start-up from
// `MYNE_SYNC_ORIGIN` — the same validated value its CSP is generated from, from
// the same code path (`web/container/generate-headers.mjs`), so the origin the
// client talks to and the origin the policy permits cannot drift. Two writers
// of one value is how a client ends up making requests its own CSP blocks.
//
// Same-origin and `no-store`: no cross-origin request (task 60's zero-third-party
// assertion is unaffected), and never a cached copy — an operator who re-points
// their container at a different sync server must not have the old address
// survive in a browser cache.
//
// # Failure is `null`, and the caller says so
//
// A missing or malformed document is a DEPLOYMENT fault, and the screen that
// asks already distinguishes that from a user's mistake. Returning `null` keeps
// that distinction; throwing would surface as the generic credential error and
// send someone to change a password that is fine.
//
// Cached after the first read because it cannot change within a page's life: the
// document is written once at container start, and a client that re-read it
// mid-session could pick up a new origin its own CSP still forbids.

let cached: Promise<string | null> | null = null;

async function read(): Promise<string | null> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const doc = (await res.json()) as { sync_origin?: unknown };
    const origin = typeof doc.sync_origin === "string" ? doc.sync_origin.trim() : "";
    // An empty string is the container's "not configured" — distinct from a
    // missing document, but the same answer to the caller.
    return origin.length > 0 ? origin : null;
  } catch {
    return null;
  }
}

export async function deploymentSyncOrigin(): Promise<string | null> {
  cached ??= read();
  return cached;
}
