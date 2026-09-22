// Extract a note's vault-indices contribution TS-side (the sweep that feeds the
// backend `vault_indices_apply`). Wikilink edges come from the SHARED extractor
// (`@myne/editor/host/notes/graphModel`) over the shared dialect parse tree, so
// this client and desktop agree on what a link is and what it points at
// (myne-md/myne#199). Tags + the note's own folded title-key stay folded with
// `foldSegment` (Turkish-correct) — the same model the backend index resolves
// against.

import { foldSegment } from "../dialect/folderPath";
import { parse } from "../dialect/parse";
import { extractLineTasks } from "../dialect/visitors/lineTasks";
import { extractProperties } from "@myne/editor/host/notes/propertyTyping";
import { extractWikilinkEdges } from "@myne/editor/host/notes/graphModel";
import { extractBlockAnchorEntries } from "@myne/editor/host/notes/blockAnchors";
import { parseTags } from "./tags";
import type { WikilinkEdge, TagEntry, IndexRecord } from "./vault-indices";

/**
 * Outbound wikilink edges for a note body.
 *
 * The former mobile-local regex is gone. It scanned the RAW body, so a
 * `[[Link]]` inside a fenced code block or in frontmatter became a real edge,
 * and it folded its title-key from the WHOLE target, so `[[Folder/Note]]` and
 * `[[Note.md]]` matched nothing. The shared extractor walks the parse tree
 * (exclusion zones are structural) and folds only the title component, which is
 * what lets the shared resolver disambiguate a collision by folder.
 */
export function extractWikilinks(body: string): WikilinkEdge[] {
  return extractWikilinkEdges(parse(body).wikilinks);
}

/** Folded tags (deduped by folded key). */
export function extractTagEntries(body: string): TagEntry[] {
  const seen = new Set<string>();
  const out: TagEntry[] = [];
  for (const t of parseTags(body)) {
    const folded = foldSegment(t);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push({ folded, display: t });
  }
  return out;
}

/** Full apply payload for one note. `title` is the display title (fm or first
 *  line); `body` is the raw note plaintext (frontmatter + body). */
export function extractRecord(noteId: string, title: string, folder: string | null, body: string): IndexRecord {
  // ONE parse per note, feeding both the wikilink edges and the frontmatter
  // block `extractProperties` re-parses. This file used to walk the body twice
  // over (a `locateFrontmatter` parse plus the regex scan), so routing the
  // wikilinks through the shared tree-based extractor costs nothing here.
  const parsed = parse(body);
  return {
    noteId,
    title: title || null,
    folder,
    titleKey: title ? foldSegment(title) : null,
    wikilinks: extractWikilinkEdges(parsed.wikilinks),
    tags: extractTagEntries(body),
    // §3.6.4 typed frontmatter properties — the same coercion desktop's
    // `reindexNoteFromBody` feeds the index, so a saved view's groupBy / sort /
    // columns / property-filter resolve identically on both clients.
    properties: extractProperties(parsed.frontmatter.raw),
    // MYND-612: line-tasks, from the SHARED dialect extractor — like the
    // wikilink edges above. A second recognizer would drift from the first: the
    // field grammar reads three dialects and the parse tree is what keeps code
    // blocks, wikilink interiors and frontmatter structurally out. It owns its
    // own exclusions, so nothing here filters what it returns.
    tasks: extractLineTasks(body),
    // MYND-382: imported `^block-id` anchors for the vault-wide `[[^^` picker,
    // from the SHARED extractor over the one dialect scanner. Mobile had no
    // extractor of its own and no second one was written here: the desktop
    // function moved into `@myne/editor/host/notes/blockAnchors` instead
    // (myne-md/myne#452), because a copy would sit at a different relative path
    // from its twin and so be invisible to every twin guard in the tree.
    blockAnchors: extractBlockAnchorEntries(body),
    // myne#216: headings for the vault-wide `[[##` picker. Unlike the two
    // extractors above this adds NO parse - `parse()` already enumerated them,
    // with the frontmatter guard applied, so this is a map over a result that is
    // already in hand. Identical to desktop's `reindexNoteFromBody`.
    headings: parsed.headings.map((h) => ({ text: h.text, level: h.level })),
  };
}
