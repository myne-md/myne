// @vitest-environment jsdom
//
// Component tests for `src/components/settings/BrowserExtensionsPanel.tsx`, the
// rail panel the browser clipper moved into (myne-md/myne#960,
// `agent-tooling/design-notes/ui/0778`).
//
// What this suite is for, given `ConnectedExtensions` has its own: the MOVE, and
// the gate that travels with it. A panel split out of another one is exactly the
// change where a capability guard gets left behind on the old surface (rendering
// an empty section on a client that cannot clip) or dropped on the new one
// (offering a control the platform cannot honour), and neither shows up in the
// block's own tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const has = vi.fn((_cap: string) => true);
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => has(cap),
}));
// The block does its own IPC on mount; `connectedExtensions.test.tsx` owns that.
// Here it is a marker, because what is under test is whether the panel mounts it
// at all.
vi.mock("../../src/components/settings/ConnectedExtensions", () => ({
  ConnectedExtensions: () => <div data-testid="ce" />,
}));

const { BrowserExtensionsPanel } = await import(
  "../../src/components/settings/BrowserExtensionsPanel"
);
const i18n = (await import("../../src/i18n")).default;

beforeEach(() => {
  has.mockImplementation((cap: string) => cap === "clipper");
});

afterEach(() => {
  cleanup();
  has.mockReset();
});

describe("BrowserExtensionsPanel", () => {
  it("mounts the clipper's block on a client that can host one", () => {
    render(<BrowserExtensionsPanel />);
    expect(screen.getByTestId("settings.browser-extensions")).toBeTruthy();
    expect(screen.getByTestId("ce")).toBeTruthy();
  });

  /**
   * The rail already filters the panel out where `clipper` is absent, so this
   * state is unreachable through the UI. It is asserted anyway because the guard
   * is the thing that keeps a reachable panel from rendering an empty section,
   * and a rail filter is a second, independent gate that a future entry could
   * drop without this test noticing.
   */
  it("renders no block at all where the platform cannot clip", () => {
    has.mockImplementation(() => false);
    render(<BrowserExtensionsPanel />);
    expect(screen.queryByTestId("settings.browser-extensions")).toBeNull();
    expect(screen.queryByTestId("ce")).toBeNull();
  });

  /**
   * One concern, so the rail's own label is the section's accessible name and
   * there is no second visible heading repeating it (`SettingsSection` drops the
   * heading in the single-section case, myne-md/myne#885).
   */
  it("names its single section with the rail's own label, once", () => {
    render(<BrowserExtensionsPanel />);
    const label = i18n.t("settings.shell.panels.extensions");
    expect(screen.getAllByRole("region", { name: label }).length).toBe(1);
    expect(screen.queryByRole("heading", { name: label })).toBeNull();
  });
});
