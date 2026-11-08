// Settings > Editor > Calendar: the calendar's two settings (myne-md/myne#1037).
//
// Both ride ONE flat prefs map, `calendar_settings`, keyed by setting:
// `day_reminder_anchor` (the wall-clock hour an all-day event's relative reminder
// counts back from) and `colours.<calendar name>` (the design-token name that
// calendar draws in). The map is written one entry at a time because the entry IS
// the Phase 2 field clock (protocol.md §9.5.2): a colour changed on one device and
// an anchor changed on another, in the same round, both survive.
//
// **The anchor is chosen, never typed.** The control offers the 48 half-hours the
// day has, which is the same discipline the recurrence builder follows: a value a
// user cannot misspell never needs a validation message.
//
// **A colour is a token name, never a literal.** The picker offers the eight
// `--group-*` categorical tokens through {@link GROUP_COLOR_PALETTE}, the list the
// colour-group editor and the default tag grouping already share, so a custom
// theme repaints the calendar with the rest of the app and `check-token-adoption`
// stays green. A name the sheet does not carry renders in the default colour
// rather than blocking a write, which is what lets a theme drop a token safely.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { ColorSwatchPicker } from "../primitives/ColorSwatchPicker";
import { Input } from "../primitives/Input";
import { Select } from "../primitives/Select";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { usePrefs } from "../../hooks/usePrefs";
import { GROUP_COLOR_PALETTE } from "../../notes/graphColorGroups";
import {
  CALENDAR_ANCHOR_SETTING,
  CALENDAR_COLOUR_PREFIX,
  resolveCalendarDayAnchor,
  setCalendarSetting,
} from "../../lib/prefs";

/** Every half-hour of the day, `00:00` first. */
const ANCHOR_CHOICES: ReadonlyArray<string> = Array.from({ length: 48 }, (_, i) => {
  const hours = String(Math.floor(i / 2)).padStart(2, "0");
  const minutes = i % 2 === 0 ? "00" : "30";
  return `${hours}:${minutes}`;
});

export function CalendarSettings() {
  const { t } = useTranslation();
  const { prefs, loaded } = usePrefs();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newColour, setNewColour] = useState<string>(GROUP_COLOR_PALETTE[0]!.key);

  const settings = prefs.calendar_settings ?? {};
  const anchor = resolveCalendarDayAnchor(settings);
  const colours = Object.entries(settings)
    .filter(([key]) => key.startsWith(CALENDAR_COLOUR_PREFIX))
    .map(([key, value]) => ({
      name: key.slice(CALENDAR_COLOUR_PREFIX.length),
      colour: value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  async function write(setting: string, value: string | null) {
    setError(null);
    try {
      await setCalendarSetting(setting, value);
    } catch {
      setError(t("settings.calendar.saveFailed"));
    }
  }

  async function addColour() {
    const name = newName.trim();
    if (name === "") return;
    await write(`${CALENDAR_COLOUR_PREFIX}${name}`, newColour);
    setNewName("");
  }

  return (
    <>
      <SettingRow
        label={t("settings.calendar.anchorLabel")}
        helper={t("settings.calendar.anchorHelper")}
        testId="settings.calendar.anchor"
        anchorId="calendar.day_reminder_anchor"
        error={error}
        control={(helperId) => (
          <Select
            aria-label={t("settings.calendar.anchorLabel")}
            aria-describedby={helperId}
            value={anchor}
            options={ANCHOR_CHOICES.map((value) => ({ value, label: value }))}
            onChange={(value) => void write(CALENDAR_ANCHOR_SETTING, value)}
          />
        )}
      />

      <ControlBlock
        label={t("settings.calendar.coloursLabel")}
        helper={
          loaded && colours.length === 0
            ? t("settings.calendar.coloursEmpty")
            : t("settings.calendar.coloursHelper")
        }
        testId="settings.calendar.colours"
        anchorId="calendar.colours"
        control={
          <div style={{ display: "grid", gap: "var(--space-1)" }}>
            {colours.map(({ name, colour }) => (
              <div
                key={name}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
              >
                <span
                  style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    fontSize: "var(--text-xs)",
                    color: "var(--fg-1)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}
                </span>
                <ColorSwatchPicker
                  palette={GROUP_COLOR_PALETTE}
                  value={colour}
                  testId="settings.calendar.swatch"
                  onChange={(key) => void write(`${CALENDAR_COLOUR_PREFIX}${name}`, key)}
                />
                <Button
                  variant="ghost"
                  onClick={() => void write(`${CALENDAR_COLOUR_PREFIX}${name}`, null)}
                >
                  {t("settings.calendar.remove")}
                </Button>
              </div>
            ))}

            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <Input
                aria-label={t("settings.calendar.newNameLabel")}
                placeholder={t("settings.calendar.newNamePlaceholder")}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                style={{ flex: "1 1 auto", minWidth: 0 }}
              />
              <ColorSwatchPicker
                palette={GROUP_COLOR_PALETTE}
                value={newColour}
                testId="settings.calendar.swatch"
                onChange={setNewColour}
              />
              <Button onClick={() => void addColour()} disabled={newName.trim() === ""}>
                {t("settings.calendar.addColour")}
              </Button>
            </div>
          </div>
        }
      />
    </>
  );
}
