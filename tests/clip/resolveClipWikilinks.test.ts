// desktop-ingest task 4 — outbound wikilink resolution against the decrypted
// index (MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// `resolveClipWikilinks` is the PURE pass that rewrites a clip body's title-only
// `[[wikilink]]`s into Myne's canonical §3 path-form by REUSING the importer's
// R2 conversion machinery (`planWikilinkConversion` / `resolveWikilink` /
// `convertedLink`) over the DECRYPTED resolver note-set — desktop-side only. A
// clip body the browser emitted carries only plain title-only links; resolving
// them against the existing notes joins the clip into the backlink graph
// immediately. Broken / ambiguous links are left exactly as the importer's R2
// pass leaves them: a no-match is left as-authored (no fabricated target), an
// ambiguous match resolves via the existing shortest-path heuristic.
//
// SYNC-11 — the decrypted note graph NEVER enters the hostile browser runtime.
// This is satisfied by construction (this is desktop WebView TS, the browser
// only ever emitted plain markdown); the function takes the resolver note-set as
// input / via an injected loader port and never calls out to any browser /
// extension transport.
//
// These tests pin the five acceptance criteria against a FIXTURE note-set:
//   1. a title-only link matching an existing note → canonical path-form;
//   2. a link matching nothing → left unchanged (no fabricated target);
//   3. an ambiguous match → resolved via the shortest-path heuristic (reuse, no
//      new resolution logic);
//   4. resolution reads the resolver note-set desktop-side — the pass takes the
//      note-set as input (via the injected loader port); nothing is requested
//      from / sent to the browser;
//   5. resolve / broken / ambiguous covered against the fixture note-set.

import { describe, expect, it, vi } from "vitest";
import {
  resolveClipWikilinks,
  type ResolverNoteSetLoader,
} from "../../src/clip/resolveClipWikilinks";
import { convertedLink } from "../../src/editor/wikilink/convert";
import { extractWikilinks } from "../../src/dialect/visitors/wikilinks";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

/** A resolver note (title + canonical folder). */
function note(noteUuid: string, title: string, folder: string | null = null): ResolverNote {
  return { noteUuid, title, folder };
}

/** The expected canonical path-form a converted title-only `[[Title]]` emits for
 *  `target` — derived by reusing `convertedLink` over the body's own ref so the
 *  test pins the SAME output the production pass emits (no forked expectation). */
function expectedRewrite(body: string, target: ResolverNote): string {
  const ref = extractWikilinks(body).find((r) => r.targetKind === "title");
  if (ref === undefined) throw new Error(`no title-only wikilink in: ${body}`);
  return convertedLink(target, ref);
}

/** A loader port that just yields the given fixture note-set. */
function loaderOf(notes: readonly ResolverNote[]): ResolverNoteSetLoader {
  return () => Promise.resolve([...notes]);
}

