// desktop-ingest task 4 — outbound wikilink resolution against the decrypted
// index (MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The PURE pass that resolves a clip body's outbound title-only `[[wikilink]]`s
// against the DECRYPTED resolver note-set by REUSING the importer's R2 conversion
// machinery — `planWikilinkConversion` / `resolveWikilink` / `convertedLink`.
// A clip body the browser emitted carries only plain title-only links; resolving
// them against the existing notes rewrites each one that matches an existing note
// into the canonical §3 path-form, so the clip joins the backlink graph the
// instant it lands. Broken / ambiguous links are left exactly as the importer's
// R2 pass leaves them: a no-match is left AS-AUTHORED (no fabricated target); an
// ambiguous match resolves via the existing shortest-path heuristic. There is NO
// new resolution logic here — `planWikilinkConversion` already encodes the whole
// rewrite/skip/ambiguous decision; this module only feeds it the body + the
// resolver note-set and applies its plan.
//
// REUSE, NOT FORK. `planWikilinkConversion(body, notes)` returns one
// `ConversionRow` per title-only ref in document order: a `rewrite` row carries
// the canonical `after` (built by `convertedLink`); a `skipped` row is a broken
// link (left as-authored — emit no edit); an `ambiguous` row is an ambiguous
// match (`resolveWikilink` flagged it). Unlike the interactive R2 command
// (`convert-command.ts`), this UNATTENDED ingest pass has no picker UI to choose
// an ambiguous target — so it applies the resolver's OWN shortest-path pick
// (`convertedLink` over the row's first candidate, the same deterministic head of
// `resolveWikilink`'s sorted candidate list), never inventing a new heuristic.
//
// SYNC-11 — DESKTOP-SIDE ONLY. The decrypted note graph never enters the hostile
// browser runtime. Satisfied by construction: this is desktop WebView TS, the
// browser only ever emitted plain markdown. The pass takes the resolver note-set
// as INPUT (a plain array) or via an injected LOADER PORT — it never reaches out
// to any browser / extension transport for the graph. The real loader (bound in
// task 5's assembly routine) loads the set the same way the importer's
// `loadExistingIdentity` does: note list → batch decrypt → project to
// `ResolverNote`. That wiring is injected here so this module stays unit-testable
// with a fixture note-set (no Tauri, no IPC).
//
// PURE (no React, no IPC, no I/O of its own — the only async is awaiting the
// injected loader port). `(body, notesOrLoader) -> Promise<string>`.

import { planWikilinkConversion, convertedLink } from "../editor/wikilink/convert";
import { applyTextRewrites } from "../notes/import/media";
import { resolveWikilink, type ResolverNote } from "../notes/resolveWikilink";

/**
 * Loads the DECRYPTED resolver note-set desktop-side. Injected (the real impl,
 * bound in task 5, mirrors the importer's `loadExistingIdentity`: `noteList()` →
 * `loadNoteBatch` → project each `TitleRecord` to a {@link ResolverNote} via
 * `resolverNotesFromCache`-style mapping; tests inject a fixture). Takes NO
 * arguments — the pass never passes anything OUT to it; the note graph flows in
 * only, never to the browser (SYNC-11).
 */
export type ResolverNoteSetLoader = () => Promise<readonly ResolverNote[]>;

