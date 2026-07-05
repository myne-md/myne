// `<CMEditor>` — minimal React wrapper around CodeMirror 6's `EditorView`.
//
// Per `editor-mvp-baseline` PRD (myne-agents/features/editor-mvp-baseline/prd.md)
// + grill `myne-agents/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md`:
// custom ~30-LOC wrapper, NOT `@uiw/react-codemirror`. The trade is ~30 LOC
// of code-we-own against ~6 transitive packages and the wrong-palette
// `theme-one-dark` that doesn't fit Myne's design system.
//
// Contract: `value` / `onChange` / `onBlur` mirrors the `<textarea>` that
// this swap replaces (`src/screens/Editor.tsx` `<CenterPane>`), so the
// surrounding `useAutosave` + sidebar refresh + Tauri listeners survive
// the swap unchanged.

import { useEffect, useRef, type CSSProperties } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diffDoc } from "./doc-diff";
import { myneExtensions, reconfigureAi } from "./extensions";
import { selectedRangesText } from "./selectionText";
import { reconfigureNoteSet } from "./wikilink/note-set";
import { reconfigureVaultHeadings } from "./wikilink/vault-headings";
import type { VaultHeading } from "./wikilink/vault-headings";
import { reconfigureLineNumbers } from "./line-numbers";
import { reconfigureViewMode, type ViewMode } from "./view-mode";
import { resolveAnchorOffset, type WikilinkAnchor } from "./wikilink/anchor";
import type { ResolverNote } from "@myne/editor/host/notes/resolveWikilink";

/** A deep-link scroll request (MYND-305, SYNC-5): a generic anchor to scroll to
 *  AFTER the note body settles, plus a monotonic `nonce` so re-clicking the same
 *  anchor re-fires. `null` = no pending scroll. */
export type ScrollAnchorRequest = { anchor: WikilinkAnchor; nonce: number } | null;

export type CMEditorProps = {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  /** Selection observer (MYND-339): the concatenated non-empty selection
   *  ranges (joined by `\n`), or `""` when nothing is selected. Fired on every
   *  selection or document change so selection-scoped document statistics stay
   *  live. Ref-backed like `onChange` — no view rebuild. */
  onSelectionChange?: (selectedText: string) => void;
  /** Composed alongside `myneExtensions`. v0 baseline does not use this. */
  extensions?: readonly Extension[];
  /** WL-5: the live resolver note-set. Pushed into the editor's note-set
   *  compartment (re-mount-free) whenever it changes, so the wikilink chip's
   *  broken-link resolution + hover R1 stay live on the SYNC-5 nonce (WL-6). */
  noteSet?: readonly ResolverNote[];
  /** MYND-305: the vault-wide heading set the `[[##` autocomplete searches.
   *  Pushed into the editor's vault-headings compartment (re-mount-free) like
   *  `noteSet`. Optional — when absent, `[[##` simply finds nothing. */
  vaultHeadings?: readonly VaultHeading[];
  /** Called when a resolved wikilink chip is clicked (the workspace opens the
   *  target note). The chip emits a `myne-open-wikilink` event; this relays it.
   *  MYND-305: `anchor` carries the GENERIC `#heading` / `^block-id` deep-link
   *  target (SYNC-5) so the host can request a post-load scroll. */
  onOpenWikilink?: (noteUuid: string, anchor: WikilinkAnchor | null) => void;
  /** MYND-305 deep-link scroll: when set, the editor resolves the anchor against
   *  its (loaded) body and scrolls to it; a not-found anchor stays at the top
   *  (§5.6 fallback). Re-fires whenever `nonce` changes, and retries once the
   *  body settles (`value` change) so the click→scroll never races the async
   *  note load. */
  scrollAnchor?: ScrollAnchorRequest;
  /** editor-line-numbers (MYND-314): show the line-number gutter. Pushed into
   *  the editor's line-number compartment (re-mount-free) whenever it changes,
   *  so toggling the `editor_line_numbers` pref updates the open note live while
   *  preserving cursor / scroll / undo. Defaults OFF (prose-first). */
  lineNumbers?: boolean;
  /** reading-source-modes (MYND-299): the per-tab view mode. `live` (default) is
   *  today's live-preview; `reading` renders read-only; `source` shows raw
   *  markdown. Pushed into the view-mode compartments (re-mount-free) whenever it
   *  changes, so switching preserves cursor / scroll / undo and never mutates the
   *  buffer (§6 C1). */
  viewMode?: ViewMode;
  readOnly?: boolean;
  /** Surface the AI slash commands (`/devam`, `/başlık`) in the menu — the
   *  `ai_enabled` pref (MYP1). Default false; read at mount (writing-assistant
   *  task 6). Never set on the reading-view instance (inert in Reading view). */
  aiEnabled?: boolean;
  style?: CSSProperties;
};

