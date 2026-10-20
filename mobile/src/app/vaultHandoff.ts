import { resetDecodedAspects } from "@myne/editor/attachments/decoded-aspect";
import {
  resetMermaidZoom,
  resetPreviewCache,
  resetTranscripts,
} from "@myne/editor/attachments/session-caches";
import { resetDateTimeDisplayForLock } from "@myne/editor/host/lib/datetimeFormat";

/**
 * The module-scope editor stores a vault HANDOFF must drop (myne-md/myne#849).
 *
 * The two leaving paths that do not go through `lockVault` — create another
 * vault, and join an account — used to carry a blanket guard exemption, and the
 * exemption was granted to seven clears at once because one of them genuinely
 * must survive: a staged conversation write is state the user comes back to when
 * the join overlay is cancelled. The other five hold decrypted attachment
 * previews, decoded image aspects, transcripts of other people's speech, a
 * mermaid zoom and the reader's display formats, and every one of those is
 * re-derivable from the vault that is about to be replaced. They are cleared
 * here, in one function with one name, so the exemption that remains covers the
 * one store that needed it.
 */
export function clearHandoffCaches(): void {
  resetDecodedAspects();
  resetPreviewCache();
  resetTranscripts();
  resetMermaidZoom();
  resetDateTimeDisplayForLock();
}
