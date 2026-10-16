// @vitest-environment jsdom
//
// Component tests for `src/components/settings/PeriodicNotesSettings.tsx`.
// Asserts the disk-first persistence wiring of all three periods: the daily
// section still writes the three legacy top-level setters (the no-migration
// decision, `protocol.md` §9.5), the weekly and monthly sections write one
// `periodic_notes` entry each, blank fields skip the write, the template
// designator maps the Blank sentinel to a `null` pref, and the collision
// warning appears only when two periods share BOTH folder and format.
//
// The prefs setters + `listTemplates` are mocked at the lib boundary; the
// SearchableSelect primitive renders for real so the option-pick path is
// exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setDailyDateFormat = vi.fn();
const setDailyFolder = vi.fn();
const setDailyTemplate = vi.fn();
const setPeriodicNoteSetting = vi.fn();
const listTemplates = vi.fn();

vi.mock("../../src/lib/prefs", () => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setDailyDateFormat: (...a: unknown[]) => setDailyDateFormat(...a),
  setDailyFolder: (...a: unknown[]) => setDailyFolder(...a),
  setDailyTemplate: (...a: unknown[]) => setDailyTemplate(...a),
  setPeriodicNoteSetting: (...a: unknown[]) => setPeriodicNoteSetting(...a),
}));
// The folder PICKER enumerates the vault; these tests are about the persistence
// wiring, so stub it empty and exercise the free-text fallback the component
// renders for a vault with no folders yet.
vi.mock("../../src/notes/listFolderPaths", () => ({
  listFolderPaths: () => Promise.resolve([]),
}));
vi.mock("../../src/notes", async () => {
  // `periodSettings`, `PERIODS` and `PERIOD_DEFAULTS` are pure and are the
  // thing under test here (which period reads which prefs shape), so they run
  // for real rather than being stubbed into agreement with the component.
  const real = await vi.importActual<typeof import("../../src/notes/dailyNote")>(
    "../../src/notes/dailyNote",
  );
  return {
    listTemplates: (...a: unknown[]) => listTemplates(...a),
    PERIODS: real.PERIODS,
    PERIOD_DEFAULTS: real.PERIOD_DEFAULTS,
    periodSettings: real.periodSettings,
    // The collision warning asks the resolver's own question (same folded
    // folder, fold-equal rendered title), so it renders titles for real.
    periodRange: real.periodRange,
    formatDailyDate: real.formatDailyDate,
  };
});

import {
  PeriodicNotesSettings,
  collidingPeriods,
  periodOfAnchor,
} from "../../src/components/settings/PeriodicNotesSettings";
import { SETTINGS_SEARCH_INDEX } from "../../src/components/settings/search/settingsSearchIndex";

const BASE_PREFS = {
  daily_folder: null,
  daily_date_format: null,
  daily_template: null,
  periodic_notes: {},
};

