// @vitest-environment jsdom
//
// Component tests for `src/components/SettingsModal.tsx` — the settings shell.
// Covers the open/closed gate, tab routing (click + ArrowUp/ArrowDown cycle),
// Esc / backdrop / × dismissal, and the in-flight gating contract: when the
// AccountPanel raises `onInFlightChange(true)`, Esc / backdrop / × all become
// no-ops. The six panel children are stubbed to trivial markers so the test
// targets the shell's routing + dismissal logic, not the panels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Capture the AccountPanel's onInFlightChange so a test can flip in-flight.
let accountInFlight: ((busy: boolean) => void) | undefined;

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

import { SettingsModal } from "../../src/components/SettingsModal";

beforeEach(() => {
  accountInFlight = undefined;
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

  it("ArrowDown cycles to the next panel; ArrowUp wraps to the last", () => {
    renderModal();
    // account → privacy
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByTestId("panel.privacy")).toBeTruthy();
    // ArrowUp from account would wrap; reset to account first by clicking.
    fireEvent.click(screen.getByTestId("settings.tab-account"));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    // Wraps to the last panel (About).
    expect(screen.getByTestId("panel.about")).toBeTruthy();
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
