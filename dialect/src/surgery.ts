// Spec: docs/spec/markdown-dialect.md §3.6.1 (Myne-managed canonical
// frontmatter fields); decisions.md 2026-05-09 (TS-owned surgery).

import { load as parseYaml } from "js-yaml";
import {
  FRONTMATTER_DELIMITER,
  FRONTMATTER_OPENER,
  NEWLINE,
  locateFrontmatter,
} from "./lezer/frontmatter";
import type { ByteRange } from "./types";

// COLUMN ZERO, every one of them (myne#321).
//
// These twelve used to begin `^([ \t]*` — so every reader and every writer
// matched a key nested inside somebody else's mapping, or a key name appearing
// inside a block scalar.
//
// The write side is the damaging half, and it fires unconditionally.
// `patchUpdatedField` runs on EVERY save; a note carrying the ordinary
// Jekyll/Hugo/Obsidian-SEO shape `seo:\n  updated: …` had that nested value
// silently rewritten each time, while the top-level `updated:` was never
// inserted — so sort-by-updated never worked for that note and the user's own
// value was destroyed, which `markdown-dialect.md` promises is preserved. The
// Obsidian importer's title injection had the same shape: `seo.title` was
// overwritten with the filename and the note still landed "Untitled", which is
// precisely the failure the injection exists to prevent.
//
// The read side forges note STATE: a nested `deleted:` with a parseable RFC 3339
// value marks the note a sync tombstone, and every local view excludes those —
// so it vanished from the sidebar, Trash, Conflicts, Archive and the template
// picker with no recovery affordance. A nested `template: true` moved it into
// the Templates manager; a nested `kind: drawing` force-rendered a markdown note
// as a canvas.
//
// The package already gets this right twice and says why: `frontmatterSequence`'s
// `keyLineRe` ("an indented one belongs to a nested mapping and is none of our
// business") and the Rust twin `title_extract.rs`. Only this file was
// indent-blind — and it is the one on the hot path.
const UPDATED_KEY_RE = /^(updated[ \t]*:[ \t]*)(.*)$/;
const TITLE_KEY_RE = /^(title[ \t]*:[ \t]*)(.*)$/;
const FOLDER_KEY_RE = /^(folder[ \t]*:[ \t]*)(.*)$/;
const TRASHED_KEY_RE = /^(trashed[ \t]*:[ \t]*)(.*)$/;
const ARCHIVED_KEY_RE = /^(archived[ \t]*:[ \t]*)(.*)$/;
// MYND-426: the sync deletion tombstone marker. Value-strict RFC 3339 like
// `trashed:`/`archived:` — only a parseable timestamp marks the note deleted.
const DELETED_KEY_RE = /^(deleted[ \t]*:[ \t]*)(.*)$/;
// `done:` — the MYND-613 completion stamp (§3.6.1, twelfth managed field).
const DONE_KEY_RE = /^(done[ \t]*:[ \t]*)(.*)$/;
// MYND-427: the conflict-copy markers. `conflict:` is value-strict canonical
// `true` (like `template:`); `conflict_of:` carries the original note UUID.
const CONFLICT_KEY_RE = /^(conflict[ \t]*:[ \t]*)(.*)$/;
const CONFLICT_OF_KEY_RE = /^(conflict_of[ \t]*:[ \t]*)(.*)$/;
const CONFLICT_FLAG_VALUE = "true";
const TEMPLATE_KEY_RE = /^(template[ \t]*:[ \t]*)(.*)$/;
const FOLDER_INDEX_KEY_RE = /^(folder_index[ \t]*:[ \t]*)(.*)$/;
const KIND_KEY_RE = /^(kind[ \t]*:[ \t]*)(.*)$/;

// The single canonical value that marks a note a template. Value-strict:
// `readTemplateFromFmBody` accepts only this literal, unquoted form
// (§3.6.1 `template:` row) — `template: 1` / `yes` / `True` / `"true"` all
// read as an ordinary note, mirroring how `trashed:` admits only a valid
// RFC 3339 value.
export const TEMPLATE_FLAG_VALUE = "true";

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

/**
 * The inverse of {@link formatYamlScalar} for the double-quoted form: take a
 * value portion and return the logical string it encodes.
 *
 * This exists because the shared scalar extractor cannot do it. That extractor
 * matches `/^(["'])(.*?)\1[ \t]*(?:#.*)?$/`, which has no notion of `\"`, so a
 * value carrying BOTH an escaped quote and a later `#` closes the group on the
 * escaped quote and hands the rest to the optional-comment tail. Every managed
 * field whose value is a timestamp or the literal `true` is immune, which is
 * why the gap survived; `cover:` is the first whose value can carry a filename,
 * so it is the first that can hit it.
 *
 * Returns `null` for anything that is not a well-formed double-quoted scalar,
 * so the caller can fall back to the plain-scalar path.
 */
export function parseDoubleQuotedYamlScalar(valuePortion: string): string | null {
  const s = valuePortion.trim();
  if (!s.startsWith('"')) return null;
  let out = "";
  let i = 1;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\") {
      // `formatYamlScalar` only ever emits `\\` and `\"`; anything else is a
      // value we did not write, and passing the escaped char through verbatim
      // is the conservative read.
      const next = s[i + 1];
      if (next === undefined) return null;
      out += next;
      i += 2;
      continue;
    }
    if (ch === '"') {
      // Closing quote. Only whitespace and an optional `# comment` may follow.
      const tail = s.slice(i + 1);
      return /^[ \t]*(?:#.*)?$/.test(tail) ? out : null;
    }
    out += ch;
    i += 1;
  }
  // Ran off the end without a closing quote.
  return null;
}

