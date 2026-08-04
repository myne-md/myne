// vim-keyboard-mode (MYND-313): the optional modal-editing layer, toggled live
// via a CM6 Compartment reconfigure — the `line-numbers.ts` pattern, NOT a React
// remount (that would lose cursor / scroll / undo).
//
// Two things make this module different from the other pref-driven compartments:
//
//   1. The engine is loaded through a **dynamic `import()`, only when turning vim
//      ON** — the same discipline `mermaid` / `katex` / `pdfjs-dist` already use
//      in this package. A user with vim off never downloads `@replit/codemirror-vim`.
//      That lazy load is the load-bearing mitigation for taking the dependency at
//      all (design session Q1), so do NOT convert this to a static import.
//
//   2. Because the import is async, two reconfigures can be in flight at once
//      (a user double-clicking the toggle). A monotonic generation counter makes
//      the LAST call win; a stale import that resolves afterwards is dropped.
//
// Mode surfacing: the engine emits a `vim-mode-change` signal on its CM5 shim.
// We mirror it onto the editor's DOM as `data-vim-mode`, which is simultaneously
// the bottom-bar indicator's input (task 5) and the E2E hook — one mechanism, the
// same approach multi-cursor uses for `data-selection-count`.

import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { applyChordPolicy } from "./vim-chords";
import { installExCommands } from "./vim-ex";

const vimCompartment = new Compartment();

/** DOM attribute carrying the active vim mode (`normal` / `insert` / `visual` /
 *  `replace`). Absent entirely when vim is off. Read by the bottom-bar mode
 *  indicator and by E2E. */
export const VIM_MODE_ATTR = "data-vim-mode";

/** Bubbling DOM event announcing a mode change (or `null` when vim is switched
 *  off), so a host outside the editor — the bottom bar lives in the app shell,
 *  not in the pane — can render an indicator without reaching into CM internals.
 *  Same escape hatch the wikilink chip uses to reach the workspace. */
export const VIM_MODE_EVENT = "myne-vim-mode";

/** `detail` payload of {@link VIM_MODE_EVENT}. */
export type VimModeEventDetail = { mode: string | null };

function announceMode(view: EditorView, mode: string | null): void {
  if (mode === null) view.dom.removeAttribute(VIM_MODE_ATTR);
  else view.dom.setAttribute(VIM_MODE_ATTR, mode);
  view.dom.dispatchEvent(
    new CustomEvent<VimModeEventDetail>(VIM_MODE_EVENT, {
      detail: { mode },
      bubbles: true,
    }),
  );
}

/** The view's current vim mode, or `null` when vim is off.
 *
 *  Reads the DOM attribute rather than the engine's state so callers need no
 *  engine handle — and so it answers `null` cheaply on the overwhelmingly common
 *  path where vim was never enabled. */
export function currentVimMode(view: EditorView): string | null {
  return view.dom.getAttribute(VIM_MODE_ATTR);
}

/** True when vim is on AND in a mode that Escape is expected to leave (insert,
 *  visual, replace) — i.e. when Escape's first job is the mode transition.
 *
 *  This is the hinge of the Escape ordering (design session Q2, "one Escape, one
 *  job"). CodeMirror keymap handlers all run BEFORE the vim engine's DOM-level
 *  keydown handler, so a Myne binding that returns `true` silently steals the
 *  key from vim. Any Escape binding that could fire while vim is mid-mode must
 *  therefore decline here and let the key fall through. */
export function vimWantsEscape(view: EditorView): boolean {
  const mode = currentVimMode(view);
  return mode !== null && mode !== "normal";
}

/** Monotonic counter PER VIEW: only the newest `reconfigureVim` call for a given
 *  view may apply its result. Guards against an interleaved on→off→on where the
 *  first dynamic import resolves after the later one already settled that view's
 *  compartment.
 *
 *  Per view, not module-global (myne#330). A single counter meant any second
 *  call from a DIFFERENT view cancelled a pending enable — and the losing view
 *  then had no modal editing, no `data-vim-mode` attribute and so no mode
 *  indicator, silently: the guard returns rather than throwing, and the
 *  `[vimMode]` effect never re-fires because the prop does not change again.
 *  The user is typing into what looks like a vim editor and is not one, with
 *  `dd`/`x` inserted as literal text.
 *
 *  The deterministic case needs no import-timing luck at all: a pane in source
 *  mode with its read-only preview companion mounts BOTH editors in one commit,
 *  the primary awaits the import while the companion (no `vimMode` prop) runs
 *  the synchronous OFF branch and bumps the counter — so the primary is always
 *  dropped. */
const generations = new WeakMap<EditorView, number>();

function nextGeneration(view: EditorView): number {
  const next = (generations.get(view) ?? 0) + 1;
  generations.set(view, next);
  return next;
}

