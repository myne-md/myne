// Web implementation of the attachment-render seam (phase3-web-client task 44).
//
// The arm that has something to do. The Worker revokes the `Blob` objects it
// minted when it processes `plugin:vault-unlock|lock`; this drops the PAGE's
// copy of the URL strings, and the two halves are both required:
//
//   - the Worker's revoke is what actually frees the decrypted bytes (an object
//     URL is a GC root, so nothing else can);
//   - this clear is what stops a render after re-unlock from painting a revoked
//     URL, which shows as a broken image rather than as the pending placeholder
//     and reads to a user as data loss.
//
// Ordering does not matter between them: `lockVault()` runs this before the
// `invoke`, and a render cannot happen in between (the lock transition unmounts
// the editor). What matters is that neither is skipped.

import { clear, warm } from "./attachment-cache";

/** Drop every cached `blob:` URL string. Synchronous and infallible. */
export function releaseAttachmentUrls(): void {
  clear();
}

/**
 * Decrypt these attachments in the Worker and mint their object URLs, so the
 * synchronous `convertFileSrc` can answer for them during the render that
 * follows.
 *
 * Never rejects, and swallows per id: one attachment that is missing, was
 * deleted on another device, or refuses to decrypt must not take a note's other
 * images down with it. An id that does not warm keeps resolving to the pending
 * placeholder, which is the same thing desktop shows for a broken
 * `attachment://` fetch.
 */
export async function warmAttachmentUrls(ids: readonly string[]): Promise<void> {
  await warm(ids);
}
