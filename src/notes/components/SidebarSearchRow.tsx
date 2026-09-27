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
// any palette-only command.
//
// ── Quiet, not boxed ───────────────────────────────────────────────────────
// It draws no border and no fill at rest. A bordered field here competed with
// the vault picker directly above it and with the tree directly below, on the
// narrowest surface in the app, and the border was doing no work: the row is
// the full width of its column and the magnifier already says what it is. The
// hover fill is the affordance.
//
// The chord lives in the TOOLTIP rather than as inline keycaps, for the same
// reason: two keycaps at the end of a 200px row is most of the row's remaining
// space spent on a hint the user needs once. Hovering still teaches it.

import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { Tooltip } from "../../components/primitives/Tooltip";
import { BINDABLE_COMMANDS } from "../../commands/bindableCatalog";
import { effectiveChords } from "../../commands/keymap";
import { usePrefs } from "../../hooks/usePrefs";
import { ribbonCommands } from "../ribbonCommands";
import { hoverSurface, HOVER_TRANSITION } from "../../components/primitives/hoverSurface";

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: "0 var(--space-1)",
  background: "transparent",
  border: 0,
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
  // had moved it — and a tooltip that lies is worse than no tooltip, which is
  // why an unbound command gets none rather than a guess.
  const chord = useMemo(() => {
    const defaults: Record<string, string[]> = {};
    for (const c of BINDABLE_COMMANDS) defaults[c.id] = c.defaultBindings;
    return effectiveChords("palette.toggle", defaults, prefs.keymap)[0];
  }, [prefs.keymap]);

  return (
    // `stretch`, or the row hugs the word "Search". `ROW_STYLE` already says
    // `flex: 1` and it lands on a child of the tooltip's wrapper, which is the
    // actual flex item — so the free space in the header row never reached it
    // and the control sat at about a third of its width, with the three create
    // buttons floating a long way to its right.
    <Tooltip label={t("notes.list.search")} kbd={chord} placement="bottom" stretch>
      <button
        type="button"
        data-testid="notes.sidebar-search"
        style={ROW_STYLE}
        {...hoverSurface({ hoverBg: "var(--bg-3)" })}
        onClick={() => ribbonCommands.run?.("palette.open")}
      >
        <Icon name="search" size={14} />
        <span style={LABEL_STYLE}>{t("notes.list.search")}</span>
      </button>
    </Tooltip>
  );
}
