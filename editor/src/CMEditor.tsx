// `<CMEditor>` — minimal React wrapper around CodeMirror 6's `EditorView`.
//
// Per `editor-mvp-baseline` PRD (agent-tooling/features/editor-mvp-baseline/prd.md)
// + grill `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md`:
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
import { reconfigureVaultBlockAnchors } from "./wikilink/vault-block-anchors";
import type { VaultBlockAnchor } from "./wikilink/vault-block-anchors";
import { reconfigureLineNumbers } from "./line-numbers";
import { reconfigureVim } from "./vim";
import { reconfigureViewMode, type ViewMode } from "./view-mode";
import { resolveAnchorRange, type WikilinkAnchor } from "./wikilink/anchor";
import type { ResolverNote } from "@myne/editor/host/notes/resolveWikilink";

/** A deep-link scroll request (MYND-305, SYNC-5): a generic anchor to scroll to
 *  AFTER the note body settles, plus a monotonic `nonce` so re-clicking the same
 *  anchor re-fires. `null` = no pending scroll. */
export type ScrollAnchorRequest = { anchor: WikilinkAnchor; nonce: number } | null;

/**
 * Persistent-view swap API (MYND-534). Handed to a host via `onSwapReady` so it
 * can reuse ONE long-lived `EditorView` across note switches instead of
 * remounting per note — preserving per-note undo history + selection. The host
 * (desktop `PaneView`) owns the per-note `EditorState` cache and drives:
 *
 *   1. before leaving note A: `captureState()` → cache it (with A's scroll).
 *   2. entering note B: `applyState(cached.state)` if cached (instant, no re-read),
 *      else `applyState(buildState(bodyOfB))` for a first open.
 *
 * `applyState` does `view.setState(...)` (which resets ALL compartments to their
 * seeded defaults) then re-applies the CURRENT compartment config (view-mode,
 * line-numbers, note-set, vault-headings/anchors, AI) — so a config change made
 * while a note was backgrounded is reflected on return. Scroll lives on the host's
 * OUTER scroller (the CM view grows to fit), so scroll capture/restore is the
 * host's job, not this API's.
 *
 * Opt-in: only wired when `onSwapReady` is set. Consumers that don't set it
 * (mobile, the read-only reading companion) keep the plain controlled-`value`
 * mirror unchanged.
 */
export type EditorSwapApi = {
  /** Snapshot the current note's full state (doc + history + selection). */
  captureState: () => EditorState;
  /** Build a fresh `EditorState` for `doc` with the full myne extension set +
   *  this instance's ref-routed listeners (so a swapped-in state never carries a
   *  stale callback). Used for a first-open (uncached) note. */
  buildState: (doc: string) => EditorState;
  /** Swap `state` into the live view (`setState`) and re-apply current
   *  compartment config. Does NOT touch the host's scroller. */
  applyState: (state: EditorState) => void;
};

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
  /** MYND-382: the vault-wide imported-block-anchor set the `[[^^` enumerate-only
   *  autocomplete searches. Pushed into the vault-block-anchors compartment
   *  (re-mount-free) like `vaultHeadings`. Optional — when absent, `[[^^` finds
   *  nothing. */
  vaultBlockAnchors?: readonly VaultBlockAnchor[];
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
  /** vim-keyboard-mode (MYND-313): make the editor modal (normal/insert/visual).
   *  Pushed into the editor's vim compartment (re-mount-free) whenever it
   *  changes, so toggling the `editor_vim_mode` pref updates the open note live
   *  while preserving cursor / scroll / undo. The engine is dynamically imported
   *  on first enable, so leaving this off costs nothing at all. Defaults OFF. */
  vimMode?: boolean;
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
  /** Mount the floating selection toolbar that appears over a text selection
   *  (MYND-559). Default TRUE — desktop's formatting surface, unchanged. A host
   *  that renders its own bar via {@link onReady} passes `false` so the two don't
   *  stack: mobile's above-keyboard `FormatBar` offers the same commands, so the
   *  floating toolbar was pure duplication there. Read at MOUNT (a host's choice
   *  is a platform constant, not a live pref) — unlike `viewMode` / `aiEnabled`,
   *  it has no reconfigure compartment. */
  selectionToolbar?: boolean;
  style?: CSSProperties;
  /** Called once with the live `EditorView` after mount (and `null` on unmount).
   *  Lets a host render its own toolbar/accessory bar that drives the editor
   *  through the shared `editorCommands` (the mobile above-keyboard bar).
   *
   *  Independent of `selectionToolbar`, NOT coupled to it: desktop sets this (for
   *  outline scroll-tracking in `PaneView`) while keeping the floating toolbar.
   *  The pairing worth knowing is the other direction — a host that sets this in
   *  order to render its OWN formatting surface is the one that also wants
   *  `selectionToolbar: false`, so it does not end up with two (mobile, MYND-559). */
  onReady?: (view: EditorView | null) => void;
  /** MYND-534: hand a host the persistent-view swap API after mount (`null` on
   *  unmount). When set, the host drives note switches via `captureState` /
   *  `buildState` / `applyState` on ONE long-lived view instead of remounting per
   *  note, preserving per-note undo + selection. Opt-in — leaving it unset keeps
   *  the plain controlled-`value` behaviour (mobile, reading companion). */
  onSwapReady?: (api: EditorSwapApi | null) => void;
};

