// Graph colour groups on mobile (myne-md/myne#727, writable here by
// myne-md/myne#880).
//
// # Why this block exists
//
// `color_groups` is SHARED whole-value-LWW vault content, and this client's
// graph already READS it (`mobile/src/components/WikiGraph.tsx` passes
// `prefs.color_groups` into the shared `buildGraphOverlay`), so the groups
// coloured the phone's graph while being authored only on a computer.
//
// # Whole-value, not per-group
//
// The write sends the COMPLETE list. Rule order is precedence (first match
// wins), so a per-group upsert could not express a reorder; and the field's
// §10.2 discipline is `WholeValueLww`, so a per-group merge would silently lose
// a concurrent desktop edit to a different group rather than resolving it.
//
// # What is deliberately NOT here
//
// Creating, deleting and reordering groups, and editing a group's FILTER. A new
// group needs a filter authored against the shared filter AST, and the desktop
// editor for that is `src/notes/components/ColorGroupEditor.tsx`; porting it is
// its own feature rather than a row. So this block edits what is already in the
// vault, and says so where the vault has none rather than offering an Add
// button that could not finish the job.
//
// # Why the graph updates without a re-unlock
//
// Every write goes through the prefs chokepoint, which bumps the prefs nonce, so
// every mounted `usePrefs` re-reads and `WikiGraph`'s overlay memo (keyed on
// `prefs.color_groups`) recomputes. No vault re-unlock and no reload.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LABEL_SLOTS } from "@myne/decorations";
import { colorGroupVar } from "@myne/graph-color-groups";
import { Switch, TextField } from "./inputs";
import { setColorGroups, type ColorGroup } from "../lib/prefs";

const ROW_STYLE = {
  padding: "var(--space-3)",
  borderTop: "1px solid var(--line-1)",
} as const;

const SWATCH_ROW_STYLE = {
  display: "flex",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
  alignItems: "center",
} as const;

const SWATCH_STYLE = {
  width: "var(--space-6)",
  height: "var(--space-6)",
  borderRadius: "var(--radius-pill)",
  border: "2px solid transparent",
  padding: 0,
  cursor: "pointer",
} as const;

const HINT_STYLE = {
  marginTop: "var(--space-3)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
} as const;

/**
 * One edit applied to the whole list: replace the group at `index` with `patch`,
 * keeping every other group (and the order) verbatim.
 *
 * Exported because this IS the whole-value discipline: a test that only asserted
 * "something was written" would pass over a per-group merge, which is the shape
 * the §10.2 classification forbids for this field.
 */
export function withGroupPatched(
  groups: ColorGroup[],
  index: number,
  patch: Partial<ColorGroup>,
): ColorGroup[] {
  return groups.map((g, i) => (i === index ? { ...g, ...patch } : g));
}

export function ColorGroupsBlock({
  groups,
  onToast,
}: {
  groups: ColorGroup[];
  /** The sheet's toast. A failed whole-list write is REPORTED: the group list and
   *  the swatches read from `groups`, which a failed write leaves unchanged, so
   *  the surface already shows disk truth, but nothing tells the user their edit
   *  did not land. The desktop twin reports the same failure (`usePrefs`'s
   *  `onShowToast`; `ColorGroupEditor` records its silence for the NOTES-side
   *  editor, which is a different surface). */
  onToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  // Name edits are local until committed, so a keystroke is not a write (and a
  // nonce bump, and a whole-list sync push).
  const [drafts, setDrafts] = useState<string[]>(() => groups.map((g) => g.name));

  useEffect(() => {
    setDrafts(groups.map((g) => g.name));
  }, [groups]);

  /** A failed write, reported and converged: the drafts go back to what the
   *  vault holds, and the sheet says the save did not land. */
  const failed = () => {
    setDrafts(groups.map((g) => g.name));
    onToast?.(t("settings.saveSettingError"));
  };

  const commitName = (index: number) => {
    const name = drafts[index] ?? "";
    if (name === groups[index]?.name) return;
    void setColorGroups(withGroupPatched(groups, index, { name })).catch(failed);
  };

  if (groups.length === 0) {
    return (
      <div data-testid="settings.colorGroups">
        <div style={HINT_STYLE} data-testid="settings.colorGroups.empty">
          {t("notes.graph.colorGroups.mobileEmptyBody")}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="settings.colorGroups">
      {groups.map((group, index) => (
        <div key={group.id} style={{ ...ROW_STYLE, borderTop: index === 0 ? "none" : ROW_STYLE.borderTop }}>
          <TextField
            testId={`settings.colorGroups.name-${group.id}`}
            label={t("notes.graph.colorGroups.namePlaceholder")}
            value={drafts[index] ?? ""}
            onChange={(v) => setDrafts((d) => d.map((x, i) => (i === index ? v : x)))}
            onEnter={() => commitName(index)}
            style={{ background: "var(--bg-2)" }}
          />
          <div style={SWATCH_ROW_STYLE}>
            {LABEL_SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                data-testid={`settings.colorGroups.color-${group.id}-${slot}`}
                aria-label={t(`notes.colorLabels.${slot}`)}
                aria-pressed={group.color === slot}
                onClick={() =>
                  void setColorGroups(withGroupPatched(groups, index, { color: slot })).catch(failed)
                }
                style={{
                  ...SWATCH_STYLE,
                  background: colorGroupVar(slot),
                  borderColor: group.color === slot ? "var(--accent)" : "transparent",
                }}
              />
            ))}
            <Switch
              on={group.enabled}
              onToggle={() =>
                void setColorGroups(withGroupPatched(groups, index, { enabled: !group.enabled })).catch(
                  failed,
                )
              }
            />
          </div>
        </div>
      ))}
      {/* Which client's value this changes. `color_groups` is SHARED
          (WholeValueLww), so an edit here reaches the other devices, and the
          whole list is replaced rather than merged. */}
      <div style={HINT_STYLE} data-testid="settings.colorGroups.shared-notice">
        {t("notes.graph.colorGroups.mobileSharedNotice")}
      </div>
    </div>
  );
}
