// The four per-note export formats, declared ONCE.
//
// They used to be spelled out twice, four rows in the editor's "…" menu
// (`screens/Editor.tsx`) and four more in the sidebar row's context menu
// (`components/NoteList.tsx`): eight rows, eight i18n keys and eight call sites
// for four actions, in two files that have to be edited together with nothing
// saying so.
//
// The two copies had already drifted, which is the argument for this module
// rather than a tidiness one. Only the sidebar gated the PDF row behind the
// `pdfExport` capability, and the command palette gates the same action through
// its own `ACTION_CAPABILITY` table, so on a host without PDF export the "…"
// menu was the one surface still offering it. A menu that offers what the
// platform cannot do is the failure `src/CLAUDE.md` names under the platform
// seam: omit the affordance, never show it broken.
//
// Two exports rather than one, because the two surfaces differ in exactly one
// respect and it is not the list. The sidebar holds the export UI hooks and
// fires the shared flow directly; the editor's "…" menu reaches the same flows
// through `CommandContext`, which also closes the palette on the way. So
// `noteExportFormats` is the part they share (which formats exist, what each is
// called, when one is absent) and `noteExportEntries` adds the runner for the
// surface that can supply hooks. What neither shares is the ROW type: an
// anchored dropdown and a menu placed at a click are different components.

import { has as hasCapability } from "../platform/capabilities";
import {
  noteExportOptions,
  runNoteExportFlow,
  runNoteHtmlExportFlow,
  runNotePdfExportFlow,
  runNoteTxtExportFlow,
  type NoteExportUiHooks,
} from "./exportFlow";

/** One format offered under a surface's "Export…" row. */
export interface NoteExportFormat {
  /** Stable discriminator, surfaced as the row's `data-*` id (E2E + React key).
   *  Unchanged from the ids both menus already used, so existing selectors keep
   *  resolving. */
  id: "export-markdown" | "export-pdf" | "export-html" | "export-txt";
  /** i18n key for the format's own name ("Markdown", "PDF", …). The surfaces no
   *  longer each carry a full "Export as Markdown…" sentence, because the parent
   *  row has already said "Export". */
  labelKey: string;
}

/**
 * The formats this host can produce, in menu order.
 *
 * Computed per call rather than frozen at module scope: `hasCapability` is a
 * host answer, and a module-level constant would pin whichever host loaded the
 * bundle first.
 */
export function noteExportFormats(): NoteExportFormat[] {
  const formats: NoteExportFormat[] = [
    { id: "export-markdown", labelKey: "notes.export.markdown" },
  ];
  // Omitted, not disabled, where the host cannot render one.
  if (hasCapability("pdfExport")) {
    formats.push({ id: "export-pdf", labelKey: "notes.export.pdf" });
  }
  formats.push(
    { id: "export-html", labelKey: "notes.export.html" },
    { id: "export-txt", labelKey: "notes.export.txt" },
  );
  return formats;
}

/** A format plus the flow that performs it. */
export interface NoteExportEntry extends NoteExportFormat {
  run: () => void;
}

/**
 * {@link noteExportFormats}, each bound to its flow, for a surface holding the
 * export UI hooks.
 *
 * `options()` is re-evaluated inside each runner rather than hoisted: the flows
 * fire long after this list is built (a menu can sit open), and a hoisted value
 * would carry the title the cache held at BUILD time.
 */
export function noteExportEntries(
  noteId: string,
  title: string | null,
  // Optional, mirroring `noteExportOptions`, which defaults each hook to a
  // no-op. A surface can legitimately hold none: `NoteList` takes `exportHooks`
  // as an optional prop, so requiring it here would have made the sidebar menu
  // impossible to build in exactly the case the flow already handles.
  hooks?: NoteExportUiHooks,
): NoteExportEntry[] {
  const options = (): ReturnType<typeof noteExportOptions> =>
    noteExportOptions(noteId, title, hooks);
  const runners: Record<NoteExportFormat["id"], () => void> = {
    "export-markdown": () => void runNoteExportFlow(options()),
    "export-pdf": () => void runNotePdfExportFlow(options()),
    "export-html": () => void runNoteHtmlExportFlow(options()),
    "export-txt": () => void runNoteTxtExportFlow(options()),
  };
  return noteExportFormats().map((format) => ({
    ...format,
    run: runners[format.id],
  }));
}
