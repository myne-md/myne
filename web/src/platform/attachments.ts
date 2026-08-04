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
 * Resolves to the ids whose resolved URL CHANGED: those newly minted, plus any
 * the Worker revoked to stay inside its byte budget. A caller repaints exactly
 * those and leaves every other tile alone.
 *
 * Never rejects, and swallows per id: one attachment that is missing, was
 * deleted on another device, or refuses to decrypt must not take a note's other
 * images down with it. An id that does not warm keeps resolving to the pending
 * placeholder, which is the same thing desktop shows for a broken
 * `attachment://` fetch.
 */
export async function warmAttachmentUrls(
  ids: readonly string[],
): Promise<readonly string[]> {
  return await warm(ids);
}

/**
 * Whether `resolveRef` needs ids warmed before it can answer for them.
 *
 * **Web: always.** A `blob:` URL has to be minted before `resolveRef` can
 * answer, so every surface that renders thumbnails must warm what it shows —
 * and, since the Worker's budget is finite, must warm only what it shows.
 */
export const ATTACHMENT_REFS_NEED_WARMING: boolean = true;
