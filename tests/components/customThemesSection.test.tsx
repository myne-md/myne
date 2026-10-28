// @vitest-environment jsdom
//
// Component tests for `src/components/settings/CustomThemesSection.tsx` (custom-
// themes epic, MYND-112; vault-content promotion MYND-486). Drives the picker's
// real handler wiring against mocked IPC-boundary wrappers: empty state, a
// row + preview, Apply (read → persist → apply → mark active), Export (read →
// save .json), the inline two-step delete confirm, and Import (file dialog →
// read picked file → import → the store signal → refresh). Every stored theme
// is valid (import validates before sealing), so there is no invalid-row case.
//
// myne#934 added the store-signal cases: the list refreshes when the store is
// written from ANOTHER surface (the gallery's install dialog), because the row
// is what tells the user their theme arrived.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listCustomThemes = vi.fn();
const readCustomTheme = vi.fn();
const exportCustomTheme = vi.fn();
const importCustomTheme = vi.fn();
const deleteCustomTheme = vi.fn();
const readPickedSmallText = vi.fn();
const pickFiles = vi.fn();
const setCustomTheme = vi.fn();
const prefsRead = vi.fn();
const applyCustomTheme = vi.fn();
const applyTheme = vi.fn();
const saveJsonAsFile = vi.fn();
const openFileDialog = vi.fn();

vi.mock("../../src/lib/themes", () => ({
  listCustomThemes: (...a: unknown[]) => listCustomThemes(...a),
  readCustomTheme: (...a: unknown[]) => readCustomTheme(...a),
  exportCustomTheme: (...a: unknown[]) => exportCustomTheme(...a),
  // The real writers bump the store signal after a write RESOLVES
  // (`src/lib/themes.ts`), and that bump is what refreshes an open picker.
  // Reproduced here rather than stubbed away: a mock that does not bump makes
  // every refresh assertion below vacuous.
  importCustomTheme: async (...a: unknown[]) => {
    await importCustomTheme(...a);
    bumpThemesNonce();
  },
  deleteCustomTheme: async (...a: unknown[]) => {
    await deleteCustomTheme(...a);
    bumpThemesNonce();
  },
  // Pure helper — a light real-ish impl so the row's preview chiplet renders.
  themePreview: (palette: Record<string, string>) => ({
    background: palette["--paper"] ?? "",
    surface: palette["--paper-2"] ?? "",
    foreground: palette["--ink-1"] ?? "",
    accent: palette["--accent"] ?? "",
    line: palette["--line-1"] ?? "",
  }),
}));
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  setCustomTheme: (...a: unknown[]) => setCustomTheme(...a),
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));
vi.mock("../../src/lib/theme", () => ({
  applyCustomTheme: (...a: unknown[]) => applyCustomTheme(...a),
  applyTheme: (...a: unknown[]) => applyTheme(...a),
}));
vi.mock("../../src/lib/secret-export", () => ({
  saveJsonAsFile: (...a: unknown[]) => saveJsonAsFile(...a),
}));
vi.mock("../../src/platform/filePicker", () => ({
  pickFiles: (...a: unknown[]) => pickFiles(...a),
  readPickedSmallText: (...a: unknown[]) => readPickedSmallText(...a),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openFileDialog(...a),
}));

import { CustomThemesSection } from "../../src/components/settings/CustomThemesSection";
import { __resetThemesNonceForTest, bumpThemesNonce } from "../../src/lib/themesSignal";

const PALETTE = {
  "--paper": "#111111",
  "--paper-2": "#222222",
  "--ink-1": "#333333",
  "--accent": "#444444",
  "--line-1": "#555555",
};

function renderSection(activeCustom: string | null = null) {
  const onActiveCustomChange = vi.fn();
  render(
    <CustomThemesSection activeCustom={activeCustom} onActiveCustomChange={onActiveCustomChange} />,
  );
  return { onActiveCustomChange };
}

beforeEach(() => {
  listCustomThemes.mockReset().mockResolvedValue([]);
  readCustomTheme.mockReset().mockResolvedValue(PALETTE);
  exportCustomTheme.mockReset().mockResolvedValue(PALETTE);
  importCustomTheme.mockReset().mockResolvedValue(undefined);
  deleteCustomTheme.mockReset().mockResolvedValue(undefined);
  readPickedSmallText.mockReset().mockResolvedValue(JSON.stringify(PALETTE));
  pickFiles.mockReset().mockResolvedValue(null);
  setCustomTheme.mockReset().mockResolvedValue(undefined);
  prefsRead.mockReset().mockResolvedValue({ theme: "dark", custom_theme: null });
  applyCustomTheme.mockReset();
  applyTheme.mockReset();
  saveJsonAsFile.mockReset().mockResolvedValue(undefined);
  openFileDialog.mockReset().mockResolvedValue(null);
  // Module-scope by design (it is what a mounted picker subscribes to), so a
  // spec that left it advanced would decide the next one.
  __resetThemesNonceForTest();
});

afterEach(cleanup);

