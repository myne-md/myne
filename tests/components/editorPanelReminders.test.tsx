// @vitest-environment jsdom
//
// The join myne#508 was actually about: `EditorPanel` wiring the horizon row to
// a setter.
//
// Every layer around it already had a passing test before this file existed.
// `reminderHorizonPicker.test.tsx` proves `ReminderHorizonSettings` calls its
// `onChange` prop; `usePrefs.test.ts` proves `setReminderHorizon` persists;
// `check-ipc-binding-callers.mjs` is satisfied because `usePrefs` calls the
// binding. Replacing the panel's `onChange` with a no-op left all of that green,
// which is the same shape as the bug: a setter with a Rust core, an ACL row and
// its own tests, reached by nothing.
//
// The panel's other rows are stubbed, not because they are irrelevant but
// because each one reads prefs on mount and this file is about one wire.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { REMINDER_HORIZON_CHOICES } from "../../src/lib/reminderSchedule";

const setReminderHorizon = vi.fn();
let remindersEnabled = true;

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: {
      reminders_enabled: remindersEnabled,
      reminder_horizon_days: null,
      developer_mode: false,
    },
    setReminderHorizon,
  }),
}));

// The Editor panel gained a device-local task-chip-colour row (myne-md/myne#656),
// which reads the workspace container. Stub it here; this file is about the
// reminder wire, not the task display.
vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    taskDisplay: { chipColor: "theme", iconOnly: false },
    setTaskDisplay: vi.fn(),
  }),
}));

const stub = (id: string) => () => <div data-testid={id} />;
vi.mock("../../src/components/settings/TypographySettings", () => ({
  TypographySettings: stub("stub.typography"),
}));
vi.mock("../../src/components/settings/LineNumbersSettings", () => ({
  LineNumbersSettings: stub("stub.line-numbers"),
}));
vi.mock("../../src/components/settings/DefaultViewModeSettings", () => ({
  DefaultViewModeSettings: stub("stub.view-mode"),
}));
vi.mock("../../src/components/settings/DateTimeSettings", () => ({
  DateTimeSettings: stub("stub.date-time"),
}));
vi.mock("../../src/components/settings/FocusModeSettings", () => ({
  FocusModeSettings: stub("stub.focus-mode"),
}));
vi.mock("../../src/components/settings/ToolbarCustomizeSettings", () => ({
  ToolbarCustomizeSettings: stub("stub.toolbar"),
}));
vi.mock("../../src/components/settings/SpellSettings", () => ({
  SpellSettings: stub("stub.spell"),
}));
vi.mock("../../src/components/settings/DailyNotesSettings", () => ({
  DailyNotesSettings: stub("stub.daily-notes"),
}));
vi.mock("../../src/components/settings/ArchiveSettings", () => ({
  ArchiveSettings: stub("stub.archive"),
}));
vi.mock("../../src/components/settings/ViewsSettings", () => ({
  ViewsSettings: stub("stub.views"),
}));
vi.mock("../../src/components/settings/VimModeSettings", () => ({
  VimModeSettings: stub("stub.vim"),
}));

const { EditorPanel } = await import("../../src/components/settings/EditorPanel");

afterEach(() => {
  cleanup();
  setReminderHorizon.mockClear();
  remindersEnabled = true;
});

describe("the Editor panel's horizon row", () => {
  it("reaches the setter when a horizon is chosen", () => {
    render(<EditorPanel />);
    const shortest = REMINDER_HORIZON_CHOICES[0];
    // The row is a `Select` (myne-md/myne#769): open its menu, then pick the
    // option carrying the wire value (the portal'd options share one testid).
    fireEvent.click(screen.getByTestId("settings.reminders-horizon-picker"));
    const chosen = screen
      .getAllByRole("option")
      .find((el) => el.dataset.value === String(shortest));
    expect(chosen).toBeTruthy();
    fireEvent.click(chosen as HTMLElement);
    expect(setReminderHorizon).toHaveBeenCalledWith(shortest);
  });

  it("renders the row beside the switch, not nested under it", () => {
    // Two sibling `SettingRow`s: the canon's shape for a setting, and what gives
    // the picker a visible label of its own.
    render(<EditorPanel />);
    expect(screen.getByTestId("settings.reminders")).toBeTruthy();
    expect(screen.getByTestId("settings.reminders-horizon-row")).toBeTruthy();
  });

  it("hides the row while reminders are off", () => {
    remindersEnabled = false;
    render(<EditorPanel />);
    expect(screen.getByTestId("settings.reminders")).toBeTruthy();
    expect(screen.queryByTestId("settings.reminders-horizon-row")).toBeNull();
  });
});
