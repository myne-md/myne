// Notion export naming (importer-breadth epic, MYND-583).
//
// Notion names every exported file and folder `<Title> <32-hex>.md`, and its
// internal links reference those exact on-disk names. Two jobs follow, and they pull
// in opposite directions:
//
//   1. TITLES must lose the suffix — nobody wants 32 characters of hex in a note
//      title.
//   2. LINKS must still resolve — which needs the ORIGINAL names, because Notion
//      permits duplicate page titles freely, so de-suffixed titles are not unique.
//
// Hence a resolution map rather than a one-way transform: strip for display, retain
// the original for matching. (Grill 2026-07-25 O2.)

/** The 32-hex id Notion appends, preceded by a space, before any extension. */
const SUFFIX = /[ _]([0-9a-f]{32})(?=\.[^.]+$|$)/i;

/** Drop Notion's trailing 32-hex id from one path SEGMENT (file or folder name). */
export function stripNotionId(segment: string): string {
  return segment.replace(SUFFIX, "");
}

/** Does this segment carry a Notion id? Used to tell an export from a plain folder. */
export function hasNotionId(segment: string): boolean {
  return SUFFIX.test(segment);
}

/** Strip the id from every segment of a relative path. */
export function stripNotionPath(rel: string): string {
  return rel
    .split("/")
    .map((seg) => stripNotionId(seg))
    .join("/");
}

/**
 * Percent-decode a Notion link target. Notion URL-encodes spaces and non-ASCII in
 * `[text](Page%20Title%20<hex>.md)`; matching against on-disk names needs the
 * decoded form. Malformed escapes are left as-is rather than throwing.
 */
export function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * Map from an on-disk relative path (as a link would spell it) to the note title the
 * importer will file it under. Both the full path and the bare basename are keyed:
 * Notion links are usually relative to the linking page's own directory, so a
 * basename lookup is the fallback that makes sibling links resolve.
 */
export interface NotionResolution {
  byPath: Map<string, string>;
  byBasename: Map<string, string>;
}

export function buildResolution(relPaths: readonly string[]): NotionResolution {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string>();
  for (const rel of relPaths) {
    const title = stripNotionId(rel.split("/").pop() ?? rel).replace(/\.[^.]+$/, "");
    byPath.set(rel, title);
    const base = rel.split("/").pop() ?? rel;
    // First wins: a duplicated basename is ambiguous, and silently overwriting would
    // point every duplicate at the last one seen.
    if (!byBasename.has(base)) byBasename.set(base, title);
  }
  return { byPath, byBasename };
}

/** Resolve one link target to a note title, or `null` when nothing matches. */
export function resolveTarget(
  resolution: NotionResolution,
  linkingDir: string,
  rawTarget: string,
): string | null {
  const target = decodeTarget(rawTarget);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;

  const joined = linkingDir.length > 0 ? `${linkingDir}/${target}` : target;
  const normalized = joined.replace(/^\.\//, "");
  return (
    resolution.byPath.get(normalized) ??
    resolution.byPath.get(target) ??
    resolution.byBasename.get(target.split("/").pop() ?? target) ??
    null
  );
}
