// Generated import-report note (importer-breadth epic, MYND-585).
//
// The disclosure mechanism for PER-ELEMENT fidelity loss. The shipped drop tallies
// (`ignore.canvasSkipped`, `media.omitted.<type>`, `BaseImportTally`) work only
// because Obsidian loss is enumerable at FILE granularity — a file imports or it is
// skipped. HTML→markdown loss is different in kind: a Notion page that loses a
// callout, a toggle, and coloured text still counts as `imported: 1`, so there is no
// honest integer to put in a summary row.
//
// WHY A GENERATED NOTE rather than a frontmatter marker (grill 2026-07-25 Q4/Q9):
//   - A persisted `import_lossy:` field would be a real `markdown-dialect.md` §3.6
//     value-strict field plus a §6 round-trip clause, a glossary entry, and a
//     decisions entry — and it would mark every affected note permanently, leaving
//     the user to clean 400 notes.
//   - A modal-only list is unrecoverable the moment it is dismissed, which on a
//     3 000-page import is the same as never reporting it.
//   - An ordinary note carries ZERO spec impact (created through the existing
//     `note_create` path), survives the session, is deletable in one action, and is
//     navigable via the wikilinks Myne already has.
//
// Wikilinks resolve by TITLE, so each row also carries the folder the note was filed
// under — without it, a title that collided during dedup would link ambiguously.

import type { ImportResult } from "./engine";
import type { ImportSourceId, LossyNote } from "./source";

/** Human-facing labels for the construct names adapters report. */
const LABELS: Readonly<Record<string, string>> = {
  "csv-columns-truncated": "columns beyond the table limit were dropped",
  "csv-rows-truncated": "rows beyond the table limit were dropped",
  "empty-csv": "the file held no readable rows",
  "empty-table": "a table had no usable rows",
  "enex-malformed-enml": "the note body was malformed and was read leniently",
  "enex-note-missing": "the note could not be read",
  "evernote-attachment": "an attachment could not be brought across",
  "evernote-encrypted-block": "an Evernote-encrypted block was preserved but not decrypted",
  "notion-property-name-illegal": "a property name could not become a field",
  "notion-unresolved-link": "a link target could not be found",
  underline: "underline formatting has no equivalent",
  "unsafe-url": "a link address was not a safe web address",
};

function label(name: string): string {
  return LABELS[name] ?? name;
}

/** The source's user-facing name. Nominative only — never a Myne feature name. */
const SOURCE_LABEL: Readonly<Record<ImportSourceId, string>> = {
  csv: "CSV",
  evernote: "Evernote",
  html: "HTML",
  notion: "Notion",
  obsidian: "Obsidian",
};

/**
 * A stable, unique title for the report note.
 *
 * Uniqueness is load-bearing: the report is itself a note, so a fixed title would
 * collide with the previous run's report in the dedup identity set and a re-import
 * would either skip writing it or duplicate it. The timestamp is passed in rather
 * than read here so the function stays pure and testable.
 */
export function reportTitle(source: ImportSourceId, stamp: string): string {
  return `Import report (${SOURCE_LABEL[source]}) ${stamp}`;
}

/** `YYYY-MM-DD HH.MM` — colon-free so the title is legal on every platform. */
export function formatStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}.${p(date.getMinutes())}`
  );
}

function rows(lossy: readonly LossyNote[]): string[] {
  return lossy.map((n) => {
    const where = n.folder === null || n.folder.length === 0 ? "vault root" : n.folder;
    const what = n.dropped.map(label).join("; ");
    return `- [[${n.title}]] in \`${where}\`: ${what}`;
  });
}

/**
 * Build the report note's markdown, or `null` when there is nothing to report.
 *
 * Returning `null` on a clean import is deliberate: a report note that only ever says
 * "nothing to report" trains the user to ignore it, and then the one that matters gets
 * ignored too.
 */
export function buildImportReport(
  source: ImportSourceId,
  result: ImportResult,
  stamp: string,
): string | null {
  const lossy = result.lossyNotes;
  if (lossy.length === 0) return null;

  const title = reportTitle(source, stamp);
  const affected = lossy.length;
  const constructs = new Set<string>();
  for (const n of lossy) for (const d of n.dropped) constructs.add(d);

  const lines: string[] = [
    "---",
    `title: ${title}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Myne imported ${result.imported} ${result.imported === 1 ? "note" : "notes"} from ` +
      `${SOURCE_LABEL[source]}. **${affected}** of them arrived with something the Myne ` +
      `format has no place for, listed below. Your original files were not changed.`,
    "",
    "You can delete this note once you have looked through it.",
    "",
    "## What could not come across",
    "",
    ...[...constructs].sort().map((c) => `- ${label(c)}`),
    "",
    "## Notes to check",
    "",
    ...rows(lossy),
    "",
  ];
  return lines.join("\n");
}
