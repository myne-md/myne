// vim-keyboard-mode (MYND-313): the chord conflict layer.
//
// The rule (design session Q4): **Myne's application chords win; vim stays inside
// the editor.** Myne's keyboard map is user data — `vault.prefs.keymap` overrides
// plus the Hotkeys panel — and an editor mode may not silently consume it.
// VS Code Vim takes the same posture by default (`useCtrlKeys`), so the model is
// already familiar to vim users.
//
// The conflict is platform-shaped. Myne binds everything as `Mod-*`, which
// resolves to Cmd on macOS and **Ctrl** everywhere else. On macOS there is no
// overlap at all and vim keeps its full `Ctrl-` grammar. On Windows/Linux almost
// every Myne chord lands on a vim binding, so the overlapping ones are removed
// from the VIM keymap (never from Myne's).
//
// Two exceptions, both deliberate:
//   - `<C-[>` stays with vim. It is Escape's exact equivalent and has no
//     alternative; a vim user reaching for it must not navigate back a note.
//   - `<C-r>` needs nothing: it is redo on both sides.
//
// `<C-c>` is also left alone: the engine already special-cases it on non-Mac and
// hands the key to the platform copy, so cutting it here would be redundant.

/** The engine module shape this layer needs (a narrow slice of `vimApi()`).
 *
 *  Declared with METHOD syntax on purpose: the package types `ctx` as required,
 *  while the implementation reads it as "match entries whose context equals this"
 *  and therefore accepts `undefined` to reach the context-less bindings. Method
 *  syntax is bivariant in TypeScript, which lets the real module satisfy this
 *  shape without a cast at the call site. */
type ChordApi = {
  Vim: {
    unmap(lhs: string, ctx?: string): unknown;
    noremap(lhs: string, rhs: string, ctx?: string): void;
  };
};

/** Vim chords surrendered to Myne on Ctrl-is-Mod platforms, each with the reason
 *  — the list is data (not scattered conditionals) so it can be asserted in a
 *  test and rendered into the settings copy without drifting. */
export const SURRENDERED_CHORDS: ReadonlyArray<{ chord: string; to: string }> = [
  { chord: "<C-a>", to: "select all (scoped)" },
  { chord: "<C-b>", to: "bold" },
  { chord: "<C-d>", to: "add next occurrence to selection" },
  { chord: "<C-e>", to: "inline code" },
  { chord: "<C-f>", to: "find in note" },
  { chord: "<C-i>", to: "italic" },
  { chord: "<C-p>", to: "command palette" },
  { chord: "<C-t>", to: "new note" },
  { chord: "<C-v>", to: "paste (platform)" },
  { chord: "<C-w>", to: "close tab" },
  { chord: "<C-x>", to: "cut (platform)" },
];

/** Where visual-block moves once `<C-v>` is surrendered to paste. A fixed
 *  in-code mapping — user-defined key mapping is out of scope by decision, so
 *  this is NOT configurable. */
export const VISUAL_BLOCK_CHORD = "<A-v>";

/** The vim contexts a binding can live in; `undefined` covers the entries that
 *  declare no context (which apply everywhere). */
const CONTEXTS: ReadonlyArray<string | undefined> = [
  undefined,
  "normal",
  "insert",
  "visual",
];

/** `Vim.unmap` splices the engine's module-global `defaultKeymap`, so the policy
 *  is process-wide and must be applied exactly once — re-running it on every
 *  vim-enable would keep splicing an already-spliced array. */
let applied = false;

/** True on macOS/iOS, where `Mod` is Cmd and vim's `Ctrl-` grammar is unobstructed.
 *  Duplicated (one line) rather than imported from the desktop's `commands/chord`
 *  because this package is shared with mobile and must not depend upward. */
function isMacPlatform(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      /Mac|iP(hone|[oa]d)/.test(navigator.platform)
    );
  } catch {
    return false;
  }
}

/** Apply the conflict policy to the freshly-loaded engine. Idempotent, and a
 *  no-op on macOS. Call once, right after the engine is imported. */
export function applyChordPolicy(api: ChordApi, mac: boolean = isMacPlatform()): void {
  if (applied) return;
  applied = true;
  if (mac) return;

  for (const { chord } of SURRENDERED_CHORDS) {
    // A chord can be bound in several contexts; unmap returns falsy once there is
    // nothing left to remove, so sweeping every context is safe and exhaustive.
    for (const ctx of CONTEXTS) api.Vim.unmap(chord, ctx);
  }

  // Give visual-block a home that collides with nothing, so column editing in
  // markdown tables survives losing `<C-v>` to paste.
  api.Vim.noremap(VISUAL_BLOCK_CHORD, "<C-v>", "normal");
  api.Vim.noremap(VISUAL_BLOCK_CHORD, "<C-v>", "visual");
}

/** Test seam: forget that the (process-wide) policy was applied. */
export function resetChordPolicyForTests(): void {
  applied = false;
}

/** Whether the chord policy is in force on this platform — drives the settings
 *  caveat copy. Kept here so the UI and the policy cannot disagree about which
 *  chords a user has actually lost. */
export function chordPolicyActive(mac: boolean = isMacPlatform()): boolean {
  return !mac;
}
