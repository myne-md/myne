// The notes sidebar's search entry (myne-md/myne#773, epic #772 / A4).
//
// It replaces a `NOTES` heading that labelled a region which can only ever
// contain notes, sitting directly under the vault picker that already says
// where you are. That row carried no information; this one carries the app's
// only clickable way into the command palette.
//
// Which is the other half of why it exists. `palette.toggle` lived only in
// `bindableCatalog.ts` as a keybinding, so a user who did not already know
// `Mod-K` could not reach the palette at all — and therefore could not reach
// any palette-only command. #773 registered `palette.open` as a ribbon-eligible
// action; this is the same command from the surface people actually look at
// while deciding what to do next.
//
// It runs the command through `ribbonCommands` rather than owning any palette
// state: the palette lives in a sibling subtree, and the rail solved this
// already.

import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { Keycaps } from "../../components/primitives/Keycaps";
import { BINDABLE_COMMANDS } from "../../commands/bindableCatalog";
import { effectiveChords } from "../../commands/keymap";
import { usePrefs } from "../../hooks/usePrefs";
import { ribbonCommands } from "../ribbonCommands";
import { hoverSurface, HOVER_TRANSITION } from "../../components/primitives/hoverSurface";

/** Quiet field-shaped affordance: it reads as a search box, and it is a button,
 *  because pressing it opens the palette rather than focusing an input here. */
const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: "0 var(--space-2)",
  background: "transparent",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  cursor: "pointer",
  textAlign: "start",
  transition: HOVER_TRANSITION,
};

const LABEL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function SidebarSearchRow() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();

  // The LIVE chord, not the in-code default. `palette.toggle` is rebindable, so
  // a hint read from `defaultBindings` would keep promising ⌘K to somebody who
  // had moved it — and a keycap that lies is worse than no keycap, which is why
  // the hint is omitted entirely rather than guessed when the command is
  // unbound.
  const chord = useMemo(() => {
    const defaults: Record<string, string[]> = {};
    for (const c of BINDABLE_COMMANDS) defaults[c.id] = c.defaultBindings;
    return effectiveChords("palette.toggle", defaults, prefs.keymap)[0];
  }, [prefs.keymap]);

  return (
    <button
      type="button"
      data-testid="notes.sidebar-search"
      style={ROW_STYLE}
      {...hoverSurface({ hoverBg: "var(--bg-3)" })}
      onClick={() => ribbonCommands.run?.("palette.open")}
    >
      <Icon name="search" size={14} />
      <span style={LABEL_STYLE}>{t("notes.list.search")}</span>
      {chord !== undefined && <Keycaps chord={chord} />}
    </button>
  );
}
