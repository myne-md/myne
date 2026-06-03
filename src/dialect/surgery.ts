// Spec: docs/spec/markdown-dialect.md §3.6.1 (Myne-managed canonical
// frontmatter fields); decisions.md 2026-05-09 (TS-owned surgery).

import {
  FRONTMATTER_DELIMITER,
  FRONTMATTER_OPENER,
  NEWLINE,
  locateFrontmatter,
} from "./lezer/frontmatter";
import type { ByteRange } from "./types";

const UPDATED_KEY_RE = /^([ \t]*updated[ \t]*:[ \t]*)(.*)$/;
const TITLE_KEY_RE = /^([ \t]*title[ \t]*:[ \t]*)(.*)$/;
const FOLDER_KEY_RE = /^([ \t]*folder[ \t]*:[ \t]*)(.*)$/;
const TRASHED_KEY_RE = /^([ \t]*trashed[ \t]*:[ \t]*)(.*)$/;

const utf8Decoder = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

// YAML plain-scalar safety check for `title:` values.
//
// `updated:` values are RFC 3339 ISO 8601 strings — always plain-scalar
// safe — so `patchUpdatedField` never needs this. `title:` values are
// user-authored and may contain colons, hashes, leading dashes, etc.
// This predicate is intentionally conservative: when in doubt, escalate
// to double-quoted output, which is always safe.
function needsYamlQuoting(value: string): boolean {
  if (value.length === 0) return true;
  // Leading-whitespace, leading-control, or YAML-reserved start chars.
  if (/^[\s\-?:[\]{}#&*!|>'"%@`]/.test(value)) return true;
  // Trailing whitespace would round-trip-mangle.
  if (/\s$/.test(value)) return true;
  // YAML in-line specials: `: ` opens a mapping; ` #` opens a comment.
  if (/: |\s#|\n|\r/.test(value)) return true;
  return false;
}

// Format a string for emission as a YAML value after `<key>: `.
// Plain-scalar when safe; double-quoted with `\` and `"` escapes when not.
export function formatYamlScalar(value: string): string {
  if (!needsYamlQuoting(value)) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function applyStateA(source: string, iso: string): string {
  return (
    FRONTMATTER_OPENER +
    "updated: " + iso + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateB(source: string, bodyEnd: number, iso: string): string {
  const insert = "updated: " + iso + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

// State C strategy ξ: replace the existing `updated:` value byte-by-byte.
// Block-scalar collapse to single line is justified because `updated:` is
// Myne-managed per §3.6.1 — it does not violate §6 C1 byte-stability for
// other keys (those are preserved untouched).
function applyStateC(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  iso: string,
): string | null {
  const fmBody = source.substring(bodyStart, bodyEnd);
  const lines = fmBody.split(NEWLINE);

  for (let i = 0; i < lines.length; i++) {
    const m = UPDATED_KEY_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const prefix = m[1] ?? "";
    const valuePortion = m[2] ?? "";
    const trimmedValue = valuePortion.trim();

    if (/^[|>]/.test(trimmedValue)) {
      lines[i] = prefix + iso;
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j] ?? "")) j++;
      lines.splice(i + 1, j - (i + 1));
      return lines.join(NEWLINE);
    }

    const quotedM = /^(["'])(.*?)\1([ \t]*(?:#.*)?)$/.exec(valuePortion);
    if (quotedM !== null) {
      const quote = quotedM[1] ?? '"';
      const trailing = quotedM[3] ?? "";
      lines[i] = prefix + quote + iso + quote + trailing;
      return lines.join(NEWLINE);
    }

    const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
    if (commentM !== null) {
      lines[i] = prefix + iso + (commentM[2] ?? "");
      return lines.join(NEWLINE);
    }

    lines[i] = prefix + iso;
    return lines.join(NEWLINE);
  }

  return null;
}

/**
 * Replace each `ranges[i]` byte range with the corresponding
 * `replacements[i]` string. Ranges are validated (in-bounds,
 * non-overlapping after sort) and applied in source order.
 */
export function patchSourceRanges(
  bytes: Uint8Array,
  ranges: ByteRange[],
  replacements: string[],
): Uint8Array {
  if (ranges.length !== replacements.length) {
    throw new Error(
      `patchSourceRanges: ranges.length (${ranges.length}) does not match replacements.length (${replacements.length})`,
    );
  }
  if (ranges.length === 0) return bytes;

  const source = utf8Decoder.decode(bytes);
  const sortedIndices = ranges
    .map((_, i) => i)
    .sort((a, b) => (ranges[a]?.start ?? 0) - (ranges[b]?.start ?? 0));

  let prevEnd = 0;
  for (const idx of sortedIndices) {
    const r = ranges[idx];
    if (r === undefined) continue;
    if (r.start < 0 || r.end > source.length || r.start > r.end) {
      throw new Error(
        `patchSourceRanges: range [${r.start}, ${r.end}) out of bounds for source length ${source.length}`,
      );
    }
    if (r.start < prevEnd) {
      throw new Error(
        `patchSourceRanges: range [${r.start}, ${r.end}) overlaps with previous range ending at ${prevEnd}`,
      );
    }
    prevEnd = r.end;
  }

  let result = "";
  let cursor = 0;
  for (const idx of sortedIndices) {
    const r = ranges[idx];
    if (r === undefined) continue;
    if (cursor < r.start) result += source.substring(cursor, r.start);
    result += replacements[idx] ?? "";
    cursor = r.end;
  }
  if (cursor < source.length) result += source.substring(cursor);

  return utf8Encoder.encode(result);
}

export function patchUpdatedField(bytes: Uint8Array, iso: string): Uint8Array {
  const source = utf8Decoder.decode(bytes);
  const fm = locateFrontmatter(source);

  if (fm === null) {
    return utf8Encoder.encode(applyStateA(source, iso));
  }

  const stateCResult = applyStateC(source, fm.bodyStart, fm.bodyEnd, iso);
  if (stateCResult !== null) {
    const before = source.substring(0, fm.bodyStart);
    const after = source.substring(fm.bodyEnd);
    return utf8Encoder.encode(before + stateCResult + after);
  }

  return utf8Encoder.encode(applyStateB(source, fm.bodyEnd, iso));
}

// === patchTitleField — Q7 (β mirror-existing) write target for FM `title:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (Myne-managed canonical
// frontmatter fields — `title:` joins `updated:`); decisions.md 2026-05-15
// "Note title write target".
//
// Same 3-state matrix as `patchUpdatedField`. Differences:
// - Value may contain YAML-unsafe characters → `formatYamlScalar` escalates
//   to double-quoted when needed; plain when safe.
// - State C preserves existing quote style (unquoted / single / double),
//   escalating from unquoted to double-quoted if the new value forces it.
// - Block-scalar form collapses to plain (or quoted) per the canonical
//   single-line shape — justified by `title:` being Myne-managed.

function applyStateATitle(source: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    "title: " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBTitle(
  source: string,
  bodyEnd: number,
  value: string,
): string {
  const insert = "title: " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCTitle(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  const fmBody = source.substring(bodyStart, bodyEnd);
  const lines = fmBody.split(NEWLINE);

  for (let i = 0; i < lines.length; i++) {
    const m = TITLE_KEY_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const prefix = m[1] ?? "";
    const valuePortion = m[2] ?? "";
    const trimmedValue = valuePortion.trim();

    // Block-scalar (|, >) → collapse to canonical single-line form.
    if (/^[|>]/.test(trimmedValue)) {
      lines[i] = prefix + formatYamlScalar(value);
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j] ?? "")) j++;
      lines.splice(i + 1, j - (i + 1));
      return lines.join(NEWLINE);
    }

    // Existing quoted scalar (single or double) → preserve quote style.
    const quotedM = /^(["'])(.*?)\1([ \t]*(?:#.*)?)$/.exec(valuePortion);
    if (quotedM !== null) {
      const quote = quotedM[1] ?? '"';
      const trailing = quotedM[3] ?? "";
      const escaped =
        quote === '"'
          ? value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
          : value.replace(/'/g, "''");
      lines[i] = prefix + quote + escaped + quote + trailing;
      return lines.join(NEWLINE);
    }

    // Existing unquoted + trailing comment → preserve the comment.
    const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
    if (commentM !== null) {
      lines[i] = prefix + formatYamlScalar(value) + (commentM[2] ?? "");
      return lines.join(NEWLINE);
    }

    // Existing plain unquoted scalar.
    lines[i] = prefix + formatYamlScalar(value);
    return lines.join(NEWLINE);
  }

  return null;
}

export function patchTitleField(bytes: Uint8Array, value: string): Uint8Array {
  const source = utf8Decoder.decode(bytes);
  const fm = locateFrontmatter(source);

  if (fm === null) {
    return utf8Encoder.encode(applyStateATitle(source, value));
  }

  const stateCResult = applyStateCTitle(source, fm.bodyStart, fm.bodyEnd, value);
  if (stateCResult !== null) {
    const before = source.substring(0, fm.bodyStart);
    const after = source.substring(fm.bodyEnd);
    return utf8Encoder.encode(before + stateCResult + after);
  }

  return utf8Encoder.encode(applyStateBTitle(source, fm.bodyEnd, value));
}

// === patchFirstH1Line — Q7 (β mirror-existing) write target for body `# H1` ===
//
// Spec: docs/decisions.md 2026-05-15 "Note title write target" — when the
// note's title is read from the body's first ATX-H1 line (no frontmatter
// `title:` present), rename writes through this primitive. The H1 line is
// user-authored body content; this is NOT a Myne-managed frontmatter field
// — it's a structural-transform primitive.
//
// Algorithm:
// 1. Locate the body region (the part of the source after any FM block).
// 2. Scan body lines for the first `^# ` ATX-H1 marker (CommonMark strict:
//    `#` followed by space; `#hashtag` is NOT a heading). Leading indent
//    is NOT supported in v0.1 — indented headings are rare and the rename
//    UI's primary write target for those cases is FM `title:` via the
//    Q7 β decision tree.
// 3. If found: replace that single line's content, preserving the `# `
//    prefix; keep all other lines (and the trailing newline) byte-identical.
// 4. If not found: prepend `# <value>` to the body region. If the body
//    already begins with `\n` (a blank-line separator after FM, or a
//    leading blank line in a no-FM note), insert `# <value>\n` and reuse
//    that existing `\n` as the post-H1 separator. Otherwise insert
//    `# <value>\n\n` so the H1 is followed by a blank line.

function findFirstH1LineIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("# ")) return i;
  }
  return -1;
}

export function patchFirstH1Line(
  bytes: Uint8Array,
  value: string,
): Uint8Array {
  const source = utf8Decoder.decode(bytes);
  // Defensive: strip newlines from the value — rename UI is the canonical
  // sanitizer (Q14 constraint), this is belt-and-suspenders.
  const sanitized = value.replace(/[\r\n]+/g, " ");

  const fm = locateFrontmatter(source);
  const bodyOffset = fm === null ? 0 : fm.blockEnd;
  const head = source.substring(0, bodyOffset);
  const body = source.substring(bodyOffset);

  const lines = body.split(NEWLINE);
  const h1Idx = findFirstH1LineIndex(lines);

  if (h1Idx !== -1) {
    lines[h1Idx] = "# " + sanitized;
    return utf8Encoder.encode(head + lines.join(NEWLINE));
  }

  // Prepend path. If body starts with `\n` (blank-line separator already
  // present), insert `# <value>\n` and let the existing `\n` be the
  // post-H1 separator. Otherwise insert `# <value>\n\n`.
  const startsWithBlank = body.startsWith(NEWLINE);
  const insert = startsWithBlank
    ? "# " + sanitized + NEWLINE
    : "# " + sanitized + NEWLINE + NEWLINE;
  return utf8Encoder.encode(head + insert + body);
}

// === patchFolderField — virtual-folder write target for FM `folder:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (`folder:` joins `updated:` +
// `title:` as the 3rd Myne-managed canonical frontmatter field). Grill:
// 2026-05-29-folder-hierarchy-sidebar Q5 (grammar/root convention) + Q7 (a2
// create-timing, state-D delete, empty-block removal). Write trigger =
// note-create (via `buildInitialPlaintext`) + move (via `moveNote` → here).
//
// Same A/B/C value-surgery as `patchTitleField` (folder values can carry
// YAML-unsafe chars such as `: `, so `formatYamlScalar` escalates to quoting),
// plus a 4th state D: delete the folder field (move-to-root). When deleting
// empties the whole block, the block is removed wholesale so the result is
// byte-identical to an FM-less root note (Q7 — symmetric with
// `buildInitialPlaintext(null) === ""`).

function applyStateAFolder(source: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    "folder: " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBFolder(
  source: string,
  bodyEnd: number,
  value: string,
): string {
  const insert = "folder: " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCFolder(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  const fmBody = source.substring(bodyStart, bodyEnd);
  const lines = fmBody.split(NEWLINE);

  for (let i = 0; i < lines.length; i++) {
    const m = FOLDER_KEY_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const prefix = m[1] ?? "";
    const valuePortion = m[2] ?? "";
    const trimmedValue = valuePortion.trim();

    // Block-scalar (|, >) → collapse to canonical single-line form.
    if (/^[|>]/.test(trimmedValue)) {
      lines[i] = prefix + formatYamlScalar(value);
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j] ?? "")) j++;
      lines.splice(i + 1, j - (i + 1));
      return lines.join(NEWLINE);
    }

    // Existing quoted scalar (single or double) → preserve quote style.
    const quotedM = /^(["'])(.*?)\1([ \t]*(?:#.*)?)$/.exec(valuePortion);
    if (quotedM !== null) {
      const quote = quotedM[1] ?? '"';
      const trailing = quotedM[3] ?? "";
      const escaped =
        quote === '"'
          ? value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
          : value.replace(/'/g, "''");
      lines[i] = prefix + quote + escaped + quote + trailing;
      return lines.join(NEWLINE);
    }

    // Existing unquoted + trailing comment → preserve the comment.
    const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
    if (commentM !== null) {
      lines[i] = prefix + formatYamlScalar(value) + (commentM[2] ?? "");
      return lines.join(NEWLINE);
    }

    // Existing plain unquoted scalar.
    lines[i] = prefix + formatYamlScalar(value);
    return lines.join(NEWLINE);
  }

  return null;
}

// State D — delete the folder field. Removes only the `folder:` line; if that
// empties the block (no residual key or comment), removes the whole block plus
// the canonical trailing blank line so the result is byte-identical to a note
// that never had frontmatter. No-op when there is no FM or no folder line.
function deleteFolderField(source: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return source;

  const fmBody = source.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const folderIdx = lines.findIndex((l) => FOLDER_KEY_RE.test(l));
  if (folderIdx === -1) return source;

  const remaining = lines
    .slice(0, folderIdx)
    .concat(lines.slice(folderIdx + 1));
  const hasResidual = remaining.some((l) => l.trim() !== "");

  if (!hasResidual) {
    let removalEnd = fm.blockEnd;
    if (source.charAt(removalEnd) === NEWLINE) removalEnd += NEWLINE.length;
    return source.substring(removalEnd);
  }

  const newBody = remaining.join(NEWLINE);
  return (
    source.substring(0, fm.bodyStart) + newBody + source.substring(fm.bodyEnd)
  );
}

/**
 * Set, insert, or delete the Myne-managed `folder:` frontmatter field.
 * `value === null` deletes the field (move-to-root, state D); a string sets it
 * (states A/B/C, mirroring `patchTitleField`).
 */
export function patchFolderField(
  bytes: Uint8Array,
  value: string | null,
): Uint8Array {
  const source = utf8Decoder.decode(bytes);

  if (value === null) {
    return utf8Encoder.encode(deleteFolderField(source));
  }

  const fm = locateFrontmatter(source);
  if (fm === null) {
    return utf8Encoder.encode(applyStateAFolder(source, value));
  }

  const stateCResult = applyStateCFolder(
    source,
    fm.bodyStart,
    fm.bodyEnd,
    value,
  );
  if (stateCResult !== null) {
    const before = source.substring(0, fm.bodyStart);
    const after = source.substring(fm.bodyEnd);
    return utf8Encoder.encode(before + stateCResult + after);
  }

  return utf8Encoder.encode(applyStateBFolder(source, fm.bodyEnd, value));
}

/**
 * Build the initial plaintext for a newly-created note (a2 create-timing,
 * Q7). A foldered note starts with a single-field FM block carrying `folder:`;
 * a root note (null / empty) starts empty. The Rust `note_create` stays
 * dialect-blind — it receives this string as opaque plaintext.
 */
export function buildInitialPlaintext(folder: string | null): string {
  if (folder === null || folder === "") return "";
  return applyStateAFolder("", folder);
}

// === patchTrashedField — soft-trash write target for FM `trashed:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (`trashed:` is the 4th Myne-managed
// canonical FM field). Write trigger = trash (`src/notes/trashNote.ts`) + restore
// (state-D delete). MYND-133. Structurally identical to `patchFolderField`: the set
// path is A/B/C value-surgery, plus state D (delete on restore) with empty-block
// collapse. Values are always RFC 3339 (plain-scalar safe), so `formatYamlScalar`
// is a passthrough for Myne-written values; the quoting/comment branches in state C
// only matter for a pre-existing user-authored `trashed:` line.
//
// (NOTE: this mirrors the updated/title/folder field-families nearly verbatim — a
// `/simplify` candidate is to generalize the four into one keyed helper. Kept
// per-field here to match the surrounding pattern and minimise regression risk.)

function applyStateATrashed(source: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    "trashed: " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBTrashed(
  source: string,
  bodyEnd: number,
  value: string,
): string {
  const insert = "trashed: " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCTrashed(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  const fmBody = source.substring(bodyStart, bodyEnd);
  const lines = fmBody.split(NEWLINE);

  for (let i = 0; i < lines.length; i++) {
    const m = TRASHED_KEY_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const prefix = m[1] ?? "";
    const valuePortion = m[2] ?? "";
    const trimmedValue = valuePortion.trim();

    if (/^[|>]/.test(trimmedValue)) {
      lines[i] = prefix + formatYamlScalar(value);
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j] ?? "")) j++;
      lines.splice(i + 1, j - (i + 1));
      return lines.join(NEWLINE);
    }

    const quotedM = /^(["'])(.*?)\1([ \t]*(?:#.*)?)$/.exec(valuePortion);
    if (quotedM !== null) {
      const quote = quotedM[1] ?? '"';
      const trailing = quotedM[3] ?? "";
      const escaped =
        quote === '"'
          ? value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
          : value.replace(/'/g, "''");
      lines[i] = prefix + quote + escaped + quote + trailing;
      return lines.join(NEWLINE);
    }

    const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
    if (commentM !== null) {
      lines[i] = prefix + formatYamlScalar(value) + (commentM[2] ?? "");
      return lines.join(NEWLINE);
    }

    lines[i] = prefix + formatYamlScalar(value);
    return lines.join(NEWLINE);
  }

  return null;
}

// State D — delete the trashed field (restore). Mirrors `deleteFolderField`:
// removes only the `trashed:` line; if the block empties (no residual key or
// comment), removes the whole block + the canonical trailing blank line so the
// result is byte-identical to a note that never had frontmatter.
function deleteTrashedField(source: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return source;

  const fmBody = source.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const trashedIdx = lines.findIndex((l) => TRASHED_KEY_RE.test(l));
  if (trashedIdx === -1) return source;

  const remaining = lines
    .slice(0, trashedIdx)
    .concat(lines.slice(trashedIdx + 1));
  const hasResidual = remaining.some((l) => l.trim() !== "");

  if (!hasResidual) {
    let removalEnd = fm.blockEnd;
    if (source.charAt(removalEnd) === NEWLINE) removalEnd += NEWLINE.length;
    return source.substring(removalEnd);
  }

  const newBody = remaining.join(NEWLINE);
  return (
    source.substring(0, fm.bodyStart) + newBody + source.substring(fm.bodyEnd)
  );
}

/**
 * Set, insert, or delete the Myne-managed `trashed:` frontmatter field.
 * `value === null` deletes the field (restore, state D); a string sets it
 * (states A/B/C). `note_trash` passes an RFC 3339 timestamp; `note_restore`
 * passes `null`. Mirrors {@link patchFolderField}.
 */
export function patchTrashedField(
  bytes: Uint8Array,
  value: string | null,
): Uint8Array {
  const source = utf8Decoder.decode(bytes);

  if (value === null) {
    return utf8Encoder.encode(deleteTrashedField(source));
  }

  const fm = locateFrontmatter(source);
  if (fm === null) {
    return utf8Encoder.encode(applyStateATrashed(source, value));
  }

  const stateCResult = applyStateCTrashed(
    source,
    fm.bodyStart,
    fm.bodyEnd,
    value,
  );
  if (stateCResult !== null) {
    const before = source.substring(0, fm.bodyStart);
    const after = source.substring(fm.bodyEnd);
    return utf8Encoder.encode(before + stateCResult + after);
  }

  return utf8Encoder.encode(applyStateBTrashed(source, fm.bodyEnd, value));
}

// RFC 3339 timestamp — the only value shape that marks a note trashed. The
// regex screens the structural shape; `Date.parse` rejects impossible dates
// (e.g. month 13) that the regex alone would admit.
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isValidRfc3339(value: string): boolean {
  if (!RFC3339_RE.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

// Extract the scalar value of a `trashed:` line into its logical string,
// stripping quotes / trailing comments. Returns null for block-scalar forms
// (`trashed: |`) — a Myne-written marker is never a block scalar.
function extractTrashedScalar(valuePortion: string): string | null {
  const trimmed = valuePortion.trim();
  if (trimmed === "") return null;
  if (/^[|>]/.test(trimmed)) return null;

  const quotedM = /^(["'])(.*?)\1[ \t]*(?:#.*)?$/.exec(trimmed);
  if (quotedM !== null) return quotedM[2] ?? null;

  const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
  const raw = commentM !== null ? (commentM[1] ?? "") : valuePortion;
  return raw.trim();
}

/**
 * Read the Myne-managed `trashed:` marker, **value-strict**, from a frontmatter
 * **body** — the text between the `---` fences (no delimiters), which is the
 * slice shape the Rust `note_titles_batch` returns (`title_extract.rs`
 * `body_start..cursor`) and what `loadNoteBatch` parses. Returns the RFC 3339
 * timestamp string iff a `trashed:` field carries a valid RFC 3339 value, else
 * `null` (live). A user's own non-timestamp `trashed:` (e.g. `trashed: true`)
 * leaves the note live — the documented mitigation for the unprefixed-field
 * collision footgun (§3.6.1; MYND-133 Q7).
 */
export function readTrashedFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = TRASHED_KEY_RE.exec(line);
    if (m === null) continue;
    const value = extractTrashedScalar(m[2] ?? "");
    if (value !== null && isValidRfc3339(value)) return value;
    return null;
  }
  return null;
}