/**
 * Resolve a clip body's outbound title-only `[[wikilink]]`s against the decrypted
 * resolver note-set, rewriting each match to the canonical §3 path-form and
 * leaving broken / ambiguous links exactly as the importer's R2 pass leaves them.
 *
 * The note-set is supplied either as a plain pre-loaded array (task 5 may already
 * have the decrypted set in hand) or as an injected {@link ResolverNoteSetLoader}
 * (the real load is bound in task 5). Either way the decrypted note graph is read
 * DESKTOP-SIDE — nothing about it is requested from or sent to the browser
 * (SYNC-11), satisfied by construction since the browser only emitted plain
 * markdown and this is all desktop WebView TS.
 *
 * Reuses `planWikilinkConversion` (which itself calls `resolveWikilink` +
 * `convertedLink`) — there is NO new resolution logic here:
 *   - `rewrite` row  → apply its canonical `after` (path-form);
 *   - `skipped` row  → broken link, left AS-AUTHORED (no edit, no fabrication);
 *   - `ambiguous` row → re-`resolveWikilink` the row's ref to recover the
 *     resolver's OWN shortest-path winner (`res.noteUuid`) and emit it via
 *     `convertedLink`. (`planWikilinkConversion` defers ambiguity to the
 *     interactive picker by carrying candidates in filter order, not sorted
 *     order; this unattended pass has no picker, so it reuses
 *     `resolveWikilink`'s deterministic shortest-path pick — the SAME heuristic,
 *     no new logic.)
 *
 * @param body the canonicalized clip markdown carrying outbound `[[wikilink]]`s
 * @param notesOrLoader the decrypted resolver note-set, as a plain array or an
 *   injected loader port
 * @returns the body with each resolvable title-only link rewritten to path-form
 */
export async function resolveClipWikilinks(
  body: string,
  notesOrLoader: readonly ResolverNote[] | ResolverNoteSetLoader,
): Promise<string> {
  // FAST PATH (perf, MYND-445): a clip body with NO `[[` has no title-only
  // wikilink to resolve, so there is nothing to do — and crucially, we must NOT
  // call the loader, which decrypts the ENTIRE vault to build the resolver set.
  // Web clips virtually never contain `[[…]]` (that is Myne-internal syntax), so
  // without this guard every clip pays a whole-vault decrypt that can blow the
  // 30 s relay dispatch timeout on a large vault — the note still seals, but the
  // extension sees a spurious "couldn't clip". Skip the load entirely here.
  // Strip form-C attachment embeds (`![[att:…]]`) before the probe: ingestClipImages
  // runs BEFORE this step, so a clip with any imported image already carries `![[`,
  // whose `[[` would otherwise defeat the guard and force a whole-vault decrypt on
  // every image-bearing clip. What remains after removing `![[` is a real title
  // wikilink; only then is the loader worth calling.
  const withoutEmbeds = body.replace(/!\[\[/g, "");
  if (!withoutEmbeds.includes("[[")) {
    return body;
  }

  const notes =
    typeof notesOrLoader === "function" ? await notesOrLoader() : notesOrLoader;

  // The importer's R2 plan: one row per title-only ref, in document order. This
  // is the SINGLE place the resolve/rewrite/skip decision is made — we only feed
  // it the decrypted note-set and translate its rows into edits.
  const rows = planWikilinkConversion(body, notes);

  // `applyTextRewrites` uses `{ from, to, replacement }` (descending-`from` apply,
  // offsets stay valid). Map the conversion rows' `byteRange.{start,end}` onto it.
  const edits: { from: number; to: number; replacement: string }[] = [];
  for (const row of rows) {
    if (row.kind === "rewrite") {
      // Resolved single match → its canonical path-form `after`.
      edits.push({
        from: row.byteRange.start,
        to: row.byteRange.end,
        replacement: row.after,
      });
    } else if (row.kind === "ambiguous") {
      // No picker in this unattended pass: reuse `resolveWikilink`'s OWN
      // shortest-path winner. The plan row carries candidates in filter order
      // (for the interactive picker), NOT sorted order, so re-resolve the ref to
      // get the deterministic pick (`res.noteUuid` — fewest folder segments,
      // lexicographic tiebreak) and emit it via the same `convertedLink` the
      // picker uses, so the bytes match a manual R2 convert. No new heuristic.
      const res = resolveWikilink(row.ref, notes);
      const pick =
        res.status === "resolved"
          ? res.candidates.find((n) => n.noteUuid === res.noteUuid)
          : undefined;
      if (pick !== undefined) {
        edits.push({
          from: row.byteRange.start,
          to: row.byteRange.end,
          replacement: convertedLink(pick, row.ref),
        });
      }
    }
    // `skipped` (broken) → no edit: the link is left AS-AUTHORED, never fabricated.
  }

  return applyTextRewrites(body, edits);
}