export function CMEditor(props: CMEditorProps) {
  const { value, onChange, onBlur, onSelectionChange, extensions, noteSet, vaultHeadings, vaultBlockAnchors, onOpenWikilink, scrollAnchor = null, lineNumbers = false, vimMode = false, viewMode = "live", readOnly = false, aiEnabled = false, selectionToolbar = true, style, onReady, onSwapReady } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const onReadyRef = useRef(onReady);
  const onSwapReadyRef = useRef(onSwapReady);
  // MYND-534: config refs so `buildState` / `applyState` (called imperatively by
  // the host, outside React's render) read the CURRENT compartment config rather
  // than a value frozen at mount. Kept live by the reconfigure effects below.
  const extensionsRef = useRef(extensions);
  const noteSetRef = useRef(noteSet);
  const vaultHeadingsRef = useRef(vaultHeadings);
  const vaultBlockAnchorsRef = useRef(vaultBlockAnchors);
  const lineNumbersRef = useRef(lineNumbers);
  const viewModeRef = useRef(viewMode);
  const readOnlyRef = useRef(readOnly);
  const aiEnabledRef = useRef(aiEnabled);
  const vimModeRef = useRef(vimMode);
  useEffect(() => {
    onSwapReadyRef.current = onSwapReady;
  }, [onSwapReady]);
  useEffect(() => {
    extensionsRef.current = extensions;
  }, [extensions]);
  useEffect(() => {
    onOpenWikilinkRef.current = onOpenWikilink;
  }, [onOpenWikilink]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

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

    // Shared extension pieces + a single `makeState` closure, so the mount state
    // AND every note state built later via the swap API (`buildState`) come from
    // ONE source — no drift (MYND-534). Both listeners close over refs, so a
    // cached state built earlier never carries a stale callback after a swap.
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        onSelectionChangeRef.current?.(selectedRangesText(update.state));
      }
    });
    const blurHandler = EditorView.domEventHandlers({
      blur: () => {
        onBlurRef.current?.();
      },
    });
    const makeState = (doc: string): EditorState =>
      EditorState.create({
        doc,
        extensions: [
          ...myneExtensions({
            viewMode: viewModeRef.current,
            readOnly: readOnlyRef.current,
            aiEnabled: aiEnabledRef.current,
            // Mount-read, ref-free on purpose (MYND-559): a host's formatting
            // surface is a platform constant, so every state this view ever
            // builds — mount or post-swap — carries the SAME choice.
            selectionToolbar,
          }),
          ...(extensionsRef.current ?? []),
          updateListener,
          blurHandler,
        ],
      });

    // Re-apply every compartment to its CURRENT prop value. `view.setState(...)`
    // resets compartments to the myneExtensions seed, so after a swap we push the
    // live config back in — a viewMode / line-numbers / note-set / AI change made
    // while a note was backgrounded is reflected on return. Mirrors the per-prop
    // reconfigure effects above (kept as separate dispatches for the same reason).
    const reapplyCompartments = (v: EditorView): void => {
      v.dispatch({ effects: reconfigureLineNumbers(lineNumbersRef.current) });
      v.dispatch({ effects: reconfigureViewMode(viewModeRef.current, readOnlyRef.current) });
      v.dispatch({ effects: reconfigureAi(aiEnabledRef.current) });
      if (noteSetRef.current !== undefined) {
        v.dispatch({ effects: reconfigureNoteSet(noteSetRef.current) });
      }
      if (vaultHeadingsRef.current !== undefined) {
        v.dispatch({ effects: reconfigureVaultHeadings(vaultHeadingsRef.current) });
      }
      if (vaultBlockAnchorsRef.current !== undefined) {
        v.dispatch({ effects: reconfigureVaultBlockAnchors(vaultBlockAnchorsRef.current) });
      }
      // MYND-534 × MYND-313: the vim layer is a compartment too, and it is seeded
      // OFF (`vimExtension()` → `vimCompartment.of([])`), so a `setState` swap
      // silently drops it — and the `[vimMode]` effect will NOT re-fire, because
      // the prop never changed. Without this line, turning vim on and then
      // switching notes leaves the user back in plain insert mode. Async by
      // nature (the engine is dynamically imported); `reconfigureVim` carries its
      // own last-call-wins generation guard, so firing it here is safe.
      void reconfigureVim(v, vimModeRef.current);
    };

    const view = new EditorView({ state: makeState(value), parent: host });
    viewRef.current = view;
    // Hand the live view to a host toolbar (mobile accessory bar); desktop no-op.
    onReadyRef.current?.(view);
    // MYND-534: hand the host the persistent-view swap API (opt-in). The host
    // (desktop PaneView) owns the per-note EditorState cache and drives switches
    // through this instead of remounting the view.
    onSwapReadyRef.current?.({
      captureState: () => view.state,
      buildState: (doc: string) => makeState(doc),
      applyState: (state: EditorState) => {
        view.setState(state);
        reapplyCompartments(view);
      },
    });

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
      onReadyRef.current?.(null);
      onSwapReadyRef.current?.(null);
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
    noteSetRef.current = noteSet;
    const view = viewRef.current;
    if (view === null || noteSet === undefined) return;
    view.dispatch({ effects: reconfigureNoteSet(noteSet) });
  }, [noteSet]);

  // MYND-305: push the vault-wide heading set into the view's compartment (same
  // re-mount-free pattern as the note-set) so the `[[##` picker searches it.
  useEffect(() => {
    vaultHeadingsRef.current = vaultHeadings;
    const view = viewRef.current;
    if (view === null || vaultHeadings === undefined) return;
    view.dispatch({ effects: reconfigureVaultHeadings(vaultHeadings) });
  }, [vaultHeadings]);

  // MYND-382: push the vault-wide imported-block-anchor set into the view's
  // compartment (same re-mount-free pattern) so the `[[^^` picker searches it.
  useEffect(() => {
    vaultBlockAnchorsRef.current = vaultBlockAnchors;
    const view = viewRef.current;
    if (view === null || vaultBlockAnchors === undefined) return;
    view.dispatch({ effects: reconfigureVaultBlockAnchors(vaultBlockAnchors) });
  }, [vaultBlockAnchors]);

  // editor-line-numbers (MYND-314): push the line-number gutter toggle into the
  // view's line-number compartment whenever the `editor_line_numbers` pref
  // changes (re-mount-free reconfigure — cursor / scroll / undo preserved). The
  // compartment is seeded OFF at mount, so this runs once on mount to honor an
  // already-on pref, then on every subsequent toggle.
  useEffect(() => {
    lineNumbersRef.current = lineNumbers;
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureLineNumbers(lineNumbers) });
  }, [lineNumbers]);

  // reading-source-modes (MYND-299): push the per-tab view mode into the
  // view-mode compartments whenever it (or readOnly) changes — re-mount-free, so
  // switching live/reading/source preserves cursor / scroll / undo and never
  // mutates the buffer. Seeded at mount, so this runs once then on every switch.
  useEffect(() => {
    viewModeRef.current = viewMode;
    readOnlyRef.current = readOnly;
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureViewMode(viewMode, readOnly) });
  }, [viewMode, readOnly]);

  // vim-keyboard-mode (MYND-313): push the live `editor_vim_mode` pref into the
  // vim compartment whenever it changes. Unlike the compartments above this is
  // ASYNC — the engine is dynamically imported on first enable — so the helper
  // owns its own last-call-wins guard rather than this effect trying to cancel.
  // Errors are swallowed deliberately: a failed chunk load must leave the plain
  // editor working, not break the note.
  useEffect(() => {
    vimModeRef.current = vimMode;
    const view = viewRef.current;
    if (view === null) return;
    void reconfigureVim(view, vimMode);
  }, [vimMode]);

  // local-ai (SYNC-14): push the live `ai_enabled` (ANDed with the not-excluded
  // gate the host passes) into the AI compartment whenever it changes — so
  // turning AI off, or opening a note in an excluded folder, immediately tears
  // down ghost-text + the AI slash commands instead of leaving them live-feeding
  // note content to the model. Seeded at mount, so this runs once then on toggle.
  useEffect(() => {
    aiEnabledRef.current = aiEnabled;
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
    const range = resolveAnchorRange(body, scrollAnchor.anchor);
    if (range === null) {
      // Body may not have loaded yet (anchor not present) — wait for the next
      // `value` change to retry. If the note is loaded and the anchor genuinely
      // doesn't exist, the retry stays a no-op and the editor keeps its top
      // position (the §5.6 fallback). Either way, don't mark this nonce applied.
      return;
    }
    appliedScrollNonceRef.current = scrollAnchor.nonce;
    const from = Math.min(range.from, body.length);
    const to = Math.min(range.to, body.length);
    view.dispatch({
      // A query anchor carries a non-empty span → SELECT the match (MYND-448 D4);
      // heading/block anchors are zero-length → just place the caret.
      selection: to > from ? { anchor: from, head: to } : { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: "start" }),
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
