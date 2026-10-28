// desktop-ingest task 5 — shared ingest assembly routine + `note_create` seal
// (MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// `assembleClip` is the single shared routine that orders tasks 1–4 and seals
// the note via the EXISTING `noteCreate(plaintext)` — no new command, no
// widened signature, no new capability ACL entry. Its step order is:
//   (1) vault-unlocked check  → if locked, return `{ kind: "locked" }`,
//       write NOTHING (`noteCreate` NEVER called, no pending queue);
//   (2) validate envelope (task 1) → on err, `{ kind: "error", reason }`;
//   (3) ingest images + degrade (task 3) — splices form-C embeds into body;
//   (4) resolve outbound wikilinks (task 4) over the image-spliced body;
//   (5) compose provenance frontmatter + body (task 2);
//   (6) seal via `noteCreate(plaintext)`;
//   (7) return `{ kind: "accepted", noteId, counts }` — ONLY after the seal
//       resolves (no optimistic ack).
//
// Every IPC seam is injected (`{ noteCreate, importImage, isVaultUnlocked,
// loadResolverNotes }`) so the routine is fully unit-testable with fakes —
// no Tauri runtime, no real IPC. These tests pin the acceptance criteria:
//   - full-article happy path (root note, provenance FM, image form-C, wikilink resolved);
//   - highlight/selection (smaller body, IDENTICAL path);
//   - oversize body → `PlaintextTooLarge` mapped to `{ kind: "error" }`, no note;
//   - locked vault → `{ kind: "locked" }`, `noteCreate` NEVER called;
//   - byte-stability golden (only sanctioned mutations: form-C + FM + wikilink path-form);
//   - no-fetch assertion (no global fetch / file read invoked by the routine);
//   - bookmark-body seam (a caller-supplied content-light body through the same path);
//   - no optimistic ack (a rejecting seal yields error, not accepted).

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assembleClip,
  type ClipAssemblyDeps,
} from "../../src/clip/assembleClip";
import { composeBookmarkPlaintext } from "../../src/clip/composeBookmarkPlaintext";
import type {
  RawClipEnvelope,
  ValidatedClipEnvelope,
} from "../../src/clip/validateClipEnvelope";
import type { ImportedAttachment } from "../../src/editor/attachments/insert";
import type { ResolverNote } from "../../src/notes/resolveWikilink";
import { clipImageRef } from "../../src/dialect/clip";
import { emitAttachmentEmbed } from "../../src/notes/attachmentRef";

// ---------------------------------------------------------------------------
// Fakes / fixtures
// ---------------------------------------------------------------------------

const NEW_NOTE_ID = "01910000-0000-7000-8000-000000000abc";

/** A stored-attachment success payload (spread + override per test). */
function attachment(
  overrides: Partial<ImportedAttachment> = {},
): ImportedAttachment {
  return {
    id: "a".repeat(64),
    content_type: "image/png",
    filename: "image.png",
    size: 10,
    created_at: 0,
    deduplicated: false,
    ...overrides,
  };
}

/** A raw (un-validated) envelope; spread + override per test. */
function rawEnvelope(
  overrides: Partial<RawClipEnvelope> = {},
): RawClipEnvelope {
  return {
    markdownBody: "# Title\n\nBody.\n",
    captureKind: "full-article",
    sourceUrl: "https://example.com/article",
    clipDate: "2026-06-18T12:00:00Z",
    imageBytes: [],
    ...overrides,
  };
}

/**
 * Build a deps object with all seams faked. Each fake is a `vi.fn()` so a test
 * can assert call-count (e.g. the locked path NEVER calls `noteCreate`).
 */
