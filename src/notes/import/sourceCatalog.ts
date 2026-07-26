// The import-source catalog (importer-breadth epic, MYND-586).
//
// ONE flow, five sources. Before this, three surfaces were Obsidian-named — the
// palette command `vault.import-obsidian`, Settings → Storage → Import (plus its
// settings-search index entry), and the one-time onboarding offer — and each would
// have had to multiply by five. Instead all three open the same flow, whose first
// step picks a source from this catalog.
//
// PER-SOURCE PRE-IMPORT DISCLOSURE lives here too (`survivesKey` / `losesKey`). That
// is the pre-import half of the epic's "fidelity bar per source, and how it is
// disclosed" question — stated BEFORE the user commits. The post-import half is the
// generated import-report note (MYND-585).
//
// Source names are used NOMINATIVELY ONLY — they say what the adapter reads. They are
// never productized as Myne feature names, the same discipline the `.base` import
// established.

export type ImportSourceId = "obsidian" | "notion" | "evernote" | "html" | "csv";

/** Whether the source is a directory tree or a single picked file. */
export type PickMode = "directory" | "file";

export interface ImportSourceSpec {
  readonly id: ImportSourceId;
  readonly pick: PickMode;
  /** Native-dialog file filter, for single-file sources. */
  readonly filter?: { readonly name: string; readonly extensions: readonly string[] };
  /** Icon name from the shared registry (`@myne/editor/host/lib/icons`). */
  readonly icon: string;
  /** i18n keys — resolved at render time, never frozen at module load. */
  readonly labelKey: string;
  /** One-line "what this is" for the picker card. The fuller keeps/loses detail
   *  renders on the setup step, where there is room for it. */
  readonly shortKey: string;
  readonly pickerTitleKey: string;
  readonly survivesKey: string;
  readonly losesKey: string;
  /** Search keywords so per-source discoverability survives having ONE entry point
   *  (typing "notion" still lands the user here) without five menu items that grow
   *  with every future adapter. */
  readonly keywords: readonly string[];
}

export const IMPORT_SOURCES: Readonly<Record<ImportSourceId, ImportSourceSpec>> = {
  obsidian: {
    id: "obsidian",
    icon: "book-open",
    pick: "directory",
    labelKey: "notes.import.source.obsidian.label",
    shortKey: "notes.import.source.obsidian.short",
    pickerTitleKey: "notes.import.source.obsidian.pickerTitle",
    survivesKey: "notes.import.source.obsidian.survives",
    losesKey: "notes.import.source.obsidian.loses",
    keywords: ["obsidian", "vault", "markdown"],
  },
  notion: {
    id: "notion",
    icon: "layout-grid",
    pick: "directory",
    labelKey: "notes.import.source.notion.label",
    shortKey: "notes.import.source.notion.short",
    pickerTitleKey: "notes.import.source.notion.pickerTitle",
    survivesKey: "notes.import.source.notion.survives",
    losesKey: "notes.import.source.notion.loses",
    keywords: ["notion", "export", "database"],
  },
  evernote: {
    id: "evernote",
    icon: "archive",
    pick: "file",
    filter: { name: "Evernote export", extensions: ["enex"] },
    labelKey: "notes.import.source.evernote.label",
    shortKey: "notes.import.source.evernote.short",
    pickerTitleKey: "notes.import.source.evernote.pickerTitle",
    survivesKey: "notes.import.source.evernote.survives",
    losesKey: "notes.import.source.evernote.loses",
    keywords: ["evernote", "enex"],
  },
  html: {
    id: "html",
    icon: "code",
    pick: "directory",
    labelKey: "notes.import.source.html.label",
    shortKey: "notes.import.source.html.short",
    pickerTitleKey: "notes.import.source.html.pickerTitle",
    survivesKey: "notes.import.source.html.survives",
    losesKey: "notes.import.source.html.loses",
    keywords: ["html", "web", "page"],
  },
  csv: {
    id: "csv",
    icon: "list",
    pick: "file",
    filter: { name: "CSV", extensions: ["csv"] },
    labelKey: "notes.import.source.csv.label",
    shortKey: "notes.import.source.csv.short",
    pickerTitleKey: "notes.import.source.csv.pickerTitle",
    survivesKey: "notes.import.source.csv.survives",
    losesKey: "notes.import.source.csv.loses",
    keywords: ["csv", "spreadsheet", "table"],
  },
};

/** Display order in the picker: most-requested migrations first. */
export const IMPORT_SOURCE_ORDER: readonly ImportSourceId[] = [
  "obsidian",
  "notion",
  "evernote",
  "html",
  "csv",
];

/** Every source keyword, for the palette command + settings-search index. */
export function allSourceKeywords(): string[] {
  return IMPORT_SOURCE_ORDER.flatMap((id) => [...IMPORT_SOURCES[id].keywords]);
}
