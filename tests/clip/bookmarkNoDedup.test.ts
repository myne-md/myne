// url-bookmark task 7 — no-dedup re-bookmark (independent note per save).
//
// Re-bookmarking the same URL creates ANOTHER independent note (a fresh
// UUIDv7) at the vault root: no source-URL lookup, no overwrite, no "you
// already have this" prompt (SYNC-16, story 11). This is the ABSENCE of a
// feature — `assembleClip` has no dedup seam at all; its only query dep is
// `loadResolverNotes` (wikilinks), never a source-URL reverse index. This pins
// the property through the REAL bookmark composer (task 3).

import { describe, expect, it, vi } from "vitest";
import { assembleClip, type ClipAssemblyDeps } from "../../src/clip/assembleClip";
import { composeBookmarkPlaintext } from "../../src/clip/composeBookmarkPlaintext";
import type { RawClipEnvelope } from "../../src/clip/validateClipEnvelope";

function bookmarkEnvelope(url: string): RawClipEnvelope {
  return {
    markdownBody: "# Example Page",
    captureKind: "bookmark",
    sourceUrl: url,
    clipDate: "2026-06-18T12:00:00Z",
    imageBytes: [],
  };
}

describe("url-bookmark — no-dedup re-bookmark (task 7)", () => {
  it("two bookmarks of the same URL → two distinct root notes, no source-URL query", async () => {
    const ids = [
      "01910000-0000-7000-8000-0000000aaaa1",
      "01910000-0000-7000-8000-0000000aaaa2",
    ];
    let n = 0;
    const noteCreate = vi.fn(async (_plaintext: string) => ids[n++]);
    // The ONLY query dep is the wikilink resolver note-set; there is no
    // source-URL reverse-index dep to consult. A bare-URL bookmark body has no
    // wikilinks, so even this is a no-op — asserted below.
    const loadResolverNotes = vi.fn(async () => []);
    const deps: ClipAssemblyDeps = {
      noteCreate,
      importImage: vi.fn(async () => ({ ok: false as const })),
      isVaultUnlocked: vi.fn(async () => true),
      loadResolverNotes,
    };

    const url = "https://example.com/same-page";
    const body = `${url}\n`;
    const compose = (env: { sourceUrl: string; clipDate: string }, _resolvedBody: string) =>
      composeBookmarkPlaintext({
        url: env.sourceUrl,
        title: "Example Page",
        clippedDate: env.clipDate,
      });

    const r1 = await assembleClip(bookmarkEnvelope(url), body, deps, compose);
    const r2 = await assembleClip(bookmarkEnvelope(url), body, deps, compose);

    expect(r1.kind).toBe("accepted");
    expect(r2.kind).toBe("accepted");
    // Two independent writes — no overwrite, no dedup collapse.
    expect(noteCreate).toHaveBeenCalledTimes(2);
    if (r1.kind === "accepted" && r2.kind === "accepted") {
      expect(r1.noteId).not.toBe(r2.noteId);
    }
    // No existence/source-URL lookup occurred — and the bookmark body (a bare
    // autolink URL, no `[[wikilink]]`) hits the resolver FAST PATH, so the
    // resolver-note loader is never consulted at all. Either way there is no
    // "do I already have URL X?" dedup query.
    expect(loadResolverNotes).toHaveBeenCalledTimes(0);
  });
});