function makeDeps(
  overrides: Partial<ClipAssemblyDeps> = {},
): ClipAssemblyDeps & {
  noteCreate: ReturnType<typeof vi.fn>;
  importImage: ReturnType<typeof vi.fn>;
  isVaultUnlocked: ReturnType<typeof vi.fn>;
  loadResolverNotes: ReturnType<typeof vi.fn>;
} {
  const noteCreate = vi.fn(async (_plaintext: string) => NEW_NOTE_ID);
  const importImage = vi.fn(async (_image) => ({
    ok: true as const,
    attachment: attachment(),
  }));
  const isVaultUnlocked = vi.fn(async () => true);
  const loadResolverNotes = vi.fn(async (): Promise<ResolverNote[]> => []);
  return {
    noteCreate,
    importImage,
    isVaultUnlocked,
    loadResolverNotes,
    ...overrides,
  } as ClipAssemblyDeps & {
    noteCreate: ReturnType<typeof vi.fn>;
    importImage: ReturnType<typeof vi.fn>;
    isVaultUnlocked: ReturnType<typeof vi.fn>;
    loadResolverNotes: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path — full-article
// ---------------------------------------------------------------------------

describe("assembleClip — full-article happy path", () => {
  it("seals a root note with provenance FM, form-C image embed, and resolved wikilink", async () => {
    const deps = makeDeps({
      loadResolverNotes: vi.fn(async (): Promise<ResolverNote[]> => [
        { noteUuid: "u-1", title: "Existing", folder: null },
      ]),
    });
    const env = rawEnvelope({
      markdownBody: `See [[Existing]] and ![cap](${clipImageRef(0)})\n`,
      imageBytes: [{ filename: "shot.png", bytes: new Uint8Array([1, 2, 3]) }],
    });

    const result = await assembleClip(env, env.markdownBody, deps);

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.noteId).toBe(NEW_NOTE_ID);
    expect(result.counts.ingested.image).toBe(1);
    expect(result.counts.omitted.image).toBe(0);

    // `noteCreate` was sealed exactly once with the composed plaintext.
    expect(deps.noteCreate).toHaveBeenCalledTimes(1);
    const sealed = deps.noteCreate.mock.calls[0][0] as string;

    // Provenance FM present (SYNC-14: source / url / clipped).
    expect(sealed).toMatch(/^---\n/);
    expect(sealed).toContain("source:");
    expect(sealed).toContain("url:");
    expect(sealed).toContain("clipped:");
    expect(sealed).toContain("https://example.com/article");

    // Image rewritten to form-C embed (the clip-image:N ref is gone).
    expect(sealed).toContain(emitAttachmentEmbed("a".repeat(64), "image.png"));
    expect(sealed).not.toContain(clipImageRef(0));

    // Wikilink resolved to canonical §3 path-form (title-only ref rewritten to
    // `[[<path>.md|<display>]]` — the same bytes a manual R2 convert produces).
    expect(sealed).toContain("[[Existing.md|Existing]]");
    // The bare title-only ref is gone (it was rewritten, not left as-authored).
    expect(sealed).not.toContain("See [[Existing]] ");
  });

  it("returns accepted ONLY after the seal resolves (carries the new note id)", async () => {
    const deps = makeDeps();
    const result = await assembleClip(rawEnvelope(), "Body\n", deps);
    expect(result).toEqual({
      kind: "accepted",
      noteId: NEW_NOTE_ID,
      counts: expect.any(Object),
      // The ingest-time-compression tally rides out with the counts so the
      // clip notice can disclose it (`decisions.md` 2026-07-30). Zero here —
      // the fake import port stores bytes verbatim.
      compression: { count: 0, originalBytes: 0, finalBytes: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Highlight / selection — smaller body, IDENTICAL path
// ---------------------------------------------------------------------------

describe("assembleClip — highlight/selection", () => {
  it("runs a smaller selection body through the identical path", async () => {
    const deps = makeDeps();
    const env = rawEnvelope({
      captureKind: "selection",
      markdownBody: "Just a sentence.\n",
    });

    const result = await assembleClip(env, env.markdownBody, deps);

    expect(result.kind).toBe("accepted");
    expect(deps.noteCreate).toHaveBeenCalledTimes(1);
    const sealed = deps.noteCreate.mock.calls[0][0] as string;
    expect(sealed).toContain("Just a sentence.");
    // Same provenance composition regardless of capture kind.
    expect(sealed).toContain("clipped:");
  });
});

// ---------------------------------------------------------------------------
// Locked vault — write NOTHING
// ---------------------------------------------------------------------------

describe("assembleClip — locked vault", () => {
  it("returns locked and NEVER calls noteCreate, validate, import, or resolve", async () => {
    const deps = makeDeps({
      isVaultUnlocked: vi.fn(async () => false),
    });

    const result = await assembleClip(
      rawEnvelope({
        imageBytes: [{ filename: "x.png", bytes: new Uint8Array([1]) }],
      }),
      "Body\n",
      deps,
    );

    expect(result).toEqual({ kind: "locked" });
    expect(deps.noteCreate).not.toHaveBeenCalled();
    expect(deps.importImage).not.toHaveBeenCalled();
    expect(deps.loadResolverNotes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Envelope rejection — error class
// ---------------------------------------------------------------------------

describe("assembleClip — envelope rejection", () => {
  it("maps a validation rejection to an error result without sealing", async () => {
    const deps = makeDeps();
    const result = await assembleClip(
      rawEnvelope({ captureKind: "not-a-kind" }),
      "Body\n",
      deps,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.reason).toBe("UnrecognizedCaptureKind");
    expect(deps.noteCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Oversize body — PlaintextTooLarge → error, no half-saved note
// ---------------------------------------------------------------------------

describe("assembleClip — oversize body", () => {
  it("maps a PlaintextTooLarge seal reject to an error result (no note)", async () => {
    const deps = makeDeps({
      noteCreate: vi.fn(async () => {
        throw { kind: "PlaintextTooLarge" };
      }),
    });

    const result = await assembleClip(rawEnvelope(), "Body\n", deps);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.reason).toBe("PlaintextTooLarge");
  });

  it("maps any note-create reject variant to an error result", async () => {
    const deps = makeDeps({
      noteCreate: vi.fn(async () => {
        throw { kind: "Io", detail: { io_error_kind: "NoSpace" } };
      }),
    });
    const result = await assembleClip(rawEnvelope(), "Body\n", deps);
    expect(result.kind).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Byte-stability golden — only sanctioned mutations
// ---------------------------------------------------------------------------

describe("assembleClip — byte-stability (C1)", () => {
  it("mutates ONLY via form-C rewrite + FM injection + wikilink path-form", async () => {
    const deps = makeDeps({
      loadResolverNotes: vi.fn(async (): Promise<ResolverNote[]> => []),
    });
    // A body with content that MUST survive verbatim: raw HTML, special chars,
    // a non-clip link, trailing whitespace lines. No clip image, no wikilink.
    const body =
      "Line with <b>raw html</b> & ümlaut.\n\n" +
      "A [normal](https://x.test) link.\n" +
      "  indented   spaces  \n";
    const env = rawEnvelope({ markdownBody: body, imageBytes: [] });

    await assembleClip(env, env.markdownBody, deps);

    const sealed = deps.noteCreate.mock.calls[0][0] as string;
    // The composed plaintext is EXACTLY the sanctioned frontmatter prefix
    // (`---\n…\n---\n` + the composer's blank-line separator) followed by the
    // body BYTE-FOR-BYTE. No clip image + no wikilink in this fixture, so the
    // body cannot have been touched by tasks 3/4 — the ONLY change permitted
    // here is FM injection (task 2). Strip the FM block + its separator and
    // assert the remainder is the body verbatim (no content sanitization, no
    // byte-scrubbing — C1).
    const fmMatch = sealed.match(/^---\n[\s\S]*?\n---\n\n?/);
    expect(fmMatch).not.toBeNull();
    const afterFm = sealed.slice(fmMatch![0].length);
    expect(afterFm).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// No core-side fetch — no SSRF, no read-receipt leak
// ---------------------------------------------------------------------------

describe("assembleClip — no core-side fetch", () => {
  it("never invokes global fetch for url/source", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const deps = makeDeps();
      await assembleClip(
        rawEnvelope({ sourceUrl: "https://attacker.test/track" }),
        "Body\n",
        deps,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Bookmark-body seam (task 9 parameterization point)
// ---------------------------------------------------------------------------

describe("assembleClip — bookmark-body seam", () => {
  it("seals a caller-supplied content-light body through the identical path", async () => {
    const deps = makeDeps();
    // A url-bookmark (task 9) supplies a content-light body WITHOUT forking the
    // routine — the body is the parameterization point.
    const bookmarkBody = "Bookmarked link.\n";
    const env = rawEnvelope({
      captureKind: "bookmark",
      markdownBody: "FULL ARTICLE BODY THAT MUST BE IGNORED",
    });

    const result = await assembleClip(env, bookmarkBody, deps);

    expect(result.kind).toBe("accepted");
    const sealed = deps.noteCreate.mock.calls[0][0] as string;
    // The caller-supplied body is what got sealed, NOT envelope.markdownBody.
    expect(sealed).toContain("Bookmarked link.");
    expect(sealed).not.toContain("FULL ARTICLE BODY THAT MUST BE IGNORED");
  });

  it("flows a bookmark-shaped body (autolink URL + title) to a root note with provenance FM", async () => {
    const deps = makeDeps();
    // SYNC-16 bookmark shape: the title as a heading + the source URL as a
    // bare autolink (click-to-open). Same assembly path as a clip — the only
    // difference is the caller's body; provenance/render/root logic is identical.
    const bookmarkBody = "# Example Page\n\nhttps://example.com/page\n";
    const env = rawEnvelope({
      captureKind: "bookmark",
      sourceUrl: "https://example.com/page",
      clipDate: "2026-06-18T12:00:00Z",
      markdownBody: "(full-article body — must be ignored for a bookmark)",
      imageBytes: [],
    });

    const result = await assembleClip(env, bookmarkBody, deps);

    expect(result.kind).toBe("accepted");
    const sealed = deps.noteCreate.mock.calls[0][0] as string;
    // Root note — no `folder:` line (SYNC-15).
    expect(sealed).not.toMatch(/^folder:/m);
    // Provenance FM present via the SAME unmanaged path as a clip (SYNC-14).
    expect(sealed).toMatch(/^source:/m);
    expect(sealed).toMatch(/^clipped:/m);
    // The bare-autolink URL + title rode through verbatim (no fork).
    expect(sealed).toContain("# Example Page");
    expect(sealed).toContain("https://example.com/page");
  });

  it("performs NO dedup — two bookmarks of the same URL are two independent notes", async () => {
    // Each ingest is an independent write: no source-URL lookup, no overwrite,
    // no "you already have this" gate (SYNC-16, story 11). There is no dedup
    // seam in `ClipAssemblyDeps` at all — the only query dep is
    // `loadResolverNotes` (wikilinks), never a source-URL index.
    const ids = ["01910000-0000-7000-8000-00000000000a", "01910000-0000-7000-8000-00000000000b"];
    let n = 0;
    const deps = makeDeps({ noteCreate: vi.fn(async () => ids[n++]) });
    const body = "# Same Page\n\nhttps://example.com/same\n";
    const env = rawEnvelope({
      captureKind: "bookmark",
      sourceUrl: "https://example.com/same",
    });

    const r1 = await assembleClip(env, body, deps);
    const r2 = await assembleClip(env, body, deps);

    expect(r1.kind).toBe("accepted");
    expect(r2.kind).toBe("accepted");
    // Two independent writes → two distinct note ids; no dedup collapse.
    expect(deps.noteCreate).toHaveBeenCalledTimes(2);
    if (r1.kind === "accepted" && r2.kind === "accepted") {
      expect(r1.noteId).not.toBe(r2.noteId);
    }
  });
});

// ---------------------------------------------------------------------------
// Bookmark COMPOSER seam (url-bookmark task 3, MYND-447) — the OTHER
// parameterization point: a caller-supplied composer, defaulting to the clip
// composer. Pins (a) the bookmark composer seals the SYNC-16 shape and (b) the
// default clip path is unaffected by the parameterization.
// ---------------------------------------------------------------------------

describe("assembleClip — bookmark composer seam", () => {
  it("seals the SYNC-16 bookmark plaintext via the caller-supplied composer", async () => {
    const deps = makeDeps();
    // The url-bookmark caller (the dispatch listener) passes a content-light body
    // (the bare-autolink URL) + a composer that derives the managed `title:` +
    // `source:`/`clipped:` from the envelope.
    const body = "https://example.com/page\n";
    const env = rawEnvelope({
      captureKind: "bookmark",
      sourceUrl: "https://example.com/page",
      clipDate: "2026-06-18T12:00:00Z",
      markdownBody: "# Example Page\n\nhttps://example.com/page\n",
      imageBytes: [],
    });

    const composer = (envelope: ValidatedClipEnvelope, _resolvedBody: string) =>
      composeBookmarkPlaintext({
        url: envelope.sourceUrl,
        title: "Example Page",
        clippedDate: envelope.clipDate,
      });

    const result = await assembleClip(env, body, deps, composer);

    expect(result.kind).toBe("accepted");
    expect(deps.noteCreate).toHaveBeenCalledTimes(1);
    const sealed = deps.noteCreate.mock.calls[0][0] as string;

    // The managed `title:` is the page name (not "Untitled").
    expect(sealed).toMatch(/^title: /m);
    expect(sealed).toContain("Example Page");
    // Provenance via the unmanaged path — `source:` + `clipped:`, and NO `url:`.
    expect(sealed).toMatch(/^source: https:\/\/example\.com\/page$/m);
    expect(sealed).toMatch(/^clipped: 2026-06-18T12:00:00\.000Z$/m);
    expect(sealed).not.toMatch(/^url\s*:/m);
    // Body = the bare-autolink URL; root note (no folder line, SYNC-15).
    const afterFm = sealed.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
    expect(afterFm.trim()).toBe("https://example.com/page");
    expect(sealed).not.toMatch(/^folder:/m);
    // It is byte-identical to invoking the bookmark composer directly.
    expect(sealed).toBe(
      composeBookmarkPlaintext({
        url: "https://example.com/page",
        title: "Example Page",
        clippedDate: "2026-06-18T12:00:00.000Z",
      }),
    );
  });

  it("names the clip from the envelope body's leading heading (default composer)", async () => {
    // myne-md/myne#936. This test used to assert the opposite, "no title", which
    // certified the defect: a clip sealed without the managed `title:` has no
    // name in any surface, because a title is read from frontmatter only. The
    // DEFAULT composer now writes it, and the routine supplies it, so no caller
    // can land an untitled note by leaving the compose step alone.
    const deps = makeDeps();
    const env = rawEnvelope({
      markdownBody: "# A Real Page Title\n\nThe article body.\n",
      sourceUrl: "https://example.com/article",
      clipDate: "2026-06-18T12:00:00Z",
    });

    const result = await assembleClip(env, "A clip body.\n", deps);

    expect(result.kind).toBe("accepted");
    const sealed = deps.noteCreate.mock.calls[0][0] as string;
    // The note is NAMED...
    expect(sealed).toMatch(/^title: A Real Page Title$/m);
    // ...and a clip still emits BOTH `source:` and `url:` (the SYNC-14
    // redundancy), which is what distinguishes it from the bookmark shape.
    expect(sealed).toMatch(/^source: https:\/\/example\.com\/article$/m);
    expect(sealed).toMatch(/^url: https:\/\/example\.com\/article$/m);
  });

  it("leaves the note untitled when the page had no title", async () => {
    // The degenerate, and the reason the title cannot be read off `resolvedBody`:
    // no `# ` heading means no title, and an article's own later heading must not
    // be borrowed as one.
    const deps = makeDeps();
    const env = rawEnvelope({
      markdownBody: "Some lede paragraph.\n\n# Introduction\n\nBody.\n",
    });

    const result = await assembleClip(env, env.markdownBody, deps);

    expect(result.kind).toBe("accepted");
    const sealed = deps.noteCreate.mock.calls[0][0] as string;
    expect(sealed).toMatch(/^title: ""$/m);
    expect(sealed).not.toMatch(/^title: Introduction$/m);
  });
});