beforeEach(() => {
  prefsRead.mockReset().mockResolvedValue({ ...BASE_PREFS });
  setDailyDateFormat.mockReset().mockResolvedValue(undefined);
  setDailyFolder.mockReset().mockResolvedValue(undefined);
  setDailyTemplate.mockReset().mockResolvedValue(undefined);
  setPeriodicNoteSetting.mockReset().mockResolvedValue(undefined);
  listTemplates.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

/**
 * Move the period switcher. The block renders ONE period at a time, so a test
 * that wants the weekly rows has to open weekly first — the tab is part of the
 * surface now, not a detail of it.
 */
function selectPeriod(period: "daily" | "weekly" | "monthly") {
  fireEvent.click(screen.getByTestId(`settings.periodic-period-${period}`));
}

describe("PeriodicNotesSettings: daily keeps its legacy setters", () => {
  it("persists the daily folder through setDailyFolder, not the map", async () => {
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const input = screen.getByTestId("settings.daily-folder-input");
    fireEvent.change(input, { target: { value: "Journal/" } });
    fireEvent.blur(input);
    await waitFor(() => expect(setDailyFolder).toHaveBeenCalledWith("Journal/"));
    expect(setPeriodicNoteSetting).not.toHaveBeenCalled();
  });

  it("persists the daily format through setDailyDateFormat", async () => {
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const input = screen.getByTestId("settings.daily-format-input");
    fireEvent.change(input, { target: { value: "DD-MM-YYYY" } });
    fireEvent.blur(input);
    await waitFor(() => expect(setDailyDateFormat).toHaveBeenCalledWith("DD-MM-YYYY"));
  });

  it("skips the write when a field is left blank", async () => {
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const input = screen.getByTestId("settings.daily-folder-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    await Promise.resolve();
    expect(setDailyFolder).not.toHaveBeenCalled();
  });

  it("seeds every period's fields from the loaded prefs", async () => {
    prefsRead.mockResolvedValue({
      daily_folder: "Notes/Daily/",
      daily_date_format: "YYYY/MM/DD",
      daily_template: null,
      periodic_notes: { "weekly.folder": "W/", "monthly.format": "YYYY_MM" },
    });
    render(<PeriodicNotesSettings />);
    await waitFor(() =>
      expect((screen.getByTestId("settings.daily-folder-input") as HTMLInputElement).value).toBe(
        "Notes/Daily/",
      ),
    );
    // Each period keeps its own value in the state the read seeded; the switcher
    // only decides which of the three is on screen.
    selectPeriod("weekly");
    expect((screen.getByTestId("settings.weekly-folder-input") as HTMLInputElement).value).toBe(
      "W/",
    );
    selectPeriod("monthly");
    expect((screen.getByTestId("settings.monthly-format-input") as HTMLInputElement).value).toBe(
      "YYYY_MM",
    );
  });
  it("designates a daily template by its UUID, through the legacy setter", () => {
    // The arm the map-writing sibling cannot reach: `persist` falls through two
    // `if`s to `setDailyTemplate`, so a reorder of those breaks it in silence.
    listTemplates.mockResolvedValue([
      {
        noteUuid: "tmpl-1",
        title: "Journal skeleton",
        folder: null,
        updatedAt: null,
        trashed: null,
        template: true,
      },
    ]);
    return (async () => {
      render(<PeriodicNotesSettings />);
      await waitFor(() => expect(listTemplates).toHaveBeenCalled());

      fireEvent.click(screen.getByTestId("settings.daily-template-select"));
      const option = (
        await screen.findAllByTestId("settings.daily-template-select-option")
      ).find((el) => el.getAttribute("data-value") === "tmpl-1");
      expect(option).toBeTruthy();
      fireEvent.click(option!);

      await waitFor(() => expect(setDailyTemplate).toHaveBeenCalledWith("tmpl-1"));
      // Daily never touches the map: that would be a second home for one setting.
      expect(setPeriodicNoteSetting).not.toHaveBeenCalled();
    })();
  });
});

describe("PeriodicNotesSettings: weekly and monthly write the map", () => {
  it("writes one entry per setting, naming the period and the setting", async () => {
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    selectPeriod("weekly");
    const folder = screen.getByTestId("settings.weekly-folder-input");
    fireEvent.change(folder, { target: { value: "Weeks/" } });
    fireEvent.blur(folder);
    await waitFor(() =>
      expect(setPeriodicNoteSetting).toHaveBeenCalledWith("weekly", "folder", "Weeks/"),
    );

    selectPeriod("monthly");
    const format = screen.getByTestId("settings.monthly-format-input");
    fireEvent.change(format, { target: { value: "MM.YYYY" } });
    fireEvent.blur(format);
    await waitFor(() =>
      expect(setPeriodicNoteSetting).toHaveBeenCalledWith("monthly", "format", "MM.YYYY"),
    );
    // The legacy daily setters must not be reached for another period.
    expect(setDailyFolder).not.toHaveBeenCalled();
    expect(setDailyDateFormat).not.toHaveBeenCalled();
  });

  it("clears a period template to null through the Blank sentinel", async () => {
    listTemplates.mockResolvedValue([
      {
        noteUuid: "tmpl-9",
        title: "Weekly review",
        folder: null,
        updatedAt: null,
        trashed: null,
        template: true,
      },
    ]);
    prefsRead.mockResolvedValue({
      ...BASE_PREFS,
      periodic_notes: { "weekly.template": "tmpl-9" },
    });
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());

    selectPeriod("weekly");
    fireEvent.click(screen.getByTestId("settings.weekly-template-select"));
    const blank = (
      await screen.findAllByTestId("settings.weekly-template-select-option")
    ).find((el) => el.getAttribute("data-value") === "");
    expect(blank).toBeTruthy();
    fireEvent.click(blank!);
    await waitFor(() =>
      expect(setPeriodicNoteSetting).toHaveBeenCalledWith("weekly", "template", null),
    );
  });
});

describe("PeriodicNotesSettings: the period switcher", () => {
  it("renders exactly one period's rows, and the switcher moves between them", async () => {
    // The height win IS this: three periods at once was nine rows, and the
    // non-selected two must not be in the DOM at all. A test that only asserted
    // the switcher's selection would pass with all nine still rendered.
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    expect(screen.getByTestId("settings.daily-folder-input")).toBeTruthy();
    expect(screen.queryByTestId("settings.weekly-folder-input")).toBeNull();
    expect(screen.queryByTestId("settings.monthly-folder-input")).toBeNull();

    selectPeriod("monthly");
    expect(screen.getByTestId("settings.monthly-folder-input")).toBeTruthy();
    expect(screen.queryByTestId("settings.daily-folder-input")).toBeNull();
    expect(
      screen.getByTestId("settings.periodic-period-monthly").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("comes back to a period's EDITED value after a round trip", async () => {
    // The switcher must not reset what the user typed: the edit lives in this
    // component's state, not in the rendered field, and a switcher that remounted
    // the rows from `persisted` would silently drop an unblurred edit.
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    const input = screen.getByTestId("settings.daily-folder-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Journal/" } });
    selectPeriod("weekly");
    selectPeriod("daily");
    expect((screen.getByTestId("settings.daily-folder-input") as HTMLInputElement).value).toBe(
      "Journal/",
    );
    expect(setDailyFolder).not.toHaveBeenCalled();
  });
});

describe("PeriodicNotesSettings: a settings-search jump (MYND-536)", () => {
  it("opens the period that owns the target before the shell looks for it", async () => {
    // Without the adoption the weekly anchor is not in the DOM and the shell's
    // resolver (SettingsModal: `pendingScroll` -> rAF -> `[data-setting-anchor]`)
    // degrades to a silent panel switch with nothing highlighted. This asserts
    // the half that can be asserted here: the row EXISTS once the target is
    // handed in, in the same commit.
    render(<PeriodicNotesSettings focusAnchorId="editor.weekly-notes-template" />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    expect(screen.getByTestId("settings.weekly-template-select")).toBeTruthy();
    expect(
      screen.getByTestId("settings.periodic-period-weekly").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the user's tab once the shell clears its pending target", async () => {
    const { rerender } = render(
      <PeriodicNotesSettings focusAnchorId="editor.monthly-notes-folder" />,
    );
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    // The shell clears `pendingScroll` after the scroll/flash; that must not
    // snap the block back to Daily.
    rerender(<PeriodicNotesSettings />);
    expect(screen.getByTestId("settings.monthly-folder-input")).toBeTruthy();
    expect(screen.queryByTestId("settings.daily-folder-input")).toBeNull();
  });

  it("takes the SAME anchor twice, which a stale adopted value would skip", async () => {
    // Search -> jump -> clear -> search for the same setting again. Comparing the
    // new target against the last adopted one and doing nothing would leave the
    // second jump unrenderable; the reset on `undefined` is what makes it work.
    const { rerender } = render(
      <PeriodicNotesSettings focusAnchorId="editor.weekly-notes-folder" />,
    );
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    rerender(<PeriodicNotesSettings />);
    selectPeriod("daily");
    rerender(<PeriodicNotesSettings focusAnchorId="editor.weekly-notes-folder" />);
    expect(screen.getByTestId("settings.weekly-folder-input")).toBeTruthy();
  });

  it("resolves every periodic anchor the search registry publishes", () => {
    // The contract that makes the jump work is that the registry's `id` and this
    // block's `anchorId` are the same string. Renaming the anchor format without
    // this helper would leave search scrolling to nothing, silently.
    const periodic = SETTINGS_SEARCH_INDEX.filter(
      (e) => e.panelId === "editor" && e.id.includes("-notes-"),
    );
    expect(periodic.length).toBe(9);
    for (const entry of periodic) {
      expect(periodOfAnchor(entry.id), entry.id).not.toBeNull();
    }
    // The other direction, so the helper is not "everything is a period".
    for (const id of ["editor.vim-mode", "editor.reminders", "privacy.cli-access"]) {
      expect(periodOfAnchor(id), id).toBeNull();
    }
  });
});

describe("PeriodicNotesSettings: the collision warning", () => {
  it("stays hidden on the defaults, which do not collide", async () => {
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.periodic-collision-warning")).toBeNull();
  });

  it("appears when two periods share BOTH folder and format", async () => {
    prefsRead.mockResolvedValue({
      daily_folder: "Same/",
      daily_date_format: "YYYY-MM",
      daily_template: null,
      periodic_notes: { "monthly.folder": "Same/", "monthly.format": "YYYY-MM" },
    });
    render(<PeriodicNotesSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings.periodic-collision-warning")).toBeTruthy(),
    );
  });

  it("offers the other period of the pair, because only one has rows on screen", async () => {
    // The tabs created this problem: the warning names two periods and the
    // visible tab holds one of them, so without the jump the user is told about a
    // collision whose other half they cannot look at.
    prefsRead.mockResolvedValue({
      daily_folder: "Same/",
      daily_date_format: "YYYY-MM",
      daily_template: null,
      periodic_notes: { "monthly.folder": "Same/", "monthly.format": "YYYY-MM" },
    });
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    const jump = screen.getByTestId("settings.periodic-collision-jump");
    // Daily is on screen, so the offer is Monthly.
    expect(jump.textContent).toBe("Monthly notes");
    fireEvent.click(jump);
    expect(screen.getByTestId("settings.monthly-folder-input")).toBeTruthy();
    expect(
      screen.getByTestId("settings.periodic-period-monthly").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("stays hidden when they share only the folder", async () => {
    // Sharing a folder is a perfectly ordinary layout: one Journal/ holding
    // daily and weekly notes. Only folder AND format together resolve to one
    // note, so warning on the folder alone would train the warning away.
    prefsRead.mockResolvedValue({
      daily_folder: "Same/",
      daily_date_format: null,
      daily_template: null,
      periodic_notes: { "monthly.folder": "Same/" },
    });
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.periodic-collision-warning")).toBeNull();
  });
});

describe("PeriodicNotesSettings: a refused write", () => {
  it("reports under the control that failed, names its period, and puts the value back", async () => {
    prefsRead.mockResolvedValue({
      daily_folder: null,
      daily_date_format: null,
      daily_template: null,
      periodic_notes: { "weekly.folder": "Weekly/" },
    });
    setPeriodicNoteSetting.mockRejectedValue(new Error("disk full"));
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    selectPeriod("weekly");

    const input = screen.getByTestId("settings.weekly-folder-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Elsewhere/" } });
    fireEvent.blur(input);

    const alert = await screen.findByRole("alert");

    // 1. The row. Keyed by period alone, this landed under Weekly, Template.
    const row = alert.closest("[data-setting-row]");
    expect(row?.getAttribute("data-setting-anchor")).toBe("editor.weekly-notes-folder");

    // 2. The period. The old strings said "daily" for all three.
    expect(alert.textContent).toContain("weekly");
    expect(alert.textContent).not.toContain("daily");

    // 3. The value. Without the revert the field still shows what the user
    //    typed while the vault holds the old folder, which is the same screen a
    //    successful write produces.
    await waitFor(() => expect(input.value).toBe("Weekly/"));
  });

  it("leaves the other two rows of that period alone", async () => {
    prefsRead.mockResolvedValue({
      daily_folder: null,
      daily_date_format: null,
      daily_template: null,
      periodic_notes: { "weekly.folder": "Weekly/" },
    });
    setPeriodicNoteSetting.mockRejectedValue(new Error("disk full"));
    render(<PeriodicNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    selectPeriod("weekly");

    const input = screen.getByTestId("settings.weekly-folder-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Elsewhere/" } });
    fireEvent.blur(input);
    await screen.findByRole("alert");

    // One message, not one per row: the key is the setting, not the period.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("collidingPeriods", () => {
  const of = (
    daily: [string, string],
    weekly: [string, string],
    monthly: [string, string],
  ) => ({
    daily: { folder: daily[0], format: daily[1] },
    weekly: { folder: weekly[0], format: weekly[1] },
    monthly: { folder: monthly[0], format: monthly[1] },
  });

  it("reports no collision for distinct configurations", () => {
    expect(collidingPeriods(of(["D/", "a"], ["W/", "b"], ["M/", "c"]))).toBeNull();
  });

  it("reports the pair, not merely a boolean", () => {
    expect(collidingPeriods(of(["D/", "a"], ["X/", "z"], ["X/", "z"]))).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  it("catches a collision between the first and last period too", () => {
    // A loop that only compared neighbours would miss daily against monthly.
    expect(collidingPeriods(of(["X/", "z"], ["W/", "b"], ["X/", "z"]))).toEqual([
      "daily",
      "monthly",
    ]);
  });

  it("folds the folder the way the resolver does", () => {
    // `folderKey` is case-fold + NFC, so `Journal/` and `journal/` are ONE
    // folder to the resolver. A raw string compare called them two and left the
    // collision unwarned.
    expect(collidingPeriods(of(["D/", "a"], ["Journal/", "z"], ["journal/", "z"]))).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  it("folds the rendered TITLE, not the format as typed", () => {
    // The resolver matches on `foldSegment(title)`, so `gggg-[W]ww` and
    // `gggg-[w]ww` render two strings that are one note. Comparing the format
    // strings said they differed.
    expect(collidingPeriods(of(["D/", "a"], ["X/", "gggg-[W]ww"], ["X/", "gggg-[w]ww"]))).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  it("catches two DIFFERENT formats that render the same title", () => {
    // `YYYY-MM` and `gggg-MM` render the same string for most of the year, and
    // for the whole of any month that does not straddle a week-year boundary.
    // Comparing format strings could not see it at all.
    expect(collidingPeriods(of(["D/", "a"], ["X/", "YYYY-MM"], ["X/", "gggg-MM"]))).toEqual([
      "weekly",
      "monthly",
    ]);
  });

  it("still reports nothing when only the folder is shared", () => {
    // The other direction, so the fold does not turn the warning into noise:
    // one Journal/ holding daily and weekly notes is an ordinary layout.
    expect(
      collidingPeriods(of(["D/", "a"], ["Journal/", "YYYY-MM-DD"], ["journal/", "YYYY-MM"])),
    ).toBeNull();
  });
});
