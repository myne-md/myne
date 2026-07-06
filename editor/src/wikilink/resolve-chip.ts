// Resolution glue between a parsed wikilink chip and the §5.3 resolver — the
// single place the chip (broken-link styling, §5.3) and the hover tooltip
// (R1, §6.2) turn a `WikilinkParts` into resolution state over the WL-5
// note-set. Pure + unit-tested; no CodeMirror imports so it tests without a view.

import {
  notePath,
  parseTarget,
  resolutionHint,
  resolveWikilink,
  type ResolverNote,
  type WikilinkResolution,
} from "@myne/editor/host/notes/resolveWikilink";
import { classifyTarget } from "@myne/dialect/visitors/wikilinks";
import { foldSegment, folderKey, isFolderTarget } from "@myne/dialect/folderPath";
import { isMediaTarget } from "@myne/editor/host/notes/vaultIndices";
import type { WikilinkRef } from "@myne/dialect/types";
import type { WikilinkParts } from "./chip-widget";

function chipRef(parts: WikilinkParts): WikilinkRef {
  const target = parts.target ?? "";
  return {
    raw: "",
    byteRange: { start: 0, end: 0 },
    embed: parts.isEmbed,
    target,
    targetKind: classifyTarget(target),
    alias: parts.alias,
    heading: parts.heading,
    // MYND-305: carry the parsed `^block-id` anchor instead of hard-coding null,
    // so resolve-on-click can scroll to an imported marker (§5.6). The block-id
    // does not affect NOTE resolution (it's an in-note scroll target), but a
    // `WikilinkRef` faithful to the parsed parts keeps this glue honest.
    blockId: parts.blockId,
  };
}

/**
 * Whether a parsed chip resolves to a note (drives broken-styling, hover R1, and
 * click-through). Excludes empty `[[]]` and MEDIA embeds (`![[image.png]]` —
 * deferred to the attachment pipeline, not notes). NOTE embeds (`![[Note]]`) DO
 * resolve — chip-only transclusion + click-through, MYND-44.
 */
function isResolvableChip(parts: WikilinkParts): boolean {
  const target = parts.target ?? "";
  if (target === "") return false;
  if (parts.isEmbed && isMediaTarget(target)) return false;
  return true;
}

/**
 * The folded title key a chip resolves on, or `null` when the chip is not a
 * broken-styling / hover candidate (empty target, media embed). Path-form links
 * key on their filename-title, the same as the resolver (§5.3).
 */
export function chipTitleKey(parts: WikilinkParts): string | null {
  if (!isResolvableChip(parts)) return null;
  return foldSegment(parseTarget(chipRef(parts)).title);
}

/** The set of title keys present in the note-set — built ONCE per chip-decoration
 *  build so each chip's broken check is an O(1) lookup instead of an O(notes)
 *  resolver scan. */
export function presentTitleKeys(notes: readonly ResolverNote[]): Set<string> {
  const keys = new Set<string>();
  for (const n of notes) {
    if (n.title !== null) keys.add(foldSegment(n.title));
  }
  return keys;
}

/** §5.3 broken decision from a precomputed key + the present-key set. */
export function isBrokenKey(key: string | null, present: ReadonlySet<string>): boolean {
  return key !== null && !present.has(key);
}

/** The folded folder key a folder-target chip (`[[Projects/]]`, MYND-370)
 *  resolves on — the trailing-slash form's normalized folder path — or `null`
 *  when the chip is not a folder target (so the caller falls back to the
 *  title-key path). Shares the resolver's `isFolderTarget` discriminator. */
export function chipFolderTargetKey(parts: WikilinkParts): string | null {
  const target = parts.target ?? "";
  if (!isFolderTarget(target) || !isResolvableChip(parts)) return null;
  return folderKey(target);
}

/** Both key-sets the chip-decoration build needs, folded from the note-set in a
 *  SINGLE pass (MYND-370): `titles` for ordinary chips, `folderIndex` (folders
 *  that HAVE an index note) for folder-target chips. Built ONCE per build so each
 *  chip's broken check stays an O(1) set lookup. */
export function chipKeySets(notes: readonly ResolverNote[]): {
  titles: Set<string>;
  folderIndex: Set<string>;
} {
  const titles = new Set<string>();
  const folderIndex = new Set<string>();
  for (const n of notes) {
    if (n.title !== null) titles.add(foldSegment(n.title));
    if (n.folderIndex === true && n.folder !== null) {
      folderIndex.add(folderKey(n.folder));
    }
  }
  return { titles, folderIndex };
}

/**
 * §5.3 broken-styling decision for a chip, folder-target-aware (MYND-370). A
 * folder-target chip (`[[Projects/]]`) is broken iff its folder has no index
 * note; any other chip uses the title-key path. The two present-sets are
 * precomputed once per decoration build by the caller.
 */
export function isChipBroken(
  parts: WikilinkParts,
  presentTitle: ReadonlySet<string>,
  presentFolderIndex: ReadonlySet<string>,
): boolean {
  const folderKey = chipFolderTargetKey(parts);
  if (folderKey !== null) return !presentFolderIndex.has(folderKey);
  return isBrokenKey(chipTitleKey(parts), presentTitle);
}

/** §5.3: a non-embed wikilink whose target matches no note is broken. Convenience
 *  single-shot (O(notes)); the chip build uses `presentTitleKeys` + `isBrokenKey`. */
export function isWikilinkBroken(
  parts: WikilinkParts,
  notes: readonly ResolverNote[],
): boolean {
  return isBrokenKey(chipTitleKey(parts), presentTitleKeys(notes));
}

/**
 * Resolve a parsed chip's link against the note-set. Returns `null` for empty
 * `[[]]` and media embeds (`![[image.png]]` — not a note). NOTE embeds
 * (`![[Note]]`) resolve like a regular link (MYND-44).
 */
export function resolveChipParts(
  parts: WikilinkParts,
  notes: readonly ResolverNote[],
): WikilinkResolution | null {
  if (!isResolvableChip(parts)) return null;
  return resolveWikilink(chipRef(parts), notes);
}

/**
 * §6.2 hover text. `display` is the chip's label (alias/title, from
 * `chipDisplayText`). Returns `null` when there's no tooltip (embeds / empty).
 * - broken → `(no match)`
 * - resolved → `Display → vault/relative/path.md`
 * - ambiguous → `Display → <first match path> (N matches)`
 */
export function chipHoverText(
  display: string,
  parts: WikilinkParts,
  notes: readonly ResolverNote[],
): string | null {
  const res = resolveChipParts(parts, notes);
  if (res === null) return null;
  const hint = resolutionHint(res);
  if (res.status === "broken") return hint.text; // "(no match)"
  const picked = res.candidates.find((n) => n.noteUuid === res.noteUuid) ?? null;
  const base = `${display} → ${picked ? notePath(picked) : ""}`;
  return res.ambiguous ? `${base} ${hint.text}` : base;
}
