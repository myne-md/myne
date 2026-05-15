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

const utf8Decoder = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

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