// Would YAML re-type the bare scalar `value` to something other than the exact
// string? A title like `2026-06-07` is a YAML timestamp, `5` an int, `true` a
// bool, `null` the null value — all parse back as non-strings (or a different
// string), so an unquoted emission round-trips wrong when the reader
// (`loadNoteBatch` via js-yaml) parses the frontmatter. We test against the
// actual reader (js-yaml, default schema) rather than enumerating YAML's many
// coercible forms (dates, ints, floats, hex/octal, sexagesimal, inf/nan, bools,
// null). Parse errors → treat as unsafe (quote).
function yamlReTypesPlainScalar(value: string): boolean {
  try {
    return parseYaml(value) !== value;
  } catch {
    return true;
  }
}

// Format a value that MUST read back as the exact string. Like
// {@link formatYamlScalar}, but ALSO quotes a value that YAML would re-type away
// from a string. Two callers today, for the same reason: a note title is always
// a string, so a date-/number-/bool-shaped title (e.g. a daily note titled
// `2026-06-07`) must be quoted or the reader parses it as a non-string and the
// sidebar shows "Untitled" (and daily-note idempotency breaks, since the
// title-keyed match never finds it); and a frontmatter tag item (`notes/ai/
// acceptTag.ts`) would otherwise be handed to the tag index as a number or a
// bool and read back different, or vanish. The value-strict fields do NOT need
// it — `trashed:` (RFC 3339) and `template:` (literal `true`) are read without
// js-yaml and must stay unquoted, so they keep {@link formatYamlScalar}.
export function formatYamlStringScalar(value: string): string {
  if (needsYamlQuoting(value) || yamlReTypesPlainScalar(value)) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
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

// State C strategy ξ: replace an existing managed field's value byte-by-byte.
// Block-scalar collapse to single line is justified because these fields are
// Myne-managed per §3.6.1 — it does not violate §6 C1 byte-stability for
// other keys (those are preserved untouched).
//
// Every `applyStateC*` family (updated / title / folder / trashed / archived /
// deleted / template + the generic keyed `patchFrontmatterField`) shares this
// exact body; they differ ONLY in the key matcher (`keyRe`) and the plain-scalar
// formatter (`format`). The quoted branch escapes the RAW value per the existing
// quote style (double → `\`+`"`, single → `''`) independent of `format`, matching
// every prior per-field body. (`updated:`'s old body emitted the raw ISO in the
// quoted branch; escaping an RFC 3339 string is a no-op, so this is byte-identical.)
/**
 * One past the last line of the LOGICAL YAML value whose key line is `lines[i]`
 * (myne#324).
 *
 * A managed key is column zero (myne#321), so a continuation line is any line
 * that is indented — plus a column-zero block-sequence item under a key whose
 * own value portion is empty, and plus blank lines that are themselves followed
 * by a continuation (a block scalar may contain them).
 *
 * `applyStateCImpl` used to consume continuations only in its block-scalar
 * branch, and only while they were both indented and non-blank. Everything else
 * — a multi-line plain scalar, a multi-line quoted scalar, a block sequence, or
 * a block scalar containing a blank line — had its key line rewritten and its
 * continuation lines left welded onto the new value. Where the leftovers still
 * parsed, the rename or move silently produced a mangled value ("z b"); where
 * they did not, js-yaml threw on the whole block, `loadNoteBatch` swallowed it
 * and returned `{}`, and the note lost its title, folder, timestamp, tags and
 * cover all at once — showing as "Untitled" and unfiled, with the raw-slice
 * title fallback not reached because the parsed map is empty rather than absent.
 */
function logicalValueEnd(lines: readonly string[], i: number, valueIsEmpty: boolean): number {
  const isContinuation = (line: string): boolean =>
    /^[ \t]/.test(line) || (valueIsEmpty && /^-(?:[ \t]|$)/.test(line));

  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j] ?? "";
    if (line.trim() === "") {
      // A blank line belongs to the value only if a continuation follows it;
      // otherwise it ends the value (and, in frontmatter, usually the block).
      let k = j;
      while (k < lines.length && (lines[k] ?? "").trim() === "") k++;
      if (k < lines.length && isContinuation(lines[k] ?? "")) {
        j = k;
        continue;
      }
      return j;
    }
    if (!isContinuation(line)) return j;
    j++;
  }
  return j;
}

function applyStateCImpl(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  keyRe: RegExp,
  format: (v: string) => string,
  value: string,
): string | null {
  const fmBody = source.substring(bodyStart, bodyEnd);
  const lines = fmBody.split(NEWLINE);

  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i] ?? "");
    if (m === null) continue;
    const prefix = m[1] ?? "";
    const valuePortion = m[2] ?? "";
    const trimmedValue = valuePortion.trim();

    // The whole LOGICAL value is replaced, not just its key line (myne#324):
    // every continuation line goes with it, whatever the value's shape.
    const valueEnd = logicalValueEnd(lines, i, trimmedValue === "");
    const replaceValue = (rendered: string): string => {
      // A key written `tags:` with nothing after it leaves `prefix` without a
      // separator, so a naive concat emits `tags:cover.png`. Insert the space
      // the YAML needs.
      lines[i] = /[ \t]$/.test(prefix) ? prefix + rendered : prefix + " " + rendered;
      lines.splice(i + 1, valueEnd - (i + 1));
      return lines.join(NEWLINE);
    };

    // Block-scalar (|, >) → collapse to canonical single-line form.
    if (/^[|>]/.test(trimmedValue)) {
      return replaceValue(format(value));
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
      return replaceValue(quote + escaped + quote + trailing);
    }

    // Existing unquoted + trailing comment → preserve the comment.
    const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
    if (commentM !== null) {
      return replaceValue(format(value) + (commentM[2] ?? ""));
    }

    // Existing plain unquoted scalar.
    return replaceValue(format(value));
  }

  return null;
}