describe("resolveClipWikilinks — outbound wikilink resolution (R2 reuse)", () => {
  it("rewrites a title-only link matching an existing note to canonical path-form (#1)", async () => {
    const notes = [note("u-projects", "Projects", "Work/")];
    const body = "See [[Projects]] for details.";

    const out = await resolveClipWikilinks(body, loaderOf(notes));

    // Canonical §3 path-form, byte-identical to the importer's R2 emit.
    const expected = expectedRewrite(body, notes[0]!);
    expect(out).toContain(expected);
    // The folder segment is baked (WL-4) — the link is now self-resolving.
    expect(out).toContain("[[Work/Projects.md|Projects]]");
    // The surrounding prose is untouched.
    expect(out).toBe(`See ${expected} for details.`);
  });

  it("FAST PATH: a body with NO `[[` returns unchanged without loading the resolver set", async () => {
    // A web clip almost never contains `[[…]]` (Myne-internal syntax). Such a
    // body must skip the loader entirely — it decrypts the WHOLE vault to build
    // the resolver set, and paying that on every clip can blow the relay dispatch
    // timeout on a large vault (the note seals late → spurious "couldn't clip").
    const loader = vi.fn(() =>
      Promise.resolve([note("u-x", "X")] as readonly ResolverNote[]),
    );
    const body = "A plain clip — a [markdown](https://example.com) link, no wikilinks.";

    const out = await resolveClipWikilinks(body, loader);

    expect(out).toBe(body); // unchanged
    expect(loader).not.toHaveBeenCalled(); // the whole-vault load was skipped
  });

  it("FAST PATH: an image-only body (`![[att:…]]`, no real `[[`) still skips the loader", async () => {
    // ingestClipImages runs BEFORE resolution, so any image-bearing clip already
    // carries form-C embeds `![[att:…]]` whose `[[` would defeat a naive guard and
    // force a whole-vault decrypt on every image clip. The guard must ignore embeds.
    const loader = vi.fn(() =>
      Promise.resolve([note("u-x", "X")] as readonly ResolverNote[]),
    );
    const body = "A clipped article.\n\n![[att:0a1b2c|photo.png]]\n\nMore text.";

    const out = await resolveClipWikilinks(body, loader);

    expect(out).toBe(body); // unchanged
    expect(loader).not.toHaveBeenCalled(); // embeds must NOT trigger the load
  });

  it("leaves a link matching nothing UNCHANGED — no fabricated target (#2)", async () => {
    const notes = [note("u-other", "Something Else")];
    const body = "A dangling [[Nonexistent Note]] link.";

    const out = await resolveClipWikilinks(body, loaderOf(notes));

    // As-authored: the broken link is left exactly as written (no rewrite, no
    // invented path-form target).
    expect(out).toBe(body);
    expect(out).toContain("[[Nonexistent Note]]");
    expect(out).not.toContain(".md");
  });

  it("resolves an ambiguous match via the shortest-path heuristic (#3)", async () => {
    // Two notes share the title "Meeting"; the title-only link is ambiguous.
    // The reused resolver's shortest-path heuristic (fewest folder segments,
    // lexicographic tiebreak) picks the root-level one.
    const deep = note("u-deep", "Meeting", "Work/Clients/Acme/");
    const shallow = note("u-shallow", "Meeting", "Inbox/");
    const notes = [deep, shallow];
    const body = "Notes from [[Meeting]] today.";

    const out = await resolveClipWikilinks(body, loaderOf(notes));

    // The shallower folder wins (1 segment < 3) — same pick `resolveWikilink`
    // makes; the expectation is derived from `convertedLink` so there is no
    // forked resolution logic in the test.
    expect(out).toBe(`Notes from ${expectedRewrite(body, shallow)} today.`);
    expect(out).toContain("[[Inbox/Meeting.md|Meeting]]");
    expect(out).not.toContain("Acme");
  });

  it("leaves an already path-form link alone even on a title collision (idempotent)", async () => {
    // Two "Spec" notes; the body's link is ALREADY path-form (`Beta/Spec.md`),
    // so the importer's R2 pass skips it entirely (only title-only links are
    // converted) — it is left byte-for-byte untouched. This is the clip-pass
    // analogue of the importer's idempotence: nothing canonical is re-rewritten.
    const a = note("u-a", "Spec", "Alpha/");
    const b = note("u-b", "Spec", "Beta/");
    const body = "ref [[Beta/Spec.md|Spec]] here";

    const out = await resolveClipWikilinks(body, loaderOf([a, b]));

    expect(out).toBe(body);
  });

  it("rewrites multiple links in one body, leaving broken ones as-authored", async () => {
    const notes = [note("u-1", "Alpha"), note("u-2", "Beta", "Sub/")];
    const body = "Links: [[Alpha]] and [[Beta]] and [[Gamma]] (missing).";

    const out = await resolveClipWikilinks(body, loaderOf(notes));

    expect(out).toContain("[[Alpha.md|Alpha]]");
    expect(out).toContain("[[Sub/Beta.md|Beta]]");
    // The broken one survives untouched.
    expect(out).toContain("[[Gamma]]");
    expect(out).not.toContain("Gamma.md");
  });

  it("leaves path-form links and embeds alone (idempotent — already canonical)", async () => {
    const notes = [note("u-1", "Alpha", "Sub/")];
    // A path-form link (already §3) + an embed — the R2 pass skips both.
    const body = "Already [[Sub/Alpha.md|Alpha]] and embed ![[image.png]].";

    const out = await resolveClipWikilinks(body, loaderOf(notes));

    expect(out).toBe(body);
  });

  it("returns the body unchanged when the note-set is empty (nothing resolves)", async () => {
    const body = "Lonely [[Anything]] link.";
    const out = await resolveClipWikilinks(body, loaderOf([]));
    expect(out).toBe(body);
  });

  it("takes the note-set via the injected loader port — desktop-side, no browser transport (#4)", async () => {
    // The pass NEVER reaches out to any browser/extension transport: its ONLY
    // source of the note graph is the injected loader port, which it awaits
    // exactly once. We assert the port is the sole input channel.
    const notes = [note("u-1", "Alpha")];
    const load = vi.fn<ResolverNoteSetLoader>(() => Promise.resolve([...notes]));
    const body = "A [[Alpha]] clip.";

    const out = await resolveClipWikilinks(body, load);

    // The note-set came in through the injected port — called exactly once, with
    // no arguments (the pass passes nothing OUT to it). The decrypted graph is
    // pulled in desktop-side; nothing is requested from / sent to the browser.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith();
    expect(out).toContain("[[Alpha.md|Alpha]]");
  });

  it("accepts a pre-loaded note-set array directly (no loader needed)", async () => {
    // The pass also accepts the already-decrypted note-set as a plain array, so
    // task 5's assembly can pass the set it already loaded without a closure.
    const notes = [note("u-1", "Alpha", "Folder/")];
    const out = await resolveClipWikilinks("Go [[Alpha]].", notes);
    expect(out).toContain("[[Folder/Alpha.md|Alpha]]");
  });
});
