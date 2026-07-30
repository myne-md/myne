// @vitest-environment jsdom
//
// Component tests for `src/components/SettingsModal.tsx` — the settings shell.
// Covers the open/closed gate, tab routing (click + ArrowUp/ArrowDown cycle),
// Esc / backdrop / × dismissal, and the in-flight gating contract: when the
// AccountPanel raises `onInFlightChange(true)`, Esc / backdrop / × all become
// no-ops. The panel children exercised here (account, privacy, editor,
// appearance, storage, about, ai) are stubbed to trivial markers so the test
// targets the shell's routing + dismissal logic, not the panels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Capture the AccountPanel's onInFlightChange so a test can flip in-flight.
let accountInFlight: ((busy: boolean) => void) | undefined;

// Developer mode gates the AI panel/rail entry (developer-mode feature,
// MYND-593) — controllable per test, default off (matches usePrefs'
// DEFAULT_PREFS before the first read resolves).
let developerMode = false;

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { developer_mode: developerMode },
    setDeveloperMode: vi.fn(),
  }),
}));

vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: (props: { onInFlightChange?: (b: boolean) => void }) => {
    accountInFlight = props.onInFlightChange;
    return <div data-testid="panel.account">account</div>;
  },
}));
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
}));
vi.mock("../../src/components/settings/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="panel.editor">editor</div>,
}));
vi.mock("../../src/components/settings/AppearancePanel", () => ({
  AppearancePanel: () => <div data-testid="panel.appearance">appearance</div>,
}));
vi.mock("../../src/components/settings/StoragePanel", () => ({
  StoragePanel: () => <div data-testid="panel.storage">storage</div>,
}));
vi.mock("../../src/components/settings/AboutPanel", () => ({
  AboutPanel: () => <div data-testid="panel.about">about</div>,
}));
vi.mock("../../src/components/settings/AiPanel", () => ({
  AiPanel: () => <div data-testid="panel.ai">ai</div>,
}));

import { SettingsModal } from "../../src/components/SettingsModal";

beforeEach(() => {
  accountInFlight = undefined;
  developerMode = false;
});

afterEach(cleanup);

function renderModal(over: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    onDeleteVaultSuccess: vi.fn(),
    ...over,
  };
  const utils = render(<SettingsModal {...props} />);
  return { ...utils, props };
}

describe("SettingsModal — open gate", () => {
  it("renders nothing when open is false", () => {
    renderModal({ open: false });
    expect(screen.queryByTestId("settings.modal")).toBeNull();
  });

  it("defaults to the Account panel", () => {
    renderModal();
    expect(screen.getByTestId("panel.account")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-account").getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("SettingsModal — tab routing", () => {
  it("clicking a rail tab swaps the rendered panel", () => {
    renderModal();
    fireEvent.click(screen.getByTestId("settings.tab-storage"));
    expect(screen.getByTestId("panel.storage")).toBeTruthy();
    expect(screen.queryByTestId("panel.account")).toBeNull();
    expect(
      screen.getByTestId("settings.tab-storage").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("ArrowDown cycles to the next panel; ArrowUp wraps to the last (Developer mode off)", () => {
    renderModal();
    // account → privacy
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByTestId("panel.privacy")).toBeTruthy();
    // ArrowUp from account would wrap; reset to account first by clicking.
    fireEvent.click(screen.getByTestId("settings.tab-account"));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    // Wraps to the last VISIBLE panel — About, since the Developer group (AI)
    // is filtered out of the roster while the mode is off.
    expect(screen.getByTestId("panel.about")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-about").getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("SettingsModal — Developer group gating (MYND-593)", () => {
  it("mode off: no Developer group, no AI tab", () => {
    renderModal();
    expect(screen.queryByTestId("settings.developer-group")).toBeNull();
    expect(screen.queryByTestId("settings.tab-ai")).toBeNull();
  });

  it("mode on: Developer group and AI tab appear, and are reachable", () => {
    developerMode = true;
    renderModal();
    expect(screen.getByTestId("settings.developer-group")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings.tab-ai"));
    expect(screen.getByTestId("panel.ai")).toBeTruthy();
  });

  it("ArrowUp wraps to AI when the Developer group is visible", () => {
    developerMode = true;
    renderModal();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByTestId("panel.ai")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-ai").getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("SettingsModal — dismissal", () => {
  it("Esc calls onClose", () => {
    const { props } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop calls onClose", () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByTestId("settings.modal"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the modal body does NOT close it", () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByTestId("panel.account"));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("the × button calls onClose", () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByTestId("settings.close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsModal — in-flight gating", () => {
  it("Esc / backdrop / × all no-op while a child is in flight", () => {
    const { props } = renderModal();
    // The AccountPanel raises the in-flight signal during change-password.
    expect(accountInFlight).toBeDefined();
    // Flip in-flight on.
    act(() => accountInFlight!(true));

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("settings.modal"));
    fireEvent.click(screen.getByTestId("settings.close"));
    expect(props.onClose).not.toHaveBeenCalled();

    // Once it clears, dismissal works again.
    act(() => accountInFlight!(false));
    fireEvent.click(screen.getByTestId("settings.close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("the × button is disabled while in flight", () => {
    renderModal();
    act(() => accountInFlight!(true));
    expect(
      (screen.getByTestId("settings.close") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
