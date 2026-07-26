// CSV reader for the CSV import adapter (importer-breadth epic, MYND-584).
//
// A small RFC-4180 parser rather than a dependency: the format is ~40 lines done
// right, and `CLAUDE.md` treats every added dependency as a security decision. The
// cases that matter and that a naive `split(",")` gets wrong are all covered —
// quoted fields, embedded commas, embedded newlines, and the `""` escape.
//
// Delimiter is a comma. Notion's database export is comma-delimited, which is the
// source this adapter exists for; a semicolon-delimited European export is a
// documented non-goal rather than a silent mis-parse (every line would become one
// single-column row, which the caller's row/column counts make obvious).

/** Longest field a single cell may carry before it is truncated (RAM bound). */
const MAX_FIELD_CHARS = 64 * 1024;

/**
 * Parse CSV text into rows of fields. Never throws: malformed input (an unclosed
 * quote, a stray quote inside a bare field) degrades to a best-effort read rather
 * than losing the file, matching the importer's accepted-lossy posture.
 *
 * A trailing newline does not produce a final empty row. A completely empty input
 * yields no rows.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field.length > MAX_FIELD_CHARS ? field.slice(0, MAX_FIELD_CHARS) : field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    // A single empty field is an empty line, not a row.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  // Strip a UTF-8 BOM: Notion and Excel both emit one, and left in place it
  // becomes part of the first header cell.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // the "" escape
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field.length === 0) {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // CRLF or a lone CR both end the record.
      pushRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Flush the last record when the file does not end with a newline. An unclosed
  // quote lands here too — its partial field is kept rather than discarded.
  if (field.length > 0 || row.length > 0) pushRow();

  return rows;
}
