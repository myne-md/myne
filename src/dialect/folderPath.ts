// Folder/title path-segment grammar + case-fold identity + .md-strip helpers.
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (segment grammar for the
// Myne-managed `folder:` field); docs/spec/wikilink.md §2.1/§3.4/§10 (target
// delimiters + forbidden `]]`); §3.7.8 tag case-fold+NFC identity (reused here).
// Grill: myne-agents/sessions/grill/2026-05-29-folder-hierarchy-sidebar.md Q5.
//
// A folder segment and a note title are the SAME structural object — both are
// segments of the derived wikilink target `<folder>/<title>.md`. One predicate
// (`isLegalSegment`) governs both, reused at folder-create / note-create /
// note-rename / import-scan. `isLegalSegment` is the strict Myne-authored gate;
// imported content is NOT hard-rejected here — provenance-split enforcement
// (markdown-dialect §10) flags + prompts instead.

const utf8Encoder = new TextEncoder();

/** NAME_MAX on ext4/APFS/NTFS — the per-segment byte cap. */
export const MAX_SEGMENT_BYTES = 255;
/** PATH_MAX on macOS — the total vault-relative path byte cap. */
export const MAX_PATH_BYTES = 1024;

// Visible forbidden chars inside a segment:
//   \ /    path delimiters (a `/` in a title would forge a folder boundary)
//   | # ^  wikilink alias / heading-anchor / block-ref delimiters (§2.1)
//   [ ]    wikilink brackets — bare; `]]` is the unescapable terminator (§10)
const FORBIDDEN_SEGMENT_CHAR_RE = /[\\\/|#^\[\]]/;

// C0 control chars (U+0000–U+001F, incl. tab/LF/CR) + DEL (U+007F). Checked via
// char-code scan rather than a regex range so the source carries no invisible
// control bytes.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** UTF-8 byte length of a string (not code-point count). */
export function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

/**
 * True when `s` is a legal Myne-authored path segment (folder segment or note
 * title). Rejects: empty, `.`/`..` traversal, leading/trailing whitespace,
 * trailing dot, any forbidden / control char, and segments over
 * MAX_SEGMENT_BYTES. Everything else — spaces, most punctuation, Unicode
 * letters, emoji — is allowed (Obsidian permissiveness).
 */
export function isLegalSegment(s: string): boolean {
  if (s.length === 0) return false; // empty segment (`//`)
  if (s === "." || s === "..") return false; // traversal (§3.4)
  if (s !== s.trim()) return false; // leading/trailing whitespace (§3.4)
  if (s.endsWith(".")) return false; // Windows trailing-dot strip footgun
  if (FORBIDDEN_SEGMENT_CHAR_RE.test(s)) return false;
  if (hasControlChar(s)) return false;
  if (utf8ByteLength(s) > MAX_SEGMENT_BYTES) return false;
  return true;
}

/**
 * Case-insensitive folder identity key: NFC then Unicode lowercase (reuses the
 * §3.7.8 tag-identity rule). JS has no full `caseFold()`; `toLowerCase()` after
 * NFC is the standard practical approximation. The input is never mutated —
 * callers keep the raw bytes for display / walk-away and use this only as a
 * comparison key (`Projects/` ≡ `projects/`).
 */
export function foldSegment(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

const MD_EXT = ".md";

/** Derive the wikilink-target filename for a title: append exactly one `.md`. */
export function titleToFilename(title: string): string {
  return title + MD_EXT;
}

/** Recover a title from a filename: strip exactly one trailing `.md` if present. */
export function filenameToTitle(filename: string): string {
  return filename.endsWith(MD_EXT)
    ? filename.slice(0, -MD_EXT.length)
    : filename;
}

/** True when a derived vault-relative path (folder + title + .md) fits PATH_MAX. */
export function isLegalPathLength(path: string): boolean {
  return utf8ByteLength(path) <= MAX_PATH_BYTES;
}

/**
 * Normalize a raw `folder:` value to the canonical trailing-slash display form,
 * or `null` for root / unfiled. **Structural normalization only** — collapses
 * duplicate and leading slashes and appends a trailing slash; treats empty and
 * `"/"` as root. Does NOT validate segments (imported content is preserved and
 * flagged elsewhere per the provenance-split rule, markdown-dialect §10) and
 * does NOT fold case (raw display bytes are kept; identity folding is
 * `foldSegment`'s job). Grill Q5: root = absent; trailing-slash canonical.
 */
export function normalizeFolderPath(raw: string | null): string | null {
  if (raw === null) return null;
  const segments = raw.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return segments.join("/") + "/";
}

/** Why a typed folder-name input was rejected (or `"empty"` = nothing typed,
 *  which callers treat as a cancel rather than an error). */
export type FolderInputRejection = "empty" | "illegal-segment" | "too-long";

/**
 * Validate a raw Myne-authored folder-name input — the text typed in the
 * new-folder / rename field, which may itself carry `/`-delimited segments
 * (`a/b` creates `a/` then `b/`). Each **typed** segment must pass
 * {@link isLegalSegment}; the resulting normalized `fullPath` must fit
 * `PATH_MAX` ({@link isLegalPathLength}). Returns `null` when legal.
 *
 * Only the typed segments are grammar-checked — a pre-existing (e.g. imported)
 * illegal *parent* segment must not block creating a legal child under it, so
 * the parent prefix is excluded from the per-segment check (it still counts
 * toward the `fullPath` length cap, which is a real filesystem constraint).
 *
 * This is the production gate behind `markdown-dialect.md` §3.6.2's "Myne-
 * authored input is rejected at the UI" rule for folder create / rename.
 */
export function validateFolderNameInput(
  typed: string,
  fullPath: string,
): FolderInputRejection | null {
  const segments = typed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "empty";
  for (const seg of segments) {
    if (!isLegalSegment(seg)) return "illegal-segment";
  }
  if (!isLegalPathLength(fullPath)) return "too-long";
  return null;
}

/**
 * Case-fold + NFC identity key for a folder path (root / `null` → `""`). The
 * canonical folder-identity shared by the daily-note resolver, folder-tree
 * derivation, and the Obsidian importer (SYNC-5) so `Projects/` ≡ `projects/`.
 */
export function folderKey(folder: string | null): string {
  const norm = normalizeFolderPath(folder);
  return norm === null ? "" : foldSegment(norm);
}

/**
 * Every ancestor folder of a canonical trailing-slash path, inclusive:
 * `"A/B/C/"` → `["A/", "A/B/", "A/B/C/"]`. Root / empty → `[]`.
 */
export function ancestorPaths(canonical: string): string[] {
  const segments = canonical.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  let acc = "";
  for (const s of segments) {
    acc += s + "/";
    out.push(acc);
  }
  return out;
}
