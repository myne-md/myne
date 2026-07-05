// Skip-range assembly helper used by visitors that build text by
// gathering byte ranges to exclude (decoration markers, URLs, etc.)
// and concatenating the gaps between them.

export function assembleOutsideSkips(
  source: string,
  skipRanges: Array<[number, number]>,
  bounds: { start: number; end: number },
): string {
  skipRanges.sort((a, b) => a[0] - b[0]);
  let result = "";
  let cursor = bounds.start;
  for (const [start, end] of skipRanges) {
    if (cursor < start) result += source.substring(cursor, start);
    if (end > cursor) cursor = end;
  }
  if (cursor < bounds.end) result += source.substring(cursor, bounds.end);
  return result;
}
