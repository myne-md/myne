// @vitest-environment jsdom
//
// One Escape dismisses one surface — myne-md/myne#555, the `settings.shell`
// bullet ("Esc-once-closes-child, Esc-again-closes-Settings and the backdrop
// equivalent are shared modal-stack logic").
//
// # The defect this was written against, which it found
//
// There is no modal stack. `SettingsModal` installs a `window` keydown listener
// that calls `onClose`, and every child surface installs one of its own — the
// accent picker's is on `document`. Neither stops propagation, so one keypress
// reaches both. The only thing separating them is a boolean the child raises
// through an `onDialogOpenChange` prop, and `AppearancePanel` was not being
// given it: opening the accent picker and pressing Escape closed the picker AND
// the Settings modal behind it, in one keystroke, losing whatever the user was
// in the middle of.
//
// `SyncPanel` and `AiPanel` had the wiring. `AppearancePanel` did not, and
// nothing anywhere said so — the prop is optional on both panels that take it
// (it has to be; they are rendered in tests without a shell), so `tsc` is
// content. A test of the panel alone passes, because its own popover closes
// correctly. A test of the shell alone passes, because no child is mounted. The
// defect exists only in the composition.
//
// # Two tests, because they fail for different reasons
//
// `tests/components/settingsChildDialogRegistration.test.ts` is the ratchet: it
// compares the shell's panel map against which panels can put a dialog on
// screen, so the NEXT panel to grow one fails by name whether or not anyone
// writes a scenario for it. This file is the behaviour: it drives the real
// keypress through the real composition and asserts what the user sees. The
// ratchet without this would be asserting a convention; this without the
// ratchet would cover one panel forever.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Panels are stubbed to markers EXCEPT `appearance`, which is the subject. A
// real panel elsewhere would drag its own IPC in and none of it is the point.
vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: () => <div data-testid="panel.account">account</div>,
}));
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
}));
vi.mock("../../src/components/settings/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="panel.editor">editor</div>,
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
vi.mock("../../src/components/settings/NetworkPanel", () => ({
  NetworkPanel: () => <div data-testid="panel.network">network</div>,
}));

// The custom-themes section reads the vault over IPC; the accent picker does
// not, and the accent picker is the subject.
vi.mock("../../src/components/settings/CustomThemesSection", () => ({
  CustomThemesSection: () => <div data-testid="panel.custom-themes" />,
}));
vi.mock("../../src/components/settings/LanguageSelect", () => ({
  LanguageSelect: () => <div data-testid="panel.language" />,
}));

// Prefs are a vault read. The panel only needs values to render controls with.
vi.mock("../../src/lib/prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prefs")>();
  return {
    ...actual,
    prefsRead: async () => ({ theme: "light", show_note_timestamps: true, show_task_marker: true }),
    setTheme: vi.fn(async () => {}),
    setCustomTheme: vi.fn(async () => {}),
    setShowNoteTimestamps: vi.fn(async () => {}),
    setShowTaskMarker: vi.fn(async () => {}),
  };
});

const { SettingsModal } = await import("../../src/components/SettingsModal");

function mount(onClose: () => void) {
  render(
    <SettingsModal
      open
      vaultId="00000000-0000-7000-8000-000000000000"
      onClose={onClose}
      onDeleteVaultSuccess={vi.fn()}
    />,
  );
}

/** A real Escape, dispatched the way the browser dispatches one.
 *
 *  On `document`, bubbling, so it reaches BOTH the popover's `document`
 *  listener and the shell's `window` one — which is the entire point. A
 *  synthetic event fired at a single element would test neither. */
async function pressEscape() {
  // Inside `act`, so the state each listener sets is committed before the next
  // assertion reads it. Without it the shell's `childDialogOpenRef` — written
  // in an effect — trails the render by a tick, and this file reported the very
  // defect it was verifying the fix for.
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

async function openTheAccentPopover() {
  fireEvent.click(await screen.findByTestId("settings.tab-appearance"));
  fireEvent.click(await screen.findByTestId("settings.accent-color"));
  const popover = await screen.findByTestId("settings.accent-popover");
  // Let the popover's `onDialogOpenChange` effect and the shell's ref-sync
  // effect both commit before anything presses a key.
  await act(async () => {});
  return popover;
}

afterEach(cleanup);

describe("Escape dismisses the child surface before the Settings modal", () => {
  it("closes the accent popover and leaves Settings open", async () => {
    const onClose = vi.fn();
    mount(onClose);
    await openTheAccentPopover();

    await pressEscape();

    expect(
      screen.queryByTestId("settings.accent-popover"),
      "the accent popover survived its own Escape handler",
    ).toBeNull();
    expect(
      onClose,
      "one Escape closed the accent popover AND the Settings modal behind it. " +
        "SettingsModal and the popover each listen for Escape and neither stops " +
        "propagation; the shell stands down only while a panel has raised " +
        "`onDialogOpenChange`, which is what AppearancePanel must be passing.",
    ).not.toHaveBeenCalled();
  });

  it("closes Settings on the NEXT Escape, once nothing else is up", async () => {
    // The other half of the same claim, and the reason the first test is not
    // enough on its own: a shell that ignored Escape unconditionally would pass
    // it and be broken in the opposite direction.
    const onClose = vi.fn();
    mount(onClose);
    await openTheAccentPopover();

    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    await pressEscape();
    expect(onClose, "Escape no longer closes Settings once the child is gone").toHaveBeenCalledTimes(
      1,
    );
  });

  it("closes Settings on a plain Escape when no child surface was ever opened", async () => {
    // Non-vacuity for the pair above: if the shell's Escape path were broken
    // outright, both would pass for the wrong reason.
    const onClose = vi.fn();
    mount(onClose);
    await screen.findByTestId("settings.modal");
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