/** Plain-scalar formatter for `updated:` — RFC 3339 values are always
 *  plain-scalar safe, so the value passes through verbatim. */
const rawScalar = (v: string): string => v;

// `updated:` — value is always an RFC 3339 timestamp (plain-scalar safe).
function applyStateC(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  iso: string,
): string | null {
  return applyStateCImpl(source, bodyStart, bodyEnd, UPDATED_KEY_RE, rawScalar, iso);
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
    "title: " + formatYamlStringScalar(value) + NEWLINE +
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
  // `formatYamlStringScalar` (NOT `formatYamlScalar`) — inserting a fresh
  // `title:` line into an existing FM block (the common case: a note that
  // already carries `updated:` / `folder:` but no title yet) must quote a
  // value YAML would re-type away from a string, exactly like states A and C.
  // A date-shaped title (`2026-06-07`) inserted unquoted reads back as a Date
  // → "Untitled" (and breaks daily-note title-keyed matching).
  const insert = "title: " + formatYamlStringScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

// `title:` — user-authored; `formatYamlStringScalar` also quotes a value YAML
// would re-type away from a string (a date-/int-/bool-shaped title).
function applyStateCTitle(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    TITLE_KEY_RE,
    formatYamlStringScalar,
    value,
  );
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

// Extract the scalar value of a `title:` line into its logical string,
// stripping surrounding quotes (single/double) and an unquoted trailing
// `# comment`. Returns null for an empty value or a block-scalar form
// (`title: |`). Shape-mirror of `extractTrashedScalar`.
function extractTitleScalar(valuePortion: string): string | null {
  const trimmed = valuePortion.trim();
  if (trimmed === "") return null;
  if (/^[|>]/.test(trimmed)) return null;

  const quotedM = /^(["'])(.*?)\1[ \t]*(?:#.*)?$/.exec(trimmed);
  if (quotedM !== null) return quotedM[2] ?? null;

  const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
  const raw = commentM !== null ? (commentM[1] ?? "") : valuePortion;
  const result = raw.trim();
  return result === "" ? null : result;
}

/**
 * Read the FM `title:` scalar **value-strict** from a frontmatter **body** (the
 * slice shape `loadNoteBatch` parses, identical to {@link readTrashedFromFmBody}).
 * Returns the literal title text the user typed — preserving the exact string
 * for a value YAML would otherwise re-type to a non-string (a date-shaped
 * `2026-06-07`, an int, a bool). `loadNoteBatch` uses this as the fallback when
 * js-yaml hands back a non-string for `title:`, so an unquoted date title (an
 * older note written before the state-B title-quoting fix, or an imported /
 * hand-edited file) still shows its title instead of "Untitled". Returns null
 * when no `title:` line is present, the value is empty, or it is a block scalar.
 */
export function readTitleFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = TITLE_KEY_RE.exec(line);
    if (m === null) continue;
    return extractTitleScalar(m[2] ?? "");
  }
  return null;
}

// === patchFirstH1Line — Q7 (β mirror-existing) write target for body `# H1` ===
//
// Spec: design-notes.md 2026-05-15 "Note title write target" — when the
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
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Track fenced code blocks so a column-0 `# ` INSIDE a fence is not mistaken
    // for the title — the Lezer reader (visitors/headings) skips it as CodeText,
    // so the writer must too, or a rename would corrupt code and miss the real H1.
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith("# ")) return i;
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
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    FOLDER_KEY_RE,
    formatYamlScalar,
    value,
  );
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
// (Its State C body is the shared `applyStateCImpl` — every managed field-family
// delegates to that one keyed helper; only the key matcher + formatter differ.)

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
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    TRASHED_KEY_RE,
    formatYamlScalar,
    value,
  );
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

/**
 * Read the Myne-managed `updated:` (last-edited) timestamp, **value-strict**,
 * from a frontmatter **body** — the value-strict twin of
 * {@link readTrashedFromFmBody}. Returns the RFC 3339 timestamp string iff an
 * `updated:` field carries a valid RFC 3339 value, else `null`. `updated:` is
 * the canonical last-edit stamp (§3.6.1) surgery rewrites on every save; the
 * mobile note list renders it as a relative-time subtitle (parity with the
 * desktop `NoteRow` last-edited meta).
 */
export function readUpdatedFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = UPDATED_KEY_RE.exec(line);
    if (m === null) continue;
    const value = extractTrashedScalar(m[2] ?? "");
    if (value !== null && isValidRfc3339(value)) return value;
    return null;
  }
  return null;
}

/**
 * Read the Myne-managed `deleted:` tombstone marker, **value-strict**, from a
 * frontmatter **body** — the exact value-strict twin of
 * {@link readTrashedFromFmBody}. Returns the RFC 3339 timestamp string iff a
 * `deleted:` field carries a valid RFC 3339 value, else `null` (not deleted).
 *
 * `deleted:` is the SYNC deletion tombstone (MYND-426, written by
 * `tombstoneNote`/`patchDeletedField`): the note is logically gone but the blob
 * persists so the deletion PROPAGATES to other devices and is horizon-GC'd
 * server-side. Locally a `deleted != null` record must be hidden from every view
 * (sidebar, trash, conflicts, search, resolver) — it is a tombstone, not a note.
 * A user's own non-timestamp `deleted:` leaves the note live (same unprefixed-
 * field collision mitigation as `trashed:`).
 */
export function readDeletedFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = DELETED_KEY_RE.exec(line);
    if (m === null) continue;
    const value = extractTrashedScalar(m[2] ?? "");
    if (value !== null && isValidRfc3339(value)) return value;
    return null;
  }
  return null;
}