/** The engine module, once it has been dynamically imported. */
type VimApi = typeof import("@replit/codemirror-vim");
let loadedApi: VimApi | null = null;

/** The loaded engine API, or `null` when vim has never been enabled in this
 *  session.
 *
 *  Every later layer that needs the engine — Escape ordering, the chord
 *  exclusion list, the ex-command table, the lock-time state reset — reaches it
 *  through here rather than importing the package itself. That keeps the dynamic
 *  `import()` in this module as the SINGLE entry point, so "vim off ⇒ engine
 *  never loaded" stays true no matter how many features build on top of it. */
export function vimApi(): VimApi | null {
  return loadedApi;
}

/** Per-view teardown for the mode listener, so turning vim off (or destroying the
 *  view) does not leak a subscription on the engine's shim. */
const modeListenerCleanup = new WeakMap<EditorView, () => void>();

/** Compose into `myneExtensions()` — seeds vim OFF (`[]`, the default). The host
 *  calls `reconfigureVim(view, true)` post-mount when the pref is on. */
export function vimExtension(): Extension {
  return vimCompartment.of([]);
}

function detachModeListener(view: EditorView): void {
  const cleanup = modeListenerCleanup.get(view);
  if (cleanup !== undefined) {
    cleanup();
    modeListenerCleanup.delete(view);
  }
}

/** Turn the modal layer on or off for `view`, live. Resolves once the change has
 *  been applied (or deliberately skipped because a newer call superseded it).
 *
 *  Turning OFF is synchronous and never imports the engine — that is what keeps
 *  the dependency off the critical path for users who don't want vim. */
export async function reconfigureVim(view: EditorView, on: boolean): Promise<void> {
  const mine = nextGeneration(view);

  if (!on) {
    detachModeListener(view);
    view.dispatch({ effects: vimCompartment.reconfigure([]) });
    announceMode(view, null);
    return;
  }

  const mod = await import("@replit/codemirror-vim");
  loadedApi = mod;
  // Surrender the chords Myne's own keyboard map owns (Ctrl-is-Mod platforms
  // only). Idempotent and process-wide — see `vim-chords.ts` for why.
  applyChordPolicy(mod);
  // Closed ex table (`:w` / `:q` / refusals). Also idempotent — the engine's
  // command map is module-global like its keymap.
  installExCommands(mod);

  // Superseded by a newer toggle, or the pane was torn down while the chunk
  // loaded. (`EditorView.destroyed` is private in CM6; a detached DOM node is the
  // public-API proxy for "this view is gone" — React unmounts the pane's element
  // on close, which is exactly the case we must not dispatch into.)
  if (mine !== generations.get(view) || !view.dom.isConnected) return;

  view.dispatch({ effects: vimCompartment.reconfigure([mod.vim()]) });

  // `getCM` only returns a handle once the vim extension is actually mounted,
  // which the dispatch above just did.
  const cm = mod.getCM(view);
  if (cm === null) return;

  // Seed the mode before the first transition so the indicator is never blank in
  // the window between mounting and the user's first keystroke. The engine
  // always starts a document in normal mode.
  announceMode(view, "normal");

  detachModeListener(view);
  const onModeChange = (event: { mode: string }): void => {
    if (!view.dom.isConnected) return;
    announceMode(view, event.mode);
  };
  cm.on("vim-mode-change", onModeChange);
  modeListenerCleanup.set(view, () => cm.off("vim-mode-change", onModeChange));
}

/** Test seam: forget a view's generation so an aborted reconfigure in one test
 *  cannot make the next test's call look stale. Not used in production.
 *
 *  Takes the view now that the counter is per view (myne#330); with no argument
 *  it is a no-op, since a `WeakMap` has no "clear everything" that is safe to
 *  offer — and the map is keyed on views a test has already dropped. */
export function resetVimGenerationForTests(view?: EditorView): void {
  if (view !== undefined) generations.delete(view);
}

/** Clear every piece of vim state that outlives an editor view — call on the
 *  vault-lock path, BEFORE the slot is dropped.
 *
 *  Yanked note text and recorded macros live in the engine's **module-global**
 *  `vimGlobalState`, not in the `EditorView`. Unmounting the editor (which is
 *  what locking does) therefore does NOT clear them, and without this a user
 *  could yank from one vault, lock, open a DIFFERENT vault, press `p`, and paste
 *  the first vault's text. That crosses the separation Myne promises between
 *  vaults, so the reset belongs on the lock path — exactly like
 *  `resetGraphLayoutOnLock` next to it.
 *
 *  A no-op when vim was never enabled: the engine is not even loaded then. */
export function resetVimStateOnLock(): void {
  loadedApi?.Vim.resetVimGlobalState_();
}
