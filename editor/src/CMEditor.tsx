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
import {
  myneExtensions,
  reconfigureAi,
  reconfigureTranscription,
  reconfigureEditorKeymap,
} from "./extensions";
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
import {
  setTaskQueryResults,
  TASK_QUERY_OPEN_EVENT,
  TASK_QUERY_TOGGLE_EVENT,
  type TaskQueryRender,
  type TaskQueryRowEventDetail,
} from "./decorations/task-query-block";
import {
  setTagSuggestions,
  TAG_SUGGESTION_ACCEPT_EVENT,
  TAG_SUGGESTION_DISMISS_EVENT,
  type TagSuggestionChip,
  type TagSuggestionEventDetail,
} from "./decorations/tag-suggestion-band";
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
  /** myne#167: the doc text `value` was DERIVED FROM.
   *
   *  A controlled `value` that differs from the live doc is ambiguous: it is
   *  either an authoritative external replacement (note switch, sync pull,
   *  §11.3 keep-both adopt) or a stale echo of a snapshot the buffer has
   *  already moved past (the autosave `updated:` patch). Content equality
   *  cannot tell those apart — so the HOST, the only party that knows what it
   *  computed `value` from, states the baseline, and this component verifies it
   *  against the live doc, the one thing it owns.
   *
   *  SET → the mirror applies `value` only while the buffer is still exactly
   *  `valueBase`; otherwise the value is REJECTED and the live text is
   *  re-asserted upward through `onChange`, so the host's copy — and its
   *  autosave dirty bit — re-converge on the buffer instead of on a save that
   *  never covered these keystrokes.
   *
   *  UNSET → "authoritative, apply unconditionally": the behaviour every host
   *  had before this prop existed. A host that never echoes a DERIVED value
   *  (mobile, the read-only reading companion) needs no change. */
  valueBase?: string;
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
  /** MYND-617: results for the task-query blocks in THIS document, keyed by the
   *  block's query text. Pushed into the editor's task-query results field
   *  (re-mount-free) like `vaultBlockAnchors`.
   *
   *  The host computes these because the query semantics are the host's: reading
   *  a `due::` value is the dialect's §3.6.4 type authority, and the vault-wide
   *  task list is a host IPC surface. This package supplies the block list
   *  (`taskQueryBlocks`) and renders what it is handed, and nothing more.
   *
   *  Optional, and its absence is NOT an empty result — a block with no entry
   *  renders as LOADING, because an empty list would be a wrong answer presented
   *  as a finished one. */
  taskQueryResults?: ReadonlyMap<string, TaskQueryRender>;
  /** MYND-617: a task-query row's checkbox was activated. The widget emits a
   *  bubbling `myne-task-query-toggle`; this relays it. The host performs the
   *  write — this package never writes bytes. */
  onTaskQueryToggle?: (detail: TaskQueryRowEventDetail) => void;
  /** MYND-617: a task-query row's source note was activated. Relayed from
   *  `myne-task-query-open` so the workspace can open that note. */
  onTaskQueryOpen?: (detail: TaskQueryRowEventDetail) => void;
  /** MYND-651: the tag-suggestion band's chips for the open note, pushed into
   *  the band's state field (re-mount-free) like `taskQueryResults`.
   *
   *  The host owns everything about these — the model call, the excluded-folder
   *  gate, the vocabulary fold, the idle debounce — and this package renders
   *  them and nothing more. Absent or empty means NO BAND at all (not an empty
   *  one): a suggestion surface that is off by default must not reserve a strip
   *  of every note. */
  tagSuggestions?: readonly TagSuggestionChip[];
  /** MYND-651: a suggestion chip was activated. Relayed from
   *  `myne-tag-suggestion-accept`; the host performs the frontmatter write
   *  (`acceptTagIntoView`) — this package never writes bytes. */
  onAcceptTagSuggestion?: (detail: TagSuggestionEventDetail) => void;
  /** MYND-651: a suggestion chip's × was activated. Relayed from
   *  `myne-tag-suggestion-dismiss`; the host drops it for this note. */
  onDismissTagSuggestion?: (detail: TagSuggestionEventDetail) => void;
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
  /** #184: the user keymap overrides (`vault.prefs.keymap`, id → chords) for the
   *  rebindable editor commands. Pushed into the editor keymap Compartment
   *  (re-mount-free) whenever it changes, so a Hotkeys-panel rebind of bold /
   *  undo / indent / fold takes effect on the open note live. Absent → in-code
   *  defaults. */
  keymapOverrides?: Readonly<Record<string, readonly string[]>>;
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
  /** Whether speech-to-text is offered on audio attachments (MYND-592).
   *  Default TRUE — an opt-OUT independent of `aiEnabled`. */
  transcriptionEnabled?: boolean;
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
  const { value, valueBase, onChange, onBlur, onSelectionChange, extensions, noteSet, vaultHeadings, vaultBlockAnchors, taskQueryResults, onTaskQueryToggle, onTaskQueryOpen, tagSuggestions, onAcceptTagSuggestion, onDismissTagSuggestion, onOpenWikilink, scrollAnchor = null, lineNumbers = false, vimMode = false, keymapOverrides, viewMode = "live", readOnly = false, aiEnabled = false, transcriptionEnabled = true, selectionToolbar = true, style, onReady, onSwapReady } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const onTaskQueryToggleRef = useRef(onTaskQueryToggle);
  const onTaskQueryOpenRef = useRef(onTaskQueryOpen);
  const onAcceptTagSuggestionRef = useRef(onAcceptTagSuggestion);
  const onDismissTagSuggestionRef = useRef(onDismissTagSuggestion);
  const onReadyRef = useRef(onReady);
  const onSwapReadyRef = useRef(onSwapReady);
  // MYND-534: config refs so `buildState` / `applyState` (called imperatively by
  // the host, outside React's render) read the CURRENT compartment config rather
  // than a value frozen at mount. Kept live by the reconfigure effects below.
  const extensionsRef = useRef(extensions);
  const noteSetRef = useRef(noteSet);
  const vaultHeadingsRef = useRef(vaultHeadings);
  const vaultBlockAnchorsRef = useRef(vaultBlockAnchors);
  const taskQueryResultsRef = useRef(taskQueryResults);
  const tagSuggestionsRef = useRef(tagSuggestions);
  const lineNumbersRef = useRef(lineNumbers);
  const viewModeRef = useRef(viewMode);
  const readOnlyRef = useRef(readOnly);
  const aiEnabledRef = useRef(aiEnabled);
  const transcriptionEnabledRef = useRef(transcriptionEnabled);
  const vimModeRef = useRef(vimMode);
  const keymapOverridesRef = useRef(keymapOverrides);
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
    onTaskQueryToggleRef.current = onTaskQueryToggle;
  }, [onTaskQueryToggle]);
  useEffect(() => {
    onTaskQueryOpenRef.current = onTaskQueryOpen;
  }, [onTaskQueryOpen]);
  useEffect(() => {
    onAcceptTagSuggestionRef.current = onAcceptTagSuggestion;
  }, [onAcceptTagSuggestion]);
  useEffect(() => {
    onDismissTagSuggestionRef.current = onDismissTagSuggestion;
  }, [onDismissTagSuggestion]);
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
            transcriptionEnabled: transcriptionEnabledRef.current,
            keymapOverrides: keymapOverridesRef.current,
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
      v.dispatch({ effects: reconfigureTranscription(transcriptionEnabledRef.current) });
      // #184: the editor keymap is a Compartment too, seeded from overrides at
      // mount; `setState` resets it to that seed, so re-push the CURRENT overrides
      // after a swap or a customised keymap silently reverts to defaults.
      v.dispatch({ effects: reconfigureEditorKeymap(keymapOverridesRef.current ?? {}) });
      if (noteSetRef.current !== undefined) {
        v.dispatch({ effects: reconfigureNoteSet(noteSetRef.current) });
      }
      if (vaultHeadingsRef.current !== undefined) {
        v.dispatch({ effects: reconfigureVaultHeadings(vaultHeadingsRef.current) });
      }
      if (vaultBlockAnchorsRef.current !== undefined) {
        v.dispatch({ effects: reconfigureVaultBlockAnchors(vaultBlockAnchorsRef.current) });
      }
      // MYND-617: the task-query results live in a StateField, and `setState`
      // resets it to the empty map its `create` seeds. Without this line every
      // query block in a note reopened from the swap cache falls back to its
      // LOADING state until the host's next recompute.
      if (taskQueryResultsRef.current !== undefined) {
        v.dispatch({ effects: setTaskQueryResults.of(taskQueryResultsRef.current) });
      }
      // MYND-651: same `setState`-resets-the-field problem as the line above.
      // Without it, switching back to a note the swap cache holds drops its band
      // until the next idle pass — which is up to a debounce interval of a
      // feature looking broken.
      if (tagSuggestionsRef.current !== undefined) {
        v.dispatch({ effects: setTagSuggestions.of(tagSuggestionsRef.current) });
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
  //
  // CAUSALITY, NOT CONTENT (myne#167). Autosave snapshots the doc, writes it,
  // and the parent echoes the saved text back as `value` — but the user may
  // have typed during that round trip, so the echo can describe a document the
  // buffer has already moved past. A diff between "doc with the new keystrokes"
  // and "value without them" describes deleting those keystrokes, and
  // dispatching it did exactly that: a character vanishing while typing fast, a
  // whole line disappearing after leaving the note, the caret jumping.
  //
  // MYND-625 tried to catch this by comparing the live doc against the PREVIOUS
  // `value` prop. That baseline does not work for a fully-controlled host:
  // `onChange` mirrors every keystroke straight back into `value`, so the
  // previous prop re-synced to the live doc on every committed keystroke and
  // the check was unsatisfiable exactly when it was needed. (Worse, the only
  // orderings that could reach it left the baseline pointing at the text it had
  // just dropped, so the NEXT value — possibly an authoritative sync pull —
  // was swallowed too.)
  //
  // `valueBase` is the host's statement of what THIS value was computed from.
  // If the buffer is no longer that text, the value predates edits it cannot
  // describe. A single-range diff cannot be rebased here: when the echo differs
  // by BOTH a frontmatter stamp and the trailing keystrokes, `diffDoc`'s
  // prefix/suffix scan collapses them into ONE replacement spanning the user's
  // text, so "apply it carefully" has no correct formulation.
  //
  // Rejecting SILENTLY is not enough either — the host would keep a body the
  // buffer never adopted and an autosave that believes it is clean, so the
  // surviving keystrokes would never reach disk. Re-assert the live text
  // upward instead. That terminates in one extra render (the next `value`
  // equals the live doc → the early return above) and re-dirties the host.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const live = view.state.doc.toString();

    if (live === value) return;

    if (valueBase !== undefined && live !== valueBase) {
      onChangeRef.current(live);
      return;
    }

    const diff = diffDoc(live, value);
    if (diff === null) return;
    view.dispatch({ changes: diff });
    // `valueBase` is a dep, not just `value`: without it, a rejected echo
    // followed by an authoritative value that happens to equal it would not
    // re-run this effect (the string is unchanged) and the authoritative value
    // would be lost.
  }, [value, valueBase]);

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

  // MYND-617: push the host-computed task-query results into the view's results
  // field (same re-mount-free pattern as the sets above) so every `tasks` block
  // in the open note renders its list. The host recomputes on doc + index change;
  // this only carries the answer across.
  useEffect(() => {
    taskQueryResultsRef.current = taskQueryResults;
    const view = viewRef.current;
    if (view === null || taskQueryResults === undefined) return;
    view.dispatch({ effects: setTaskQueryResults.of(taskQueryResults) });
  }, [taskQueryResults]);

  // MYND-651: push the host's tag-suggestion chips into the band's state field
  // (same re-mount-free pattern). `undefined` is the "this host does not drive
  // the band" case and pushes nothing; an empty array is a real answer and
  // clears it.
  useEffect(() => {
    tagSuggestionsRef.current = tagSuggestions;
    const view = viewRef.current;
    if (view === null || tagSuggestions === undefined) return;
    view.dispatch({ effects: setTagSuggestions.of(tagSuggestions) });
  }, [tagSuggestions]);

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

  // #184: push the user keymap overrides into the editor keymap Compartment
  // whenever `vault.prefs.keymap` changes — re-mount-free, so a rebind of an
  // editor command (bold, undo, indent, fold, …) takes effect on the open note
  // live (cursor / scroll / undo preserved). Seeded at mount, so this runs once
  // to honour an already-customised keymap, then on every subsequent rebind.
  useEffect(() => {
    keymapOverridesRef.current = keymapOverrides;
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureEditorKeymap(keymapOverrides ?? {}) });
  }, [keymapOverrides]);

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

  useEffect(() => {
    transcriptionEnabledRef.current = transcriptionEnabled;
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: reconfigureTranscription(transcriptionEnabled) });
  }, [transcriptionEnabled]);

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

  // MYND-617: relay the task-query row events (dispatched on the editor DOM by
  // the query-block extension) to the host callbacks. Same shape as the wikilink
  // relay above: the widget owns the DOM, the host owns the write.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onToggle = (e: Event): void => {
      const detail = (e as CustomEvent<TaskQueryRowEventDetail>).detail;
      if (detail?.rowKey) onTaskQueryToggleRef.current?.(detail);
    };
    const onOpen = (e: Event): void => {
      const detail = (e as CustomEvent<TaskQueryRowEventDetail>).detail;
      if (detail?.rowKey) onTaskQueryOpenRef.current?.(detail);
    };
    host.addEventListener(TASK_QUERY_TOGGLE_EVENT, onToggle);
    host.addEventListener(TASK_QUERY_OPEN_EVENT, onOpen);
    return () => {
      host.removeEventListener(TASK_QUERY_TOGGLE_EVENT, onToggle);
      host.removeEventListener(TASK_QUERY_OPEN_EVENT, onOpen);
    };
  }, []);

  // MYND-651: relay the tag-suggestion band's chip events. Same shape again —
  // the widget owns the DOM, the host owns the write into frontmatter `tags:`.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onAccept = (e: Event): void => {
      const detail = (e as CustomEvent<TagSuggestionEventDetail>).detail;
      if (detail?.tag) onAcceptTagSuggestionRef.current?.(detail);
    };
    const onDismiss = (e: Event): void => {
      const detail = (e as CustomEvent<TagSuggestionEventDetail>).detail;
      if (detail?.tag) onDismissTagSuggestionRef.current?.(detail);
    };
    host.addEventListener(TAG_SUGGESTION_ACCEPT_EVENT, onAccept);
    host.addEventListener(TAG_SUGGESTION_DISMISS_EVENT, onDismiss);
    return () => {
      host.removeEventListener(TAG_SUGGESTION_ACCEPT_EVENT, onAccept);
      host.removeEventListener(TAG_SUGGESTION_DISMISS_EVENT, onDismiss);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid="editor.content"
      style={style ?? { width: "100%", minHeight: 360 }}
    />
  );
}