describe("CustomThemesSection", () => {
  it("shows the empty state when there are no themes", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId("settings.custom-theme-empty")).toBeTruthy());
  });

  it("renders a theme row with a preview chiplet, Apply, and Export", async () => {
    listCustomThemes.mockResolvedValue([{ name: "solar", palette: PALETTE }]);
    renderSection();
    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-theme-name")).toBe("solar");
    expect(row.getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("settings.custom-theme-apply")).toBeTruthy();
    expect(screen.getByTestId("settings.custom-theme-export")).toBeTruthy();
  });

  it("marks the active theme row Applied and hides its Apply button", async () => {
    listCustomThemes.mockResolvedValue([{ name: "solar", palette: PALETTE }]);
    renderSection("solar");
    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-active")).toBe("true");
    expect(screen.queryByTestId("settings.custom-theme-apply")).toBeNull();
  });

  it("Apply reads the palette, persists the selection, applies it, and marks it active", async () => {
    listCustomThemes.mockResolvedValue([{ name: "solar", palette: PALETTE }]);
    const { onActiveCustomChange } = renderSection();
    fireEvent.click(await screen.findByTestId("settings.custom-theme-apply"));
    await waitFor(() => expect(setCustomTheme).toHaveBeenCalledWith("solar"));
    expect(readCustomTheme).toHaveBeenCalledWith("solar");
    expect(applyCustomTheme).toHaveBeenCalled();
    expect(onActiveCustomChange).toHaveBeenCalledWith("solar");
  });

  it("Export reads the palette and saves it as a .json file", async () => {
    listCustomThemes.mockResolvedValue([{ name: "solar", palette: PALETTE }]);
    renderSection();
    fireEvent.click(await screen.findByTestId("settings.custom-theme-export"));
    await waitFor(() => expect(exportCustomTheme).toHaveBeenCalledWith("solar"));
    await waitFor(() => expect(saveJsonAsFile).toHaveBeenCalled());
    const [defaultPath, contents] = saveJsonAsFile.mock.calls[0];
    expect(defaultPath).toBe("solar.json");
    expect(JSON.parse(contents as string)).toEqual(PALETTE);
  });

  it("Delete is a two-step inline confirm", async () => {
    listCustomThemes.mockResolvedValue([{ name: "solar", palette: PALETTE }]);
    renderSection();
    fireEvent.click(await screen.findByTestId("settings.custom-theme-delete"));
    // First click arms the confirm; nothing deleted yet.
    expect(deleteCustomTheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("settings.custom-theme-delete-confirm"));
    await waitFor(() => expect(deleteCustomTheme).toHaveBeenCalledWith("solar"));
  });

  // #262: through the PICKER SEAM, not `dialog.open` — the browser arm of the
  // dialog is a typed refusal, so on web a perfectly valid theme file was
  // reported as "not a valid theme". The name now comes off the handle's
  // `name`, the one field both platforms carry (a browser handle has no path).
  it("Import goes through the picker seam and imports under the file's stem", async () => {
    const picked = { name: "my-theme.json", size: 12, mimeHint: null, handle: {} };
    pickFiles.mockResolvedValue([picked]);
    renderSection();
    await waitFor(() => expect(listCustomThemes).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.custom-theme-import"));
    await waitFor(() => expect(readPickedSmallText).toHaveBeenCalledWith(picked));
    expect(importCustomTheme).toHaveBeenCalledWith("my-theme", JSON.stringify(PALETTE));
  });

  it("does nothing when the picker is cancelled", async () => {
    pickFiles.mockResolvedValue(null);
    renderSection();
    await waitFor(() => expect(listCustomThemes).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.custom-theme-import"));
    await waitFor(() => expect(pickFiles).toHaveBeenCalled());
    expect(importCustomTheme).not.toHaveBeenCalled();
  });

  // myne#934. The failure this pins is the one that shipped: a theme installed
  // from the gallery's `myne://theme/install` dialog (or applied from the
  // command palette) writes `vault.themes` behind an ALREADY-OPEN panel. The
  // store write succeeds, the palette paints, and the panel keeps advertising
  // "No custom themes yet" until Settings is closed and reopened, because the
  // list was read exactly once on mount.
  it("lists a theme installed from another surface, without a remount", async () => {
    renderSection();
    await waitFor(() =>
      expect(screen.getByTestId("settings.custom-theme-empty")).toBeTruthy(),
    );

    // Another surface wrote the store; the signal is all this panel gets.
    listCustomThemes.mockResolvedValue([{ name: "nord", palette: PALETTE }]);
    act(() => bumpThemesNonce());

    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-theme-name")).toBe("nord");
    expect(screen.queryByTestId("settings.custom-theme-empty")).toBeNull();
  });

  // The panel's OWN import went through the same signal, so the path a user
  // actually takes is covered by the same mechanism as the external one. This
  // is what fails if the section keeps a private `refresh()` call instead of
  // subscribing: the mock's bump would be the only route to a row.
  it("Import lands the imported theme in the list through the store signal", async () => {
    const picked = { name: "my-theme.json", size: 12, mimeHint: null, handle: {} };
    pickFiles.mockResolvedValue([picked]);
    renderSection();
    await waitFor(() => expect(listCustomThemes).toHaveBeenCalledTimes(1));

    listCustomThemes.mockResolvedValue([{ name: "my-theme", palette: PALETTE }]);
    fireEvent.click(screen.getByTestId("settings.custom-theme-import"));

    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-theme-name")).toBe("my-theme");
  });
});
