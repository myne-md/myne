// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AppearancePanel.tsx`. Covers the
// disk-first theme segmented control (persist → apply, error banner on write
// failure, same-segment no-op) and the optimistic "Show edit times" toggle
// (flip-then-persist, revert + error on failure). The prefs setters + applyTheme
// are mocked at the lib boundary.
//
// Also covers the MYND-604 graph pointer row: the panel carries no graph
// controls of its own — the row exists only to say where they live and to open
// the graph — so the test asserts exactly that (label + working action + the
// defensive disabled degrade when no handler is supplied).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setTheme = vi.fn();
const setCustomTheme = vi.fn();
const setShowNoteTimestamps = vi.fn();
const applyTheme = vi.fn();

vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setTheme: (...a: unknown[]) => setTheme(...a),
  setCustomTheme: (...a: unknown[]) => setCustomTheme(...a),
  setShowNoteTimestamps: (...a: unknown[]) => setShowNoteTimestamps(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));
vi.mock("../../src/lib/theme", () => ({
  applyTheme: (...a: unknown[]) => applyTheme(...a),
}));
// The Custom themes subsection has its own test (customThemesSection.test.tsx);
// stub it here so AppearancePanel's own logic (theme segmented + timestamps) is
// tested in isolation, without the section's IPC/dialog/opener imports.
vi.mock("../../src/components/settings/CustomThemesSection", () => ({
  CustomThemesSection: () => null,
}));

import { AppearancePanel } from "../../src/components/settings/AppearancePanel";

const BASE = { theme: null, custom_theme: null, show_note_timestamps: true };

beforeEach(() => {
  prefsRead.mockReset().mockResolvedValue({ ...BASE });
  setTheme.mockReset().mockResolvedValue(undefined);
  setCustomTheme.mockReset().mockResolvedValue(undefined);
  setShowNoteTimestamps.mockReset().mockResolvedValue(undefined);
  applyTheme.mockReset();
});

afterEach(cleanup);

describe("AppearancePanel — theme segmented control", () => {
  it("defaults to System when no theme is stored", async () => {
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    expect(
      screen.getByTestId("settings.theme-system").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("seeds the stored theme (dark) as the selected segment", async () => {
    prefsRead.mockResolvedValue({ ...BASE, theme: "dark" });
    render(<AppearancePanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.theme-dark").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("choosing Dark persists then applies it (disk-first order)", async () => {
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.theme-dark"));
    });
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(applyTheme).toHaveBeenCalledWith("dark");
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.theme-dark").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("seeds the stored theme (amoled) as the selected segment", async () => {
    prefsRead.mockResolvedValue({ ...BASE, theme: "amoled" });
    render(<AppearancePanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.theme-amoled").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("choosing AMOLED persists then applies it (disk-first order)", async () => {
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.theme-amoled"));
    });
    expect(setTheme).toHaveBeenCalledWith("amoled");
    expect(applyTheme).toHaveBeenCalledWith("amoled");
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.theme-amoled").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("System maps to the null wire value", async () => {
    prefsRead.mockResolvedValue({ ...BASE, theme: "light" });
    render(<AppearancePanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.theme-light").getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.theme-system"));
    });
    expect(setTheme).toHaveBeenCalledWith(null);
  });

  it("clicking the already-selected segment is a no-op", async () => {
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.theme-system")); // already system
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("shows an error banner and keeps the old segment when persistence fails", async () => {
    setTheme.mockRejectedValueOnce(new Error("disk"));
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.theme-dark"));
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Couldn't save theme",
      ),
    );
    // applyTheme never ran (disk-first: persist failed before apply).
    expect(applyTheme).not.toHaveBeenCalled();
    // Segment stays on system.
    expect(
      screen.getByTestId("settings.theme-system").getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("AppearancePanel — graph settings pointer row (MYND-604)", () => {
  it("renders the row with its i18n label, helper and action", async () => {
    render(<AppearancePanel onOpenGraph={() => {}} />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    expect(screen.getByText("Graph appearance")).toBeTruthy();
    expect(
      screen.getByText(/set inside the graph itself/i),
    ).toBeTruthy();
    expect(screen.getByTestId("settings.open-graph").textContent).toBe(
      "Open graph",
    );
  });

  it("clicking the action opens the graph", async () => {
    const onOpenGraph = vi.fn();
    render(<AppearancePanel onOpenGraph={onOpenGraph} />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.open-graph"));
    expect(onOpenGraph).toHaveBeenCalledTimes(1);
  });

  it("disables the action when no handler is supplied", async () => {
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    expect(
      (screen.getByTestId("settings.open-graph") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("AppearancePanel — show edit times toggle", () => {
  it("optimistically flips then persists the new value", async () => {
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const toggle = screen.getByTestId("settings.note-timestamps-toggle");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setShowNoteTimestamps).toHaveBeenCalledWith(false);
  });

  it("reverts + shows an error when the timestamp write fails", async () => {
    setShowNoteTimestamps.mockRejectedValueOnce(new Error("io"));
    render(<AppearancePanel />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    const toggle = screen.getByTestId("settings.note-timestamps-toggle");
    const before = toggle.getAttribute("aria-checked");
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't save preference/i),
      ).toBeTruthy(),
    );
    // Reverted to the original checked state.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("settings.note-timestamps-toggle")
          .getAttribute("aria-checked"),
      ).toBe(before),
    );
  });
});
