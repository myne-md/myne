// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AboutPanel.tsx`'s Developer
// mode toggle (developer-mode feature, MYND-593, task 6). Focus: the toggle
// reflects `prefs.developer_mode`, calls `setDeveloperMode` on click, and
// renders on every client — including the web-shaped capability set, which
// used to hide it (#181).

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

  it("still renders on a web-shaped capability set, where the Developer rail group is empty", () => {
    // The inverse of this used to hold: no `localAi` meant no toggle, on the
    // theory that a gate with nothing behind it should not be offered. #181
    // broke that theory — the mode now also hides settings inside core panels
    // (the Vim toggle), and those ship on every client. Withholding the switch
    // here would strand them, since `developer_mode` is device-local and so
    // cannot arrive by sync from a desktop that has one.
    localAiCapable = false;
    render(<AboutPanel />);
    expect(screen.getByTestId("about.developer-mode-toggle")).toBeTruthy();
  });

  it("is still operable on a web-shaped capability set", () => {
    localAiCapable = false;
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.developer-mode-toggle"));
    expect(setDeveloperMode).toHaveBeenCalledWith(true);
  });
});