/**
 * Read the Myne-managed `archived:` marker, **value-strict**, from a frontmatter
 * **body** — the exact value-strict twin of {@link readTrashedFromFmBody}.
 * Returns the RFC 3339 timestamp string iff an `archived:` field carries a valid
 * RFC 3339 value, else `null` (not archived). A user's own non-timestamp
 * `archived:` (e.g. `archived: true`) leaves the note live — the same
 * unprefixed-field collision mitigation as `trashed:` (§3.6.1; note-archive /
 * MYND-331). `archived:` is the 8th Myne-managed canonical FM field, joining
 * `updated:` / `title:` / `folder:` / `trashed:` / `template:` / `folder_index:`.
 * It shares `extractTrashedScalar` + `isValidRfc3339` with `trashed:` because the
 * two are structurally identical timestamp fields (a `/simplify` candidate is to
 * fold the two into one keyed timestamp-read helper).
 */
export function readArchivedFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = ARCHIVED_KEY_RE.exec(line);
    if (m === null) continue;
    const value = extractTrashedScalar(m[2] ?? "");
    if (value !== null && isValidRfc3339(value)) return value;
    return null;
  }
  return null;
}

/**
 * Value-strict read of the `conflict:` marker (MYND-427): only the canonical
 * unquoted `true` marks a note a conflict copy (a user's own `conflict: 1` reads
 * as not-a-conflict — the same value-strictness as `template:`).
 */
export function readConflictFromFmBody(fmBody: string): boolean {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = CONFLICT_KEY_RE.exec(line);
    if (m === null) continue;
    const valuePortion = m[2] ?? "";
    const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
    const raw = commentM !== null ? (commentM[1] ?? "") : valuePortion;
    return raw.trim() === CONFLICT_FLAG_VALUE;
  }
  return false;
}

/**
 * Read the `conflict_of:` original-note UUID (MYND-427) — the value the Conflicts
 * view groups copies by. Returns the trimmed scalar (quotes/comment stripped) or
 * null when absent.
 */
export function readConflictOfFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = CONFLICT_OF_KEY_RE.exec(line);
    if (m === null) continue;
    const value = extractTrashedScalar(m[2] ?? "");
    return value !== null && value.length > 0 ? value : null;
  }
  return null;
}

// === patchArchivedField — note-archive write target for FM `archived:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (`archived:` is the 8th Myne-managed
// canonical FM field). Write trigger = archive (`src/notes/archiveNote.ts`) +
// unarchive (state-D delete). note-archive / MYND-331. Structurally identical to
// `patchTrashedField`: A/B/C value-surgery for the set path, plus state D (delete
// on unarchive) with empty-block collapse. Values are always RFC 3339 (plain-scalar
// safe). `archived:` and `trashed:` are independent lines on the blob — each patcher
// only touches its own line — so the archive action layer composes them (clear one,
// set the other) to enforce the archive ⊥ trash mutual exclusion.

