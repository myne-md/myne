// A read in flight across a vault-leaving path may not write into the next
// session (myne-md/myne#626 review round 3).
//
// `resetPreviewCache` and `resetTranscripts` clear their maps, and
// `session-caches.ts` claimed that clearing `previewInFlight` meant "a read in
// flight across a lock cannot resolve into the next session's cache". Clearing a
// map does not cancel a promise. The completion closure in `widgets.ts` captures
// its own key and writes straight into the module-scope `previewCache`, so a read
// issued before a lock repopulated the cache AFTER the clear, and on
// `leaveActiveVault` it did so after a DIFFERENT vault had been unlocked. What
// lands there is the user's decrypted attachment content, up to 24 previews at
// the host's 2 MiB read cap.
//
// `scripts/check-frontend-lock-teardown.mjs` was green the whole time and is not
// wrong to be: it asserts the CALL is present on both leaving paths, and it is.
// The property the roster entry certifies is a different statement, and nothing
// read it. This file reads it.
import { describe, expect, it } from "vitest";

import {
  isCurrentGeneration,
  resetPreviewCache,
  resetTranscripts,
  sessionGeneration,
} from "@myne/editor/attachments/session-caches";

describe("the session generation", () => {
  it("invalidates a value captured before a preview reset", () => {
    const issuedAt = sessionGeneration();
    expect(isCurrentGeneration(issuedAt)).toBe(true);
    resetPreviewCache();
    expect(isCurrentGeneration(issuedAt)).toBe(false);
  });

  it("invalidates a value captured before a transcript reset", () => {
    // Both resets bump the same counter, deliberately: a lock clears both, and a
    // read issued before it belongs to the vault that closed whichever store it
    // was headed for.
    const issuedAt = sessionGeneration();
    resetTranscripts();
    expect(isCurrentGeneration(issuedAt)).toBe(false);
  });

  it("stays valid across a value captured after the reset", () => {
    // The other direction, so the two above cannot pass because the comparison
    // is simply always false.
    resetPreviewCache();
    const issuedAt = sessionGeneration();
    expect(isCurrentGeneration(issuedAt)).toBe(true);
  });

  it("does not go backwards, so a second vault cannot reuse the first one's generation", () => {
    // Two leaving paths in a row must not return to a value some in-flight read
    // is still holding. A toggle would.
    const first = sessionGeneration();
    resetPreviewCache();
    const second = sessionGeneration();
    resetTranscripts();
    const third = sessionGeneration();
    expect(new Set([first, second, third]).size).toBe(3);
  });
});
