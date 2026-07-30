// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AboutPanel.tsx`'s Developer
// mode toggle (developer-mode feature, MYND-593, task 6). Focus: the toggle
// reflects `prefs.developer_mode`, calls `setDeveloperMode` on click, and is
// hidden entirely when the Developer group has no capability-eligible member
// (mirrors SettingsModal's own emptiness test) — regardless of the toggle's
// own current value, since this control is what sets that value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl,
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("../../src/platform/build-info", () => ({
  servedBuildInfo: () => Promise.resolve(null),
}));

let localAiCapable = true;
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => (cap === "localAi" ? localAiCapable : true),
}));

let developerMode = false;
const setDeveloperMode = vi.fn((next: boolean) => {
  developerMode = next;
  return Promise.resolve();
});
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { developer_mode: developerMode },
    setDeveloperMode,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AboutPanel } from "../../src/components/settings/AboutPanel";

beforeEach(() => {
  localAiCapable = true;
  developerMode = false;
  setDeveloperMode.mockClear();
  openUrl.mockClear();
});
afterEach(() => cleanup());

describe("AboutPanel — Developer mode toggle", () => {
  it("renders off by default, matching the device-local pref's false default", () => {
    render(<AboutPanel />);
    const toggle = screen.getByTestId("about.developer-mode-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects an already-enabled preference", () => {
    developerMode = true;
    render(<AboutPanel />);
    expect(
      screen.getByTestId("about.developer-mode-toggle").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("calls setDeveloperMode(true) when toggled on", () => {
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.developer-mode-toggle"));
    expect(setDeveloperMode).toHaveBeenCalledWith(true);
  });

  it("calls setDeveloperMode(false) when toggled off", () => {
    developerMode = true;
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.developer-mode-toggle"));
    expect(setDeveloperMode).toHaveBeenCalledWith(false);
  });

  it("is absent when the Developer group has no capability-eligible member (web-shaped capability set)", () => {
    localAiCapable = false;
    render(<AboutPanel />);
    expect(screen.queryByTestId("about.developer-mode-toggle")).toBeNull();
  });
});
