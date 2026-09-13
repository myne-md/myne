// Task-surface display settings (myne-md/myne#656 item 4). Device-local: lives
// as a top-level key on the `NamedWorkspaces` container, NOT in `vault.prefs`
// (the `graphSettings` precedent), so it never enters the sync classification
// table or the spec field roster.
//
// **The stored value never reaches a style position.** `chipColor` is a closed
// enum, and it selects a KEY in `TASK_CHIP_INK`, whose values are tokens this
// module owns. So a tampered descriptor cannot land an arbitrary string in a
// style — the worst it can do is fail the membership check and decode to the
// default. That is the value-shape validation the issue requires, done at the
// source instead of by a downstream sanitizer.

export const TASK_CHIP_COLORS = ["theme", "accent", "danger", "muted"] as const;
export type TaskChipColor = (typeof TASK_CHIP_COLORS)[number];

export interface TaskDisplaySettings {
  /** The ink of a task chip's icon and label. `theme` is the default and matches
   *  the pre-feature look. There is deliberately no "fill" option: the canon
   *  forbids state-as-fill (`taskChipToken.ts`). */
  chipColor: TaskChipColor;
}

export const DEFAULT_TASK_DISPLAY: Readonly<TaskDisplaySettings> = {
  chipColor: "theme",
};

/**
 * The curated enum to the token it selects. A `Record` over the enum so a new
 * value cannot be added without a token here, and the token is never derived
 * from the stored string.
 */
export const TASK_CHIP_INK: Record<TaskChipColor, string> = {
  theme: "var(--fg-1)",
  accent: "var(--accent)",
  danger: "var(--danger)",
  muted: "var(--fg-3)",
};

/** Encode omit-when-default; `undefined` drops the whole key. */
export function encodeTaskDisplay(
  settings: TaskDisplaySettings,
): Record<string, unknown> | undefined {
  if (settings.chipColor === DEFAULT_TASK_DISPLAY.chipColor) return undefined;
  return { chipColor: settings.chipColor };
}

/** Decode defensively: anything not a known colour becomes the default. */
export function decodeTaskDisplay(raw: unknown): TaskDisplaySettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_TASK_DISPLAY };
  const o = raw as Record<string, unknown>;
  const color = o.chipColor;
  return {
    chipColor: (TASK_CHIP_COLORS as readonly unknown[]).includes(color)
      ? (color as TaskChipColor)
      : DEFAULT_TASK_DISPLAY.chipColor,
  };
}
