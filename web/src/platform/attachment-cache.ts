// The page-side attachment-URL cache (phase3-web-client task 44).
//
// # The problem this exists for, stated exactly
//
// `attachmentUrl(id)` in `@myne/editor` is **synchronous** — it returns a
// `string` used directly as an `<img src>`, an `<audio src>`, a pdf.js source,
// and, hardest of all, as a value interpolated into the HTML **string** that
// `emitNoteHtml` builds. Minting a `blob:` URL is asynchronous: the bytes are in
// the Worker, behind a `postMessage` round trip and an AEAD open.
//
// Those two facts cannot both be satisfied at the moment of the call. So the
// call is not the moment: this module splits it into
//
//   `warm(ids)`  — asynchronous, done BEFORE a render, fills the map
//   `lookup(id)` — synchronous, total, used DURING the render
//
// which is the same shape the desktop gets for free (its `attachment://` URL is
// derivable from the id with no IO at all).
//
// # Why a placeholder rather than an empty string
//
// `lookup` must return something for an id that has not been warmed. `""` is
// the worst option available: a browser resolves an empty `src` against the
// document URL and re-requests the PAGE, which on this client means fetching the
// whole app shell to paint one image. A `data:` URI would need a CSP grant this
// task's own criterion forbids widening. So the miss answer is a same-origin
// asset, covered by the `img-src 'self'` that is already there for the app's own
// icons.
//
// # Why the map is never invalidated per entry
//
// An attachment id is a CONTENT HASH (`protocol.md` §9.9), so a given id's bytes
// never change. There is no staleness to manage — only a session lifetime, and
// the Worker owns that: `plugin:vault-unlock|lock` revokes every URL it minted,
// which makes every string here dead at the same instant. `clear()` drops this
// side to match.

import { invoke } from "./core";

/** `attachment_id_hex → blob: URL`, mirroring what the Worker minted. */
const urls = new Map<string, string>();

/** Ids whose mint is in flight, so N renders of one image make one round trip. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * What an un-warmed id resolves to.
 *
 * A same-origin asset (`img-src 'self'`) rather than an inline `data:` URI —
 * see the header. It renders as a neutral placeholder box, which is what an
 * attachment being decrypted honestly looks like.
 */
export const PENDING_ATTACHMENT_SRC = "/attachment-pending.svg";

/**
 * The URL for `id`, synchronously.
 *
 * Total by construction: a miss yields [`PENDING_ATTACHMENT_SRC`]. It does NOT
 * start a mint — a lookup happens during render, and kicking off IO from a
 * render is how you get a render loop.
 */
export function lookup(id: string): string {
  return urls.get(id) ?? PENDING_ATTACHMENT_SRC;
}

/** Whether `id` has a real URL (i.e. a render of it will not be a placeholder). */
export function isWarm(id: string): boolean {
  return urls.has(id);
}

/**
 * Mint URLs for `ids` that do not have one yet, and resolve once they all do.
 *
 * Failures are swallowed **per id**: an attachment that is missing, was deleted
 * on another device, or refuses to decrypt must not fail the whole warm and take
 * a note's other images down with it. That id simply stays a placeholder, which
 * is the same thing the desktop shows for a broken `attachment://` fetch.
 *
 * Resolves to the ids that became warm, so a caller can skip a re-render when
 * nothing changed.
 */
export async function warm(ids: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => !urls.has(id));
  if (wanted.length === 0) return [];

  const results = await Promise.all(
    wanted.map(async (id) => {
      // Coalesce: two components rendering the same image must not decrypt it
      // twice. The Worker caches too, but the round trip and the second copy of
      // the plaintext in its heap are both avoidable from here.
      let pending = inFlight.get(id);
      if (pending === undefined) {
        pending = invoke<string>("plugin:attachments|attachment_object_url", { id })
          .then((url) => {
            urls.set(id, url);
            return url;
          })
          .catch(() => null)
          .finally(() => {
            inFlight.delete(id);
          });
        inFlight.set(id, pending);
      }
      return (await pending) === null ? null : id;
    }),
  );
  return results.filter((id): id is string => id !== null);
}

/**
 * Forget every URL.
 *
 * The Worker revokes the underlying objects on lock; this drops the page's copy
 * of the strings so a post-lock render cannot paint a revoked URL (which shows
 * as a broken image rather than as the placeholder, and looks like corruption).
 * Call it on the same lock transition.
 */
export function clear(): void {
  urls.clear();
  inFlight.clear();
}

/** Live entry count. Diagnostics + tests. */
export function size(): number {
  return urls.size;
}