function applyStateAArchived(source: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    "archived: " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBArchived(
  source: string,
  bodyEnd: number,
  value: string,
): string {
  const insert = "archived: " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCArchived(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    ARCHIVED_KEY_RE,
    formatYamlScalar,
    value,
  );
}

// State D — delete the archived field (unarchive). Mirrors `deleteTrashedField`:
// removes only the `archived:` line; if the block empties (no residual key or
// comment), removes the whole block + the canonical trailing blank line so the
// result is byte-identical to a note that never had frontmatter.
function deleteArchivedField(source: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return source;

  const fmBody = source.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const archivedIdx = lines.findIndex((l) => ARCHIVED_KEY_RE.test(l));
  if (archivedIdx === -1) return source;

  const remaining = lines
    .slice(0, archivedIdx)
    .concat(lines.slice(archivedIdx + 1));
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
 * Set, insert, or delete the Myne-managed `archived:` frontmatter field.
 * `value === null` deletes the field (unarchive, state D); a string sets it
 * (states A/B/C). `archiveNote` passes an RFC 3339 timestamp; `unarchiveNote`
 * passes `null`. Mirrors {@link patchTrashedField} — touches only the `archived:`
 * line, so it composes with `trashed:` (the action layer clears one and sets the
 * other to keep archive ⊥ trash) and any user-authored fields without clobbering.
 */
export function patchArchivedField(
  bytes: Uint8Array,
  value: string | null,
): Uint8Array {
  const source = utf8Decoder.decode(bytes);

  if (value === null) {
    return utf8Encoder.encode(deleteArchivedField(source));
  }

  const fm = locateFrontmatter(source);
  if (fm === null) {
    return utf8Encoder.encode(applyStateAArchived(source, value));
  }

  const stateCResult = applyStateCArchived(
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

  return utf8Encoder.encode(applyStateBArchived(source, fm.bodyEnd, value));
}

// === patchDeletedField — sync deletion-tombstone write target for FM `deleted:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (`deleted:` — the sync tombstone
// marker, MYND-426). Value-strict RFC 3339 like `trashed:`/`archived:`: only a
// parseable timestamp marks the note a deletion tombstone. Write trigger = the
// under-sync deletion reroute (`src/notes/deleteNote.ts`) — NEVER body autosave.
// Structurally identical to `patchArchivedField` (A/B/C set + state-D delete),
// so it composes with every other managed field without clobbering.

function applyStateADeleted(source: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    "deleted: " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBDeleted(source: string, bodyEnd: number, value: string): string {
  const insert = "deleted: " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCDeleted(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    DELETED_KEY_RE,
    formatYamlScalar,
    value,
  );
}

function deleteDeletedField(source: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return source;

  const fmBody = source.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const idx = lines.findIndex((l) => DELETED_KEY_RE.test(l));
  if (idx === -1) return source;

  const remaining = lines.slice(0, idx).concat(lines.slice(idx + 1));
  const hasResidual = remaining.some((l) => l.trim() !== "");

  if (!hasResidual) {
    let removalEnd = fm.blockEnd;
    if (source.charAt(removalEnd) === NEWLINE) removalEnd += NEWLINE.length;
    return source.substring(removalEnd);
  }

  const newBody = remaining.join(NEWLINE);
  return source.substring(0, fm.bodyStart) + newBody + source.substring(fm.bodyEnd);
}

/**
 * Set, insert, or delete the Myne-managed `deleted:` tombstone field (MYND-426).
 * `value` is an RFC 3339 timestamp (the deletion path); `null` deletes the field
 * (rare — an undelete). Touches only the `deleted:` line, so it composes with
 * every other managed field. Used by the under-sync deletion reroute so a delete
 * propagates as a `deleted`-marked version, never a bare absence.
 */
export function patchDeletedField(bytes: Uint8Array, value: string | null): Uint8Array {
  const source = utf8Decoder.decode(bytes);

  if (value === null) {
    return utf8Encoder.encode(deleteDeletedField(source));
  }

  const fm = locateFrontmatter(source);
  if (fm === null) {
    return utf8Encoder.encode(applyStateADeleted(source, value));
  }

  const stateCResult = applyStateCDeleted(source, fm.bodyStart, fm.bodyEnd, value);
  if (stateCResult !== null) {
    const before = source.substring(0, fm.bodyStart);
    const after = source.substring(fm.bodyEnd);
    return utf8Encoder.encode(before + stateCResult + after);
  }

  return utf8Encoder.encode(applyStateBDeleted(source, fm.bodyEnd, value));
}

// === patchTemplateField — note-template write target for FM `template:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (`template:` is the 5th Myne-managed
// canonical FM field — the inverse-visibility twin of `trashed:`). Write trigger =
// template create / convert actions (`src/notes/templates.ts`) only — never body
// autosave. MYND-186. Structurally identical to `patchTrashedField`: the set path
// is A/B/C value-surgery, plus state D (delete on convert-back) with empty-block
// collapse. The only value Myne ever writes is the canonical boolean
// `TEMPLATE_FLAG_VALUE` (`true`), which `formatYamlScalar` emits as a plain scalar;
// the quoting/comment branches in state C only matter for a pre-existing
// user-authored `template:` line.
//
// `template:` and `trashed:` are independent flags that compose on the same blob
// without clobbering (the §3.6 unknown-field-preservation rule): each patcher only
// ever touches its own line. A note can therefore be simultaneously
// `template: true` and `trashed: <ts>`.

function applyStateATemplate(source: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    "template: " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBTemplate(
  source: string,
  bodyEnd: number,
  value: string,
): string {
  const insert = "template: " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCTemplate(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  value: string,
): string | null {
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    TEMPLATE_KEY_RE,
    formatYamlScalar,
    value,
  );
}

// State D — delete the template field (convert-back-to-note). Mirrors
// `deleteTrashedField`: removes only the `template:` line; if the block empties
// (no residual key or comment), removes the whole block + the canonical trailing
// blank line so the result is byte-identical to a note that never had frontmatter.
function deleteTemplateField(source: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return source;

  const fmBody = source.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const templateIdx = lines.findIndex((l) => TEMPLATE_KEY_RE.test(l));
  if (templateIdx === -1) return source;

  const remaining = lines
    .slice(0, templateIdx)
    .concat(lines.slice(templateIdx + 1));
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
 * Set, insert, or delete the Myne-managed `template:` frontmatter field.
 * `value === null` deletes the field (convert-template-to-note, state D); a
 * string sets it (states A/B/C). `convertNoteToTemplate` passes
 * {@link TEMPLATE_FLAG_VALUE}; `convertTemplateToNote` passes `null`. Mirrors
 * {@link patchTrashedField} — touches only the `template:` line, so it composes
 * with `trashed:` and any user-authored fields without clobbering them.
 */
export function patchTemplateField(
  bytes: Uint8Array,
  value: string | null,
): Uint8Array {
  const source = utf8Decoder.decode(bytes);

  if (value === null) {
    return utf8Encoder.encode(deleteTemplateField(source));
  }

  const fm = locateFrontmatter(source);
  if (fm === null) {
    return utf8Encoder.encode(applyStateATemplate(source, value));
  }

  const stateCResult = applyStateCTemplate(
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

  return utf8Encoder.encode(applyStateBTemplate(source, fm.bodyEnd, value));
}

/**
 * Read the Myne-managed `template:` marker, **value-strict**, from a frontmatter
 * **body** — the text between the `---` fences (the slice shape `loadNoteBatch`
 * parses, identical to {@link readTrashedFromFmBody}). Returns `true` iff a
 * `template:` field carries the canonical, unquoted boolean
 * {@link TEMPLATE_FLAG_VALUE} (`true`), else `false`. A user's own non-canonical
 * `template:` value (`template: 1`, `template: yes`, `template: "true"`,
 * `template: True`) leaves the note an ordinary note — the documented mitigation
 * for the unprefixed-field collision footgun (§3.6.1; inverse-visibility twin of
 * the value-strict `trashed:` rule).
 */
export function readTemplateFromFmBody(fmBody: string): boolean {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = TEMPLATE_KEY_RE.exec(line);
    if (m === null) continue;
    return isCanonicalTemplateFlag(m[2] ?? "");
  }
  return false;
}

// Value-strict canonical check for a `template:` scalar. Strips a trailing
// `# comment` (the only thing Myne never writes but a user might leave) and
// requires the literal unquoted `true`. A quoted `"true"` is a YAML string, not
// the canonical boolean, so it is rejected.
function isCanonicalTemplateFlag(valuePortion: string): boolean {
  const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
  const raw = commentM !== null ? (commentM[1] ?? "") : valuePortion;
  return raw.trim() === TEMPLATE_FLAG_VALUE;
}

// === patchFolderIndexField — folder-note write target for FM `folder_index:` ===
//
// Spec: docs/spec/markdown-dialect.md §3.6.1 (`folder_index:` is the 6th
// Myne-managed canonical FM field). Write trigger = folder-note designate /
// undesignate actions (`src/notes/folderNote.ts`) only — never body autosave.
// MYND-370. The note is the index of whichever folder its own `folder:` field
// names, so the marker is a **value-strict boolean** (canonical unquoted `true`)
// and carries NO path — folder rename rewrites `folder:`, the binding follows for
// free, and folder-rename drift is structurally impossible.
//
// Unlike `template:` / `trashed:` (which HIDE the note from sidebar / folder-tree
// / search), `folder_index: true` does NOT hide: the index note stays a fully
// visible, enumerable child of its folder, pinned to the top with a badge.
//
// The set/delete surgery is the generic keyed `patchFrontmatterField` over the
// `folder_index` key (states A/B/C/D with empty-block collapse) — no bespoke
// field family is needed because the only value Myne ever writes is the canonical
// `true`. The value-strict READ is bespoke (mirrors `readTemplateFromFmBody`),
// since a user's own non-canonical `folder_index:` must read as an ordinary note.

// The single canonical value that marks a note its folder's index. Value-strict,
// exactly like `TEMPLATE_FLAG_VALUE`: `1` / `yes` / `True` / quoted `"true"` all
// read as an ordinary note.
export const FOLDER_INDEX_FLAG_VALUE = "true";

/**
 * Set or delete the Myne-managed `folder_index:` frontmatter field.
 * `on === true` writes the canonical `folder_index: true`; `on === false` deletes
 * the field (with empty-block collapse). Touches only the `folder_index:` line,
 * so it composes with `folder:` / `trashed:` / `template:` and any user-authored
 * fields without clobbering them. Thin wrapper over {@link patchFrontmatterField}.
 */
export function patchFolderIndexField(
  bytes: Uint8Array,
  on: boolean,
): Uint8Array {
  return patchFrontmatterField(
    bytes,
    "folder_index",
    on ? FOLDER_INDEX_FLAG_VALUE : null,
  );
}

/**
 * Read the Myne-managed `folder_index:` marker, **value-strict**, from a
 * frontmatter **body** (the slice shape `loadNoteBatch` parses, identical to
 * {@link readTemplateFromFmBody}). Returns `true` iff a `folder_index:` field
 * carries the canonical, unquoted boolean {@link FOLDER_INDEX_FLAG_VALUE}
 * (`true`), else `false`. A user's own non-canonical `folder_index:` value
 * (`1`, `yes`, `"true"`, `True`) leaves the note ordinary — the documented
 * mitigation for the unprefixed-field collision footgun (§3.6.1; same
 * value-strict rule as `template:`).
 */
export function readFolderIndexFromFmBody(fmBody: string): boolean {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = FOLDER_INDEX_KEY_RE.exec(line);
    if (m === null) continue;
    return isCanonicalFolderIndexFlag(m[2] ?? "");
  }
  return false;
}

// Value-strict canonical check for a `folder_index:` scalar. Identical contract
// to `isCanonicalTemplateFlag`: strips a trailing `# comment` and requires the
// literal unquoted `true`; a quoted `"true"` is a YAML string, not the canonical
// boolean, so it is rejected.
function isCanonicalFolderIndexFlag(valuePortion: string): boolean {
  const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
  const raw = commentM !== null ? (commentM[1] ?? "") : valuePortion;
  return raw.trim() === FOLDER_INDEX_FLAG_VALUE;
}

// === cover: — the note's cover image (myne-md/myne#410) ===
//
// `cover:` is the 13th Myne-managed canonical FM field (markdown-dialect.md
// §3.6.1). Its value is a form-C attachment embed, which makes it the first
// managed field whose value can legitimately contain a `#` or a `"` (a filename
// can; an RFC 3339 timestamp and the literal `true` cannot). That is why the
// read below goes through `extractTrashedScalar` — the shared scalar extractor
// every other value-strict field already uses — instead of matching the raw
// line. The extractor only recognises a comment AFTER the closing quote, and
// the value is quoted on disk (`needsYamlQuoting` returns true for a leading
// `!`), so a `#` inside a filename survives and a user's trailing comment does
// not cost them the cover. Hand-rolling a second reader here is exactly what
// would break both.
//
// The strictness is on the GRAMMAR of the value, not on whether the attachment
// still resolves: the catalog distinguishes `loading` from `deleted`, and a
// resolvability-strict field would flicker between valid and invalid while the
// catalog loads. A dangling cover is a render decision (draw nothing), not an
// invalid field.
//
// The WRITE is the generic keyed `patchFrontmatterField` via
// `src/notes/setNoteCover.ts`, like the conflict pair — no bespoke surgery
// family, because the generic path already gives set, change and delete.

/** A resolved cover reference: the attachment id plus its display alias. */
export interface CoverRef {
  readonly id: string;
  readonly filename: string;
}

/** The canonical field name. Exported so no caller writes the string `"cover"`
 *  by hand into a `patchFrontmatterField` call and drifts from this reader. */
export const COVER_FIELD_KEY = "cover";

const COVER_KEY_RE = /^(cover[ \t]*:[ \t]*)(.*)$/;
/**
 * The whole logical value must be ONE form-C embed and nothing else.
 *
 * The alias is `[^\]]*`, character-for-character the alias grammar the shared
 * form-C scanner uses (`extractAttachmentRefs`, which owns the body-embed
 * form). Matching it matters twice over. It keeps one grammar: a filename
 * containing `]` must not parse as a cover when the same embed in the note body
 * would not parse either. And it is what makes "exactly one embed" true without
 * a hand-rolled lookahead: an alias that cannot contain `]` cannot swallow a
 * second embed, which a greedy `.*` anchored on `\]\]$` silently did, reading
 * `![[att:A|a.png]] ![[att:B|b.png]]` as one embed for id A and picking a
 * winner the user never chose.
 */
const COVER_EMBED_RE = /^!\[\[att:([0-9a-f]{64})\|([^\]]*)\]\]$/;

/**
 * Value-strict read of one `cover:` **value portion** (the bytes after `cover:`).
 * Returns the reference iff the logical value is exactly one form-C attachment
 * embed, else `null`.
 *
 * Rejects everything Myne does not write: `cover: true`, `cover: photo.png`, a
 * bare attachment id, a `[[att:…]]` missing the `!`, two embeds, an embed with
 * surrounding prose, and an id that is not 64 lowercase hex characters. Accepts
 * the quoted on-disk form, the same with a trailing YAML comment, and a
 * hand-written unquoted embed.
 *
 * The alias is un-escaped (the inverse of `formatYamlScalar`) so a filename
 * containing `"` reads back as the user's filename rather than its on-disk
 * escaping. Validity never depends on the alias.
 */
export function readCoverValue(valuePortion: string): CoverRef | null {
  // The quoted form FIRST, through the escape-aware parser: this is the form
  // Myne writes, and the shared extractor mis-reads it when the filename
  // carries both an escaped quote and a later `#`. Fall back to the shared
  // extractor for the plain-scalar form a user may have hand-written.
  const scalar =
    parseDoubleQuotedYamlScalar(valuePortion) ?? extractTrashedScalar(valuePortion);
  if (scalar === null) return null;
  const m = COVER_EMBED_RE.exec(scalar);
  if (m === null) return null;
  return { id: m[1]!, filename: m[2]! };
}

/**
 * Read the Myne-managed `cover:` reference, **value-strict**, from a frontmatter
 * **body** (the slice shape `loadNoteBatch` parses, identical to
 * {@link readTemplateFromFmBody}). **First `cover:` line wins**, matching how
 * `kind:` resolves a duplicated key, so a note carrying two of them renders
 * deterministically rather than depending on read order.
 */
export function readCoverFromFmBody(fmBody: string): CoverRef | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = COVER_KEY_RE.exec(line);
    if (m === null) continue;
    return readCoverValue(m[2] ?? "");
  }
  return null;
}

// === kind: drawing — the drawing-note marker (drawing-notes SF2, MYND-499) ===
//
// `kind:` is the 7th Myne-managed canonical FM field (markdown-dialect.md
// §3.6.1). Unlike the boolean flags it is a string enum; v1 defines exactly one
// value, `drawing`, which routes the note to the Excalidraw canvas surface
// instead of CodeMirror. The READ is value-strict (bespoke, mirrors
// `readTemplateFromFmBody`): a user's own non-canonical `kind:` (`kind: "drawing"`,
// `kind: Drawing`, `kind: task`) reads as an ordinary note, so a stray `kind:`
// never force-renders someone's markdown as a canvas — a collision footgun that
// matters MORE here than for `template:`/`trashed:` because it drives the render
// surface, not just visibility (§3.6.1). The WRITE is the generic keyed
// `patchFrontmatterField` (the only value Myne writes is the canonical `drawing`,
// a plain scalar).

/**
 * Set or clear the Myne-managed `done:` completion timestamp (MYND-613) — the
 * twelfth managed canonical field (§3.6.1), an exact twin of the `trashed:` /
 * `archived:` / `deleted:` date-valued trio.
 *
 * A **thin named wrapper over the generic patcher**, deliberately not a bespoke
 * surgery family like `patchArchivedField`: the generic path already provides
 * set, change, delete and empty-block collapse, and a bespoke family is only
 * warranted when the value shape is unusual. An RFC 3339 timestamp is not.
 *
 * `null` deletes the field — **un-completion removes the marker rather than
 * writing a falsy value**, so a note is never carrying `done: false`.
 *
 * Written only by an orchestrator over the note-update path; body autosave never
 * touches it.
 */
export function patchDoneField(bytes: Uint8Array, value: string | null): Uint8Array {
  return patchFrontmatterField(bytes, "done", value);
}

/**
 * Read the Myne-managed `done:` completion timestamp, **value-strict**, from a
 * frontmatter **body**. Returns the RFC 3339 string iff `done:` carries a valid
 * one, else `null` — so a user's own `done: yes` or `done: soon` leaves the note
 * incomplete rather than silently marking it finished.
 *
 * **Quoting does not demote the value.** The scalar is unquoted before the date
 * check, matching the existing quoting asymmetry in which quoting demotes
 * checkbox and number values but never dates — so this reader and the derived
 * property index (§3.6.4) agree on `done: "2026-08-01T09:00:00Z"`. A divergence
 * between the two would be a real bug: the note would read complete on one
 * surface and incomplete on another.
 *
 * First `done:` line wins, like every other managed-field reader here.
 */
export function readDoneFromFmBody(fmBody: string): string | null {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = DONE_KEY_RE.exec(line);
    if (m === null) continue;
    const value = extractTrashedScalar(m[2] ?? "");
    if (value !== null && isValidRfc3339(value)) return value;
    return null;
  }
  return null;
}

/** The canonical `kind:` value that marks a drawing note. Value-strict. */
export const DRAWING_KIND_VALUE = "drawing";

/** The canonical `kind:` value that marks a note-task (MYND-613). Value-strict. */
export const TASK_KIND_VALUE = "task";

/**
 * Every canonical `kind:` value. The field is a **value-strict enum**: anything
 * outside this set — quoted, capitalized, or unknown — reads as an ordinary note.
 */
export const CANONICAL_KIND_VALUES = [DRAWING_KIND_VALUE, TASK_KIND_VALUE] as const;

/** A canonical note class, or `null` for an ordinary markdown note. */
export type NoteKind = (typeof CANONICAL_KIND_VALUES)[number] | null;

/**
 * Set or clear the Myne-managed `kind:` frontmatter field. A canonical value
 * writes it (`kind: drawing`, `kind: task`); `null` deletes it (with empty-block
 * collapse). Touches only the `kind:` line, composing with `title:` /
 * `template:` / … without clobbering. Thin wrapper over
 * {@link patchFrontmatterField}.
 */
export function patchKindField(bytes: Uint8Array, kind: NoteKind): Uint8Array {
  return patchFrontmatterField(bytes, "kind", kind);
}

/**
 * Read the Myne-managed `kind:` marker, **value-strict**, from a frontmatter
 * **body** (the slice shape `loadNoteBatch` parses, identical to
 * {@link readTemplateFromFmBody}). Returns the canonical value iff a `kind:`
 * field carries it unquoted, else `null`. A user's own non-canonical `kind:`
 * (`"drawing"`, `Drawing`, `Task`, `chore`) reads as `null`, so a stray value
 * never force-renders a markdown note as a canvas nor files it as a task.
 *
 * **First `kind:` line wins**, deterministically: a note carrying two class
 * lines resolves on the first, exactly as it did before the enum widened.
 */
export function readKindFromFmBody(fmBody: string): NoteKind {
  const lines = fmBody.split(NEWLINE);
  for (const line of lines) {
    const m = KIND_KEY_RE.exec(line);
    if (m === null) continue;
    return canonicalKind(m[2] ?? "");
  }
  return null;
}

// Value-strict canonical check for a `kind:` scalar. Strips a trailing
// `# comment` and requires one of the literal unquoted canonical values; a
// quoted `"drawing"` is a YAML string, not the canonical marker, so it is
// rejected.
function canonicalKind(valuePortion: string): NoteKind {
  const commentM = /^([^#]*?)([ \t]+#.*)$/.exec(valuePortion);
  const raw = (commentM !== null ? (commentM[1] ?? "") : valuePortion).trim();
  return (CANONICAL_KIND_VALUES as readonly string[]).includes(raw)
    ? (raw as NonNullable<NoteKind>)
    : null;
}

// === patchFrontmatterField — generic keyed scalar surgery ===
//
// The key-parameterised generalisation of the per-field families above
// (`folder:` / `trashed:` / `title:`). Where those target a fixed Myne-managed
// canonical field, this writes an ARBITRARY user-authored scalar property — the
// write target for a saved view's cover image (the property NAME comes from the
// view's `image` setting, default `cover`), set without opening the note.
//
// The helper itself carries NO value-strict contract: it just round-trips a
// string through `formatYamlScalar`. That is true whatever key it is handed,
// including `cover`, which IS a Myne-managed canonical field
// (markdown-dialect.md §3.6.1) whose §3.6.1 Writer column points at
// `src/notes/setNoteCover.ts` calling straight through here, exactly as the
// `conflict:` / `conflict_of:` pair does. Value-strictness for those fields
// lives in their READERS, not in this writer. Same A/B/C/D states as
// `patchFolderField`. `value === null` deletes the field (with empty-block
// collapse).

// Build the `^(<indent><key><sep>)(value)$` matcher for an arbitrary property
// name. The key is a YAML property name (identifier-ish), but regex
// metacharacters are escaped defensively so a stray char can't widen the match.
function fmKeyRe(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^([ \\t]*${escaped}[ \\t]*:[ \\t]*)(.*)$`);
}

function applyStateAField(source: string, key: string, value: string): string {
  return (
    FRONTMATTER_OPENER +
    key + ": " + formatYamlScalar(value) + NEWLINE +
    FRONTMATTER_DELIMITER + NEWLINE +
    NEWLINE +
    source
  );
}

function applyStateBField(
  source: string,
  bodyEnd: number,
  key: string,
  value: string,
): string {
  const insert = key + ": " + formatYamlScalar(value) + NEWLINE;
  return source.substring(0, bodyEnd) + insert + source.substring(bodyEnd);
}

function applyStateCField(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  key: string,
  value: string,
): string | null {
  return applyStateCImpl(
    source,
    bodyStart,
    bodyEnd,
    fmKeyRe(key),
    formatYamlScalar,
    value,
  );
}

function deleteField(source: string, key: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return source;

  const keyRe = fmKeyRe(key);
  const fmBody = source.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx === -1) return source;

  const remaining = lines.slice(0, idx).concat(lines.slice(idx + 1));
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
 * Set, insert, or delete an arbitrary frontmatter scalar property `key`.
 * `value === null` deletes the field (states A/B/C set; state D delete with
 * empty-block collapse — same shape as `patchFolderField`). Used by
 * `setNoteCover` to write a saved view's cover-image reference without opening
 * the note.
 */
export function patchFrontmatterField(
  bytes: Uint8Array,
  key: string,
  value: string | null,
): Uint8Array {
  const source = utf8Decoder.decode(bytes);

  if (value === null) {
    return utf8Encoder.encode(deleteField(source, key));
  }

  const fm = locateFrontmatter(source);
  if (fm === null) {
    return utf8Encoder.encode(applyStateAField(source, key, value));
  }

  const stateCResult = applyStateCField(
    source,
    fm.bodyStart,
    fm.bodyEnd,
    key,
    value,
  );
  if (stateCResult !== null) {
    const before = source.substring(0, fm.bodyStart);
    const after = source.substring(fm.bodyEnd);
    return utf8Encoder.encode(before + stateCResult + after);
  }

  return utf8Encoder.encode(applyStateBField(source, fm.bodyEnd, key, value));
}