export function CMEditor(props: CMEditorProps) {
  const { value, onChange, onBlur, onSelectionChange, extensions, noteSet, vaultHeadings, onOpenWikilink, scrollAnchor = null, lineNumbers = false, viewMode = "live", readOnly = false, aiEnabled = false, style } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  useEffect(() => {
    onOpenWikilinkRef.current = onOpenWikilink;
  }, [onOpenWikilink]);

  // Keep callback refs current so the EditorView's update listener closes
  // over the latest props without rebuilding the view.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  // Mount + destroy lifecycle. The view is built once; subsequent `value`
  // changes from outside are mirrored via `dispatch` in the effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          ...myneExtensions({ viewMode, readOnly, aiEnabled }),
          ...(extensions ?? []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              onSelectionChangeRef.current?.(selectedRangesText(update.state));
            }
          }),
          EditorView.domEventHandlers({
            blur: () => {
              onBlurRef.current?.();
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;

    // The self-hosted web fonts (Inter / JetBrains Mono) finish loading AFTER
    // the editor's first paint; their metrics change line + block-widget heights,
    // which can leave CM6's height map stale and drift the click→position mapping
    // across the WHOLE document (the "clicks land one line lower, everywhere"
    // symptom). Re-measure once fonts settle. Guarded so a torn-down view is a
    // no-op (viewRef is nulled on destroy).
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (viewRef.current === view) view.requestMeasure();
      });
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally empty deps — the view is mounted once. Prop changes
    // flow through the controlled-component mirror effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled-component mirror: if `value` changes from outside, dispatch
  // a MINIMAL change (longest-common-prefix + suffix diff) so the cursor
  // stays anchored in the body when the change is localized to the
  // frontmatter `updated:` timestamp (autosave-driven), or otherwise to
  // any region outside the user's current selection.
  //
  // A full doc replacement (`{from: 0, to: docLength, insert: value}`)
  // would land the cursor at position 0 after every autosave, since CM6
  // doesn't infer how to map cursor across an indiscriminate replace.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const diff = diffDoc(view.state.doc.toString(), value);
    if (diff === null) return;
    view.dispatch({ changes: diff });
  }, [value]);

  // WL-5: push the live note-set into the view's note-set compartment whenever
  // it changes (re-mount-free reconfigure). `useResolverNotes()` re-derives on
  // the SYNC-5 nonce, so a note created/renamed/deleted elsewhere re-resolves
  // every wikilink chip live (WL-6) without a remount or a note-switch.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || noteSet === undefined) return;
    view.dispatch({ effects: reconfigureNoteSet(noteSet) });
  }, [noteSet]);

  // MYND-305: push the vault-wide heading set into the view's compartment (same
  // re-mount-free pattern as the note-set) so the `[[##` picker searches it.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || vaultHeadings === undefined) return;
    view.dispatch({ effects: reconfigureVaultHeadings(vaultHeadings) });
  }, [vaultHeadings]);

  // editor-line-numbers (MYND-314): push the line-number gutter toggle into the
  // view's line-number compartment whenever the `editor_line_numbers` pref
  // changes (re-mount-free reconfigure — cursor / scroll / undo preserved). The
  // compartment is seeded OFF at mount, so this runs once on mount to honor an
  // already-on pref, then on every subsequent toggle.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureLineNumbers(lineNumbers) });
  }, [lineNumbers]);

  // reading-source-modes (MYND-299): push the per-tab view mode into the
  // view-mode compartments whenever it (or readOnly) changes — re-mount-free, so
  // switching live/reading/source preserves cursor / scroll / undo and never
  // mutates the buffer. Seeded at mount, so this runs once then on every switch.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureViewMode(viewMode, readOnly) });
  }, [viewMode, readOnly]);

  // local-ai (SYNC-14): push the live `ai_enabled` (ANDed with the not-excluded
  // gate the host passes) into the AI compartment whenever it changes — so
  // turning AI off, or opening a note in an excluded folder, immediately tears
  // down ghost-text + the AI slash commands instead of leaving them live-feeding
  // note content to the model. Seeded at mount, so this runs once then on toggle.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureAi(aiEnabled) });
  }, [aiEnabled]);

  // MYND-305 deep-link scroll (SYNC-5). Keyed on BOTH the request nonce and
  // `value`: the click sets the request, but the target note's body arrives
  // asynchronously via the `value`-mirror effect above — so the scroll attempt
  // re-runs when the body settles and lands on the heading then. A request whose
  // anchor resolves to no offset (heading renamed/deleted, marker absent) leaves
  // the editor at the top (§5.6 not-found fallback). The applied nonce is
  // remembered so a settled-body re-run doesn't yank the cursor back after the
  // user has scrolled away; a NEW click (fresh nonce) re-arms it.
  const appliedScrollNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || scrollAnchor === null) return;
    if (appliedScrollNonceRef.current === scrollAnchor.nonce) return;
    const body = view.state.doc.toString();
    const offset = resolveAnchorOffset(body, scrollAnchor.anchor);
    if (offset === null) {
      // Body may not have loaded yet (anchor not present) — wait for the next
      // `value` change to retry. If the note is loaded and the anchor genuinely
      // doesn't exist, the retry stays a no-op and the editor keeps its top
      // position (the §5.6 fallback). Either way, don't mark this nonce applied.
      return;
    }
    appliedScrollNonceRef.current = scrollAnchor.nonce;
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "start" }),
    });
  }, [scrollAnchor, value]);

  // Relay the chip click-to-navigate event (dispatched on the editor DOM by the
  // wikilink chip extension) to the `onOpenWikilink` callback.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{
        noteUuid: string;
        anchor: WikilinkAnchor | null;
      }>).detail;
      if (detail?.noteUuid) {
        onOpenWikilinkRef.current?.(detail.noteUuid, detail.anchor ?? null);
      }
    };
    host.addEventListener("myne-open-wikilink", handler);
    return () => host.removeEventListener("myne-open-wikilink", handler);
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid="editor.content"
      style={style ?? { width: "100%", minHeight: 360 }}
    />
  );
}
