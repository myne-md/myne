// `<Keycaps>` — render a chord (e.g. `"Mod-Shift-e"`) as one uniform cap PER KEY
// (`[⌘][⇧][E]`), the legible style the Hotkeys settings panel uses (#184). Shown
// ANYWHERE a shortcut is presented to the user (command palette, hotkeys panel)
// so a chord reads the same everywhere instead of a cramped mono run where the
// ⌘/⇧ glyphs render thinner than the letters and jam together.
//
// Takes a canonical CHORD STRING (the `Mod-Shift-e` form), not a pre-formatted
// label — it tokenises via the shared `chordTokens` so the display can't drift
// from what the keybind engine actually binds.

import { Fragment, type CSSProperties } from "react";
import { chordTokens, isMacPlatform } from "../../commands/chord";

const ROW_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
};
// A single key cap: fixed height + min-width so every token (⌘, ⇧, a letter) is
// the same size and centred; sans (not mono) renders the modifier glyphs at a
// weight closer to the letters.
const CAP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  height: 18,
  padding: "0 5px",
  boxSizing: "border-box",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--fg-1)",
  background: "var(--paper-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1, 4px)",
  boxShadow: "0 1px 0 var(--line-2)",
  lineHeight: 1,
};
// The "+" between caps on non-mac (Windows/Linux: `Ctrl+Shift+G`); macOS uses
// bare glyph caps (`⌘⇧G`).
const PLUS_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-xs, 11px)",
};

export function Keycaps({ chord }: { chord: string }) {
  const tokens = chordTokens(chord);
  const mac = isMacPlatform();
  return (
    <span style={ROW_STYLE} data-testid="keycaps">
      {tokens.map((tok, i) => (
        <Fragment key={i}>
          {i > 0 && !mac && <span style={PLUS_STYLE}>+</span>}
          <kbd style={CAP_STYLE}>{tok}</kbd>
        </Fragment>
      ))}
    </span>
  );
}
