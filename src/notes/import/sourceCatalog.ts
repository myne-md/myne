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

import { has, type Capability } from "../../platform/capabilities";

export type ImportSourceId =
  | "obsidian"
  | "notion"
  | "evernote"
  | "html"
  | "csv"
  | "myne";

/**
 * How the user names the source.
 *
 * The Myne source used to be a `"vault"` mode (pick one of this device's other
 * vaults from the list the app keeps); since myne-md/myne#816 it is a `"file"`
 * mode that takes a `.myne-backup`, so the former variant is gone.
 */
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
  /**
   * A platform capability this source needs. Absent means every client has it.
   *
   * A source whose capability is missing is OMITTED, not disabled: a greyed
   * card is an offer the platform cannot honour, and `decisions.md` 2026-07-26
   * makes omission the normative answer to that shape. It also keeps the
   * keyword out of `allSourceKeywords()`, so the palette and the settings
   * search do not route a user to a card that is not there.
   */
  readonly capability?: Capability;
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
  myne: {
    id: "myne",
    icon: "vault",
    // A `.myne-backup` file, not a local vault (myne-md/myne#816). The card used
    // to list this device's other vaults; it now takes an externally exported
    // backup, which is the artifact a user actually moved between machines.
    pick: "file",
    filter: { name: "Myne backup", extensions: ["myne-backup"] },
    // Desktop only. A browser origin holds one container under a constant vault
    // id, so the source list would be permanently empty, and the `importer:`
    // plugin is `Class::Unsupported` there in any case. See the capability's own
    // entry for the second reason, which the runtime flag alone cannot deliver.
    capability: "vaultImport",
    labelKey: "notes.import.source.myne.label",
    shortKey: "notes.import.source.myne.short",
    pickerTitleKey: "notes.import.source.myne.pickerTitle",
    survivesKey: "notes.import.source.myne.survives",
    losesKey: "notes.import.source.myne.loses",
    keywords: ["myne", "vault", "merge", "combine", "consolidate"],
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
  // First, and not by seniority: this is the only source whose format is
  // Myne's own, and a user with two vaults looking for how to combine them has
  // nowhere else in the product to look.
  "myne",
  "obsidian",
  "notion",
  "evernote",
  "html",
  "csv",
];

/**
 * The sources this platform can actually offer, in display order.
 *
 * The ONE place the capability filter is applied, so every consumer of the
 * source list sees the same set. Today that is the picker
 * (`ImportSourcePicker.tsx`) and `allSourceKeywords()` below.
 *
 * The first version of this comment claimed the filter kept the picker, the
 * command palette and the settings-search index in agreement. It does not, and
 * saying so was worse than saying nothing: `allSourceKeywords()` has no
 * production caller at all, so neither of those two surfaces consumes this list
 * in the first place. The filter is still the right shape, and the claim it
 * made about the system was not checkable.
 */
export function availableSourceOrder(): readonly ImportSourceId[] {
  return IMPORT_SOURCE_ORDER.filter((id) => {
    const cap = IMPORT_SOURCES[id].capability;
    return cap === undefined || has(cap);
  });
}

/**
 * Every keyword of every source this platform offers.
 *
 * **No production caller today.** It was written for the command palette and
 * the settings-search index, and neither consumes it: the palette reaches the
 * importer through one action with its own keywords, and the settings-search
 * registry holds its own. Kept rather than deleted because it is the correct
 * shape for both, and because it is the derived half of a list a future caller
 * must not re-filter by hand; the honest version of that is this sentence
 * rather than a comment naming callers that do not exist.
 */
export function allSourceKeywords(): string[] {
  return availableSourceOrder().flatMap((id) => [...IMPORT_SOURCES[id].keywords]);
}
