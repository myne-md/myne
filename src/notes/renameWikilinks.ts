// Form-preserving inbound-wikilink rewrite planner for note rename (§8). When a
// note's title changes, every inbound `[[…]]` that references it is rewritten —
// preserving its syntactic form (§8.2): title-only stays title-only, path-form
// stays path-form, alias / `#heading` / `^block` / `!`-embed preserved, NEVER
// promoted (only R2 promotes). Pure over (body, {oldTitle,newTitle}) — no disk,
// no CodeMirror; the transactional multi-note APPLY is the gated WL-7 storage
// primitive (Ömer / MYND-89), not this module.

import { extractWikilinks } from "../dialect/visitors/wikilinks";
import {
  foldSegment,
  isFolderTarget,
  normalizeFolderPath,
  titleToFilename,
} from "../dialect/folderPath";
import { parseTarget } from "./resolveWikilink";
import type { ByteRange, WikilinkRef } from "../dialect/types";

export interface RenameTarget {
  readonly oldTitle: string;
  readonly newTitle: string;
}

export interface FolderRenameTarget {
  /** The folder being renamed, canonical trailing-slash form, e.g. "Projects/". */
  readonly oldFolder: string;
  /** Its new canonical trailing-slash form, e.g. "Work/". */
  readonly newFolder: string;
}

export interface InboundRewrite {
  readonly byteRange: ByteRange;
  readonly before: string;
  readonly after: string;
}

/** The ref's new target after rename, preserving its form: title-only swaps the
 *  title; path-form keeps its folder prefix (from the SAME `parseTarget` the
 *  resolver uses) and only the filename changes. */
function newTarget(ref: WikilinkRef, newTitle: string): string {
  if (ref.targetKind === "title") return newTitle;
  const { folder } = parseTarget(ref);
  return `${folder ?? ""}${titleToFilename(newTitle)}`;
}

/** Reconstruct the wikilink source from its parts + a new target + the
 *  (possibly-updated) alias, preserving embed prefix and heading/block anchors
 *  (§8.2). */
function rebuild(ref: WikilinkRef, target: string, alias: string | null): string {
  const anchor =
    (ref.heading !== null ? `#${ref.heading}` : "") +
    (ref.blockId !== null ? `^${ref.blockId}` : "");
  const aliasPart = alias !== null ? `|${alias}` : "";
  return `${ref.embed ? "!" : ""}[[${target}${anchor}${aliasPart}]]`;
}

/**
 * Plan the rewrite of every inbound link in `body` that references the renamed
 * note (its title component folds-equal to `oldTitle`). Form-preserving; a ref
 * whose rebuilt form equals its original is skipped (no-op).
 */
export function planInboundRewrites(
  body: string,
  { oldTitle, newTitle }: RenameTarget,
): InboundRewrite[] {
  const key = foldSegment(oldTitle);
  const out: InboundRewrite[] = [];
  for (const ref of extractWikilinks(body)) {
    // Match the renamed note by title component — the part the resolver keys on
    // (§5.3), via the same `parseTarget` (title-only → target; path-form →
    // filename-title).
    if (foldSegment(parseTarget(ref).title) !== key) continue;
    // §8.2 alias handling: a genuinely-custom alias is preserved, BUT an
    // alias that MIRRORS the renamed title is an auto-emitted display (Myne's
    // picker bakes `[[<path>.md|<Title>]]`, WL-4 / `emitNoteWikilink`), not a
    // deliberate label — so it tracks the new title. Without this, every
    // Myne-authored inbound chip would freeze at the old name on rename even
    // though its target/path updated (the chip renders the alias, not the live
    // title). Fold-insensitive match, same key the link itself matched on.
    const newAlias =
      ref.alias !== null && foldSegment(ref.alias) === key ? newTitle : ref.alias;
    const after = rebuild(ref, newTarget(ref, newTitle), newAlias);
    if (after === ref.raw) continue;
    out.push({ byteRange: ref.byteRange, before: ref.raw, after });
  }
  return out;
}

/**
 * Plan the rewrite of every inbound **folder-target** link (`[[Projects/]]`) in
 * `body` affected by renaming `oldFolder` → `newFolder` (MYND-370). A link whose
 * target folder is the renamed folder OR a descendant of it is re-rooted under
 * the new prefix, preserving the descendant suffix and the link's form (alias /
 * embed). Folded-prefix match with trailing slash — exactly the subtree selection
 * `planFolderRename` uses for the notes themselves — so the link set and the
 * note moves stay in lockstep. Title-keyed (`[[Note]]`) and path-form note links
 * (`[[Projects/Note]]`) are untouched: a folder rename does not change any note's
 * resolution key, so those resolve unchanged (§5.3 / §8.1).
 */
export function planInboundFolderRewrites(
  body: string,
  { oldFolder, newFolder }: FolderRenameTarget,
): InboundRewrite[] {
  const oldNorm = normalizeFolderPath(oldFolder);
  const newNorm = normalizeFolderPath(newFolder);
  if (oldNorm === null || newNorm === null || oldNorm === newNorm) return [];
  const oldKey = foldSegment(oldNorm);

  const out: InboundRewrite[] = [];
  for (const ref of extractWikilinks(body)) {
    if (!isFolderTarget(ref.target)) continue;
    const targetNorm = normalizeFolderPath(ref.target);
    if (targetNorm === null) continue;
    // Subtree match: the link's folder is the renamed folder or below it.
    if (!foldSegment(targetNorm).startsWith(oldKey)) continue;
    const newPath = newNorm + targetNorm.slice(oldNorm.length);
    const after = rebuild(ref, newPath, ref.alias);
    if (after === ref.raw) continue;
    out.push({ byteRange: ref.byteRange, before: ref.raw, after });
  }
  return out;
}
