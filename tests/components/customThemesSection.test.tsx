// @vitest-environment jsdom
//
// Component tests for `src/components/settings/CustomThemesSection.tsx` (custom-
// themes epic, MYND-112). Drives the picker's real handler wiring against mocked
// IPC-boundary wrappers: empty state, valid/active/invalid rows, Apply (read →
// persist → apply → mark active), the inline two-step delete confirm, and Import
// (file dialog → import → refresh). The Tauri dialog/opener plugins are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listCustomThemes = vi.fn();
const readCustomTheme = vi.fn();
const deleteCustomTheme = vi.fn();
const importCustomTheme = vi.fn();
const ensureThemesDir = vi.fn();
const setCustomTheme = vi.fn();
const prefsRead = vi.fn();
const applyCustomTheme = vi.fn();
const applyTheme = vi.fn();
const openFileDialog = vi.fn();
const revealItemInDir = vi.fn();

vi.mock("../../src/lib/themes", () => ({
  listCustomThemes: (...a: unknown[]) => listCustomThemes(...a),
  readCustomTheme: (...a: unknown[]) => readCustomTheme(...a),
  deleteCustomTheme: (...a: unknown[]) => deleteCustomTheme(...a),
  importCustomTheme: (...a: unknown[]) => importCustomTheme(...a),
  ensureThemesDir: (...a: unknown[]) => ensureThemesDir(...a),
}));
vi.mock("../../src/lib/prefs", () => ({
  setCustomTheme: (...a: unknown[]) => setCustomTheme(...a),
  prefsRead: (...a: unknown[]) => prefsRead(...a),
}));
vi.mock("../../src/lib/theme", () => ({
  applyCustomTheme: (...a: unknown[]) => applyCustomTheme(...a),
  applyTheme: (...a: unknown[]) => applyTheme(...a),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openFileDialog(...a),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...a: unknown[]) => revealItemInDir(...a),
}));

import { CustomThemesSection } from "../../src/components/settings/CustomThemesSection";

const VALID = {
  name: "solar",
  display_name: "solar",
  preview: {
    background: "#111111",
    surface: "#222222",
    foreground: "#333333",
    accent: "#444444",
    line: "#555555",
  },
  valid: true,
  error: null,
};
const INVALID = {
  name: "broken",
  display_name: "broken",
  preview: null,
  valid: false,
  error: { kind: "MissingKey", key: "--accent" },
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
  readCustomTheme.mockReset().mockResolvedValue({ "--paper": "#111111" });
  deleteCustomTheme.mockReset().mockResolvedValue(undefined);
  importCustomTheme.mockReset().mockResolvedValue(VALID);
  ensureThemesDir.mockReset().mockResolvedValue("/cfg/themes");
  setCustomTheme.mockReset().mockResolvedValue(undefined);
  prefsRead.mockReset().mockResolvedValue({ theme: "dark", custom_theme: null });
  applyCustomTheme.mockReset();
  applyTheme.mockReset();
  openFileDialog.mockReset().mockResolvedValue(null);
  revealItemInDir.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("CustomThemesSection", () => {
  it("shows the empty state when there are no themes", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId("settings.custom-theme-empty")).toBeTruthy());
  });

  it("renders a valid theme row with a preview chiplet and Apply", async () => {
    listCustomThemes.mockResolvedValue([VALID]);
    renderSection();
    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-theme-name")).toBe("solar");
    expect(row.getAttribute("data-valid")).toBe("true");
    expect(row.getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("settings.custom-theme-apply")).toBeTruthy();
  });

  it("marks the active theme row Applied and hides its Apply button", async () => {
    listCustomThemes.mockResolvedValue([VALID]);
    renderSection("solar");
    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-active")).toBe("true");
    expect(screen.queryByTestId("settings.custom-theme-apply")).toBeNull();
  });

  it("Apply reads the palette, persists the selection, applies it, and marks it active", async () => {
    listCustomThemes.mockResolvedValue([VALID]);
    const { onActiveCustomChange } = renderSection();
    fireEvent.click(await screen.findByTestId("settings.custom-theme-apply"));
    await waitFor(() => expect(setCustomTheme).toHaveBeenCalledWith("solar"));
    expect(readCustomTheme).toHaveBeenCalledWith("solar");
    expect(applyCustomTheme).toHaveBeenCalled();
    expect(onActiveCustomChange).toHaveBeenCalledWith("solar");
  });

  it("Delete is a two-step inline confirm", async () => {
    listCustomThemes.mockResolvedValue([VALID]);
    renderSection();
    fireEvent.click(await screen.findByTestId("settings.custom-theme-delete"));
    // First click arms the confirm; nothing deleted yet.
    expect(deleteCustomTheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("settings.custom-theme-delete-confirm"));
    await waitFor(() => expect(deleteCustomTheme).toHaveBeenCalledWith("solar"));
  });

  it("renders an invalid theme greyed with its error and no Apply", async () => {
    listCustomThemes.mockResolvedValue([INVALID]);
    renderSection();
    const row = await screen.findByTestId("settings.custom-theme-row");
    expect(row.getAttribute("data-valid")).toBe("false");
    expect(screen.queryByTestId("settings.custom-theme-apply")).toBeNull();
    expect(row.textContent).toContain("--accent");
  });

  it("Import opens the file dialog and imports the picked file", async () => {
    openFileDialog.mockResolvedValue("/tmp/my-theme.json");
    renderSection();
    await waitFor(() => expect(listCustomThemes).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.custom-theme-import"));
    await waitFor(() => expect(importCustomTheme).toHaveBeenCalledWith("/tmp/my-theme.json"));
  });

  it("Open themes folder ensures the dir then reveals it", async () => {
    renderSection();
    await waitFor(() => expect(listCustomThemes).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.custom-theme-open-folder"));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/cfg/themes"));
  });
});
