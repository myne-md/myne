// Platform seam — the attachment-render resources a client holds outside the
// vault slot (phase3-web-client task 44).
//
// # Why locking needs a platform hook at all
//
// On desktop it does not, and that is the whole reason this seam exists rather
// than a shared helper. Desktop's attachment URL is `attachment://<id>`: a pure
// function of the id, resolved by a Rust handler that re-reads and re-decrypts
// per request. There is nothing cached on the page, so dropping the slot drops
// everything.
//
// A browser cannot work that way — there is no custom protocol — so it mints a
// `blob:` URL per attachment and the page holds the strings. Those strings are
// **handles to decrypted plaintext**: an object URL is a GC root, so the `Blob`
// behind it outlives every reference the page drops. Locking the vault has to
// end that, and the page's own map has to go with it, or the first render after
// a re-unlock paints revoked URLs — broken images that look like corruption
// rather than like a placeholder.
//
// So `lockVault()` calls this the way it already calls `resetGraphLayoutOnLock`
// and `resetVimStateOnLock`: platform state that outlives the slot and must not
// carry across it.

/**
 * Release any render-side attachment resources this platform holds.
 *
 * **Desktop: nothing to release.** Not a stub standing in for unfinished work —
 * a `attachment://<id>` URL caches nothing, holds no bytes, and is re-derivable
 * from the id, so there is genuinely no state here. Stated rather than left
 * implicit so the asymmetry with the web arm reads as a design fact.
 *
 * Synchronous and infallible by contract: it runs during lock teardown, where a
 * rejection has nowhere useful to go and must not stop the rest of the wipe.
 */
export function releaseAttachmentUrls(): void {
  // Intentionally empty — see above.
}

/**
 * Make [`resolveRef`](../editor-host) able to answer for these attachment ids.
 *
 * **Desktop: already can, for every id, always.** `attachment://<id>` is a pure
 * function of the id — the Rust protocol handler does the read and the decrypt
 * per request — so there is nothing to prepare and this resolves immediately.
 *
 * It exists on this side anyway, rather than being a web-only member the shared
 * host adds conditionally, because "the URL builder needs no IO" is a PROPERTY
 * OF THIS PLATFORM and stating it costs one line, whereas a conditional member
 * would put a platform test in the shared host for a call whose desktop cost is
 * zero.
 */
export async function warmAttachmentUrls(_ids: readonly string[]): Promise<void> {
  // Intentionally empty — see above.
}
