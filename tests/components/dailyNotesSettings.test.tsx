// @vitest-environment jsdom
//
// Component tests for `src/components/settings/DailyNotesSettings.tsx`. Asserts
// the disk-first persistence wiring of all three controls: the daily-folder +
// date-format fields persist on blur (and skip the write when blank), and the
// template designator maps the Blank sentinel to a `null` pref while a real
// template maps to its UUID. The prefs setters + `listTemplates` are mocked at
// the lib boundary; the SearchableSelect primitive renders for real so the
// option-pick path is exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setDailyDateFormat = vi.fn();
const setDailyFolder = vi.fn();
const setDailyTemplate = vi.fn();
const listTemplates = vi.fn();

vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setDailyDateFormat: (...a: unknown[]) => setDailyDateFormat(...a),
  setDailyFolder: (...a: unknown[]) => setDailyFolder(...a),
  setDailyTemplate: (...a: unknown[]) => setDailyTemplate(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));
// The folder PICKER (MYND-624) enumerates the vault; these tests are about the
// persistence wiring, so stub it empty and exercise the free-text fallback the
// component renders for a vault with no folders yet.
vi.mock("../../src/notes/listFolderPaths", () => ({
  listFolderPaths: () => Promise.resolve([]),
}));
vi.mock("../../src/notes", () => ({
  listTemplates: (...a: unknown[]) => listTemplates(...a),
  DEFAULT_DAILY_FOLDER: "Daily/",
  DEFAULT_DAILY_DATE_FORMAT: "YYYY-MM-DD",
}));

import { DailyNotesSettings } from "../../src/components/settings/DailyNotesSettings";

const BASE_PREFS = {
  daily_folder: null,
  daily_date_format: null,
  daily_template: null,
};

beforeEach(() => {
  prefsRead.mockReset().mockResolvedValue({ ...BASE_PREFS });
  setDailyDateFormat.mockReset().mockResolvedValue(undefined);
  setDailyFolder.mockReset().mockResolvedValue(undefined);
  setDailyTemplate.mockReset().mockResolvedValue(undefined);
  listTemplates.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe("DailyNotesSettings — folder + format persistence", () => {
  it("persists the trimmed folder on blur", async () => {
    render(<DailyNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const input = screen.getByLabelText("Daily note folder");
    fireEvent.change(input, { target: { value: "Journal/" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(setDailyFolder).toHaveBeenCalledWith("Journal/"),
    );
  });

  it("skips the folder write when the field is left blank", async () => {
    render(<DailyNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const input = screen.getByLabelText("Daily note folder");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    await Promise.resolve();
    expect(setDailyFolder).not.toHaveBeenCalled();
  });

  it("persists the date format on blur", async () => {
    render(<DailyNotesSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const input = screen.getByLabelText("Daily note date format");
    fireEvent.change(input, { target: { value: "DD-MM-YYYY" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(setDailyDateFormat).toHaveBeenCalledWith("DD-MM-YYYY"),
    );
  });

  it("seeds the fields from the loaded prefs", async () => {
    prefsRead.mockResolvedValue({
      daily_folder: "Notes/Daily/",
      daily_date_format: "YYYY/MM/DD",
      daily_template: null,
    });
    render(<DailyNotesSettings />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Daily note folder") as HTMLInputElement).value,
      ).toBe("Notes/Daily/"),
    );
    expect(
      (screen.getByLabelText("Daily note date format") as HTMLInputElement)
        .value,
    ).toBe("YYYY/MM/DD");
  });
});

describe("DailyNotesSettings — template designator", () => {
  it("designates a real template by its UUID", async () => {
    listTemplates.mockResolvedValue([
      { noteUuid: "tmpl-1", title: "Standup", folder: null, updatedAt: null, trashed: null, template: true },
    ]);
    render(<DailyNotesSettings />);
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("settings.daily-template-select"));
    const opt = (
      await screen.findAllByTestId("settings.daily-template-select-option")
    ).find((el) => el.getAttribute("data-value") === "tmpl-1");
    expect(opt).toBeTruthy();
    fireEvent.click(opt!);
    await waitFor(() =>
      expect(setDailyTemplate).toHaveBeenCalledWith("tmpl-1"),
    );
  });

  it("the Blank sentinel clears the template to null", async () => {
    prefsRead.mockResolvedValue({ ...BASE_PREFS, daily_template: "tmpl-9" });
    listTemplates.mockResolvedValue([
      { noteUuid: "tmpl-9", title: "Old", folder: null, updatedAt: null, trashed: null, template: true },
    ]);
    render(<DailyNotesSettings />);
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("settings.daily-template-select"));
    const blank = (
      await screen.findAllByTestId("settings.daily-template-select-option")
    ).find((el) => el.getAttribute("data-value") === "");
    expect(blank).toBeTruthy();
    fireEvent.click(blank!);
    await waitFor(() => expect(setDailyTemplate).toHaveBeenCalledWith(null));
  });
});
