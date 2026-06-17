// React hook that installs the window-level keybinding dispatcher (hotkeys epic,
// MYND-304; keybind-engine). Replaces scattered inline `window.addEventListener
// ("keydown")` handlers with TWO engine-driven listeners — one bubble-phase, one
// capture-phase — fed by the pure dispatcher in keybindEngine.ts.
//
// The capture-phase listener is what lets the `nav.back`/`nav.forward` (Cmd-[/])
// bindings beat CodeMirror's indentLess/indentMore: it runs before CM's own DOM
// handler and `stopPropagation`s when it handles the chord (SYNC-8). Bubble
// handles everything else.
//
// Effective bindings = per-id `override ?? default`: `defaults` is the in-code
// default chord set per entry id; `overrides` is the user keymap from
// `vault.prefs` (usePrefs().prefs.keymap). The hook merges them so a rebind takes
// effect with no other change.

import { useEffect } from "react";
import { dispatchKeybind, type KeybindEntry } from "./keybindEngine";
import { deriveWhenContext } from "./scope";
import { isMacPlatform } from "./chord";
import { mergeKeymap } from "./keymap";
import type { AppStageName } from "./registry";

export interface KeybindDispatcherOptions {
  /** The dispatchable bindings (caller supplies workspace-bound `run`s). */
  entries: readonly KeybindEntry[];
  /** In-code default chords per entry id. */
  defaults: Readonly<Record<string, string[]>>;
  /** User overrides from `vault.prefs.keymap` (usePrefs().prefs.keymap). */
  overrides: Readonly<Record<string, string[]>>;
  /** Current app stage (for the scope gate). */
  stageName: AppStageName;
  /** Current selected note id (per-note gate). */
  selectedNoteId: unknown;
  /** Open modal id, or null (window shortcuts stand down under a modal). */
  activeModal: string | null;
}

export function useKeybindDispatcher(opts: KeybindDispatcherOptions): void {
  const { entries, defaults, overrides, stageName, selectedNoteId, activeModal } = opts;

  useEffect(() => {
    const mac = isMacPlatform();
    const keymap = mergeKeymap(defaults, overrides);

    const makeHandler = (phase: "capture" | "bubble") => (e: KeyboardEvent) => {
      const ctx = deriveWhenContext({ stageName, selectedNoteId }, e.target, activeModal);
      if (dispatchKeybind(e, phase, ctx, entries, keymap, mac)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const bubble = makeHandler("bubble");
    const capture = makeHandler("capture");
    window.addEventListener("keydown", bubble);
    window.addEventListener("keydown", capture, true);
    return () => {
      window.removeEventListener("keydown", bubble);
      window.removeEventListener("keydown", capture, true);
    };
  }, [entries, defaults, overrides, stageName, selectedNoteId, activeModal]);
}
