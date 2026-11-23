// @vitest-environment jsdom
//
// Component tests for `src/components/SettingsModal.tsx` — the settings shell.
// Covers the open/closed gate, tab routing (click + ArrowUp/ArrowDown cycle),
// Esc / backdrop / × dismissal, and the in-flight gating contract: when the
// AccountPanel raises `onInFlightChange(true)`, Esc / backdrop / × all become
// no-ops. The panel children exercised here (account, vault, privacy, editor,
// appearance, storage, about, ai, network, cli) are stubbed to trivial markers so the test
// targets the shell's routing + dismissal logic, not the panels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Capture the Vault panel's onInFlightChange so a test can flip in-flight.
// The Argon2id-bound commands (change password, delete vault) live there now,
// not in Account: the split left the account-level panel with no in-flight IPC
// at all.
let vaultInFlight: ((busy: boolean) => void) | undefined;
// Same, for the AI panel's child-dialog signal (the provider consent).
let aiDialogOpen: ((open: boolean) => void) | undefined;

// Developer mode gates the whole Developer group — the AI panel (MYND-593) and
// the Network/Tor panel (MYND-650) — controllable per test, default off
// (matches usePrefs' DEFAULT_PREFS before the first read resolves).
let developerMode = false;

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { developer_mode: developerMode },
    setDeveloperMode: vi.fn(),
  }),
}));

vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: () => <div data-testid="panel.account">account</div>,
}));
vi.mock("../../src/components/settings/VaultPanel", () => ({
  VaultPanel: (props: { onInFlightChange?: (b: boolean) => void }) => {
    vaultInFlight = props.onInFlightChange;
    return <div data-testid="panel.vault">vault</div>;
  },
}));
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
}));
// Records its props rather than ignoring them: the Editor panel is the only one
// whose `usePrefs` writes have no error surface of their own, so the toast the
// shell threads into it is the sole signal a failed optimistic write produces
// (myne#508). Deleting `onShowToast={onShowToast}` at the shell left every
// suite green before this captured it.
let editorPanelProps: { onShowToast?: (message: string) => void } | undefined;

/** Read `editorPanelProps` through a call, so control-flow analysis cannot
 *  narrow it.
 *
 *  Each test assigns `undefined` and then `render`s, and the mocked panel fills
 *  it during that render. TypeScript cannot see a mutation that happens inside
 *  a callback it does not follow, so at the assertion it still has the variable
 *  narrowed to `undefined` and the property access lands on `never`. A local
 *  copy inherits the same narrowing; only crossing a function boundary drops
 *  it. The mutation is real, the narrowing is what is wrong, and this is the
 *  smallest way to say so without a cast that would also hide a genuine
 *  mistake. */
function capturedEditorProps(): { onShowToast?: (message: string) => void } | undefined {
  return editorPanelProps;
}
vi.mock("../../src/components/settings/EditorPanel", () => ({
  EditorPanel: (props: { onShowToast?: (message: string) => void }) => {
    editorPanelProps = props;
    return <div data-testid="panel.editor">editor</div>;
  },
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
// The panel split out of About on 2026-10-25. Mocked for the same reason as the
// rest: the shell routes by id, and each panel's own behaviour is its own spec.
vi.mock("../../src/components/settings/DiagnosticsPanel", () => ({
  DiagnosticsPanel: () => <div data-testid="panel.diagnostics">diagnostics</div>,
}));
vi.mock("../../src/components/settings/AiPanel", () => ({
  AiPanel: (props: { onDialogOpenChange?: (open: boolean) => void }) => {
    aiDialogOpen = props.onDialogOpenChange;
    return <div data-testid="panel.ai">ai</div>;
  },
}));
vi.mock("../../src/components/settings/NetworkPanel", () => ({
  NetworkPanel: () => <div data-testid="panel.network">network</div>,
}));
vi.mock("../../src/components/settings/ConnectionsPanel", () => ({
  ConnectionsPanel: () => <div data-testid="panel.connections">connections</div>,
}));

import { SettingsModal } from "../../src/components/SettingsModal";

beforeEach(() => {
  vaultInFlight = undefined;
  aiDialogOpen = undefined;
  developerMode = false;
});

afterEach(cleanup);

function renderModal(over: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props = {
    // Required by `SettingsModalProps`, and absent here until the test tree
    // started typechecking: `renderModal()` with no override produced an object
    // missing it, which `render` accepts at runtime and no gate reported.
    vaultId: null,
    open: true,
    onClose: vi.fn(),
    onDeleteVaultSuccess: vi.fn(),
    ...over,
  };
  const utils = render(<SettingsModal {...props} />);
  return { ...utils, props };
}

describe("SettingsModal panel wiring", () => {
  it("threads its toast surface into the Editor panel", async () => {
    // The Editor panel's `usePrefs` writes have no error surface of their own,
    // so this prop is the only signal a failed optimistic write produces there.
    // `writeOptimisticPref` keeps the optimistic value when its converging
    // re-read also fails, which means an unthreaded toast leaves a horizon that
    // was never persisted on screen as though it were in force (myne#508).
    const onShowToast = vi.fn();
    editorPanelProps = undefined;
    renderModal({ onShowToast });
    fireEvent.click(screen.getByTestId("settings.tab-editor"));
    await screen.findByTestId("panel.editor");
    const captured = capturedEditorProps();
    expect(typeof captured?.onShowToast).toBe("function");
    captured?.onShowToast?.("boom");
    expect(onShowToast).toHaveBeenCalledWith("boom");
  });
});

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
    // account → vault: the vault panel was split out of Account and sits
    // directly after it in the rail.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByTestId("panel.vault")).toBeTruthy();
    // ArrowUp from account would wrap; reset to account first by clicking.
    fireEvent.click(screen.getByTestId("settings.tab-account"));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    // Wraps to the last VISIBLE panel — Diagnostics, which joined the core group
    // after About on 2026-10-25, since the whole Developer group is filtered out
    // of the roster while the mode is off.
    expect(screen.getByTestId("panel.diagnostics")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-diagnostics").getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("SettingsModal — Developer group gating (MYND-593)", () => {
  it("mode off: no Developer group, and none of its tabs", () => {
    renderModal();
    expect(screen.queryByTestId("settings.developer-group")).toBeNull();
    expect(screen.queryByTestId("settings.tab-ai")).toBeNull();
    expect(screen.queryByTestId("settings.tab-network")).toBeNull();
    expect(screen.queryByTestId("settings.tab-cli")).toBeNull();
  });

  it("mode on: the Developer group and its two remaining tabs appear, and are reachable", () => {
    // **Two, not three**: the CLI panel left the Developer group for Connections
    // (myne-md/myne#1077), which is a core panel — terminal access is a normal
    // feature with a real capability gate, not a path Myne stops vouching for.
    developerMode = true;
    renderModal();
    expect(screen.getByTestId("settings.developer-group")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings.tab-ai"));
    expect(screen.getByTestId("panel.ai")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings.tab-network"));
    expect(screen.getByTestId("panel.network")).toBeTruthy();
  });

  it("the group divider renders exactly once, at the core→developer boundary", () => {
    // With three members (MYND-650, and the CLI panel of `decisions/ui/0678`)
    // "once" is an assertion rather than a tautology: `opensDeveloper` must fire
    // on the first developer panel only.
    developerMode = true;
    renderModal();
    expect(screen.getAllByTestId("settings.developer-group")).toHaveLength(1);
  });

  it("ArrowUp wraps to the last developer panel when the group is visible", () => {
    developerMode = true;
    renderModal();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    // The LAST panel in the rail is Network now that the CLI moved to Connections
    // (myne-md/myne#1077), and the wrap still lands on the last member rather than
    // on a panel that is no longer in the Developer group.
    expect(screen.getByTestId("panel.network")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-network").getAttribute("aria-selected"),
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
    // The Vault panel raises the in-flight signal during change-password and
    // delete-vault; it only mounts once its tab is selected.
    fireEvent.click(screen.getByTestId("settings.tab-vault"));
    expect(vaultInFlight).toBeDefined();
    // Flip in-flight on.
    act(() => vaultInFlight!(true));

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("settings.modal"));
    fireEvent.click(screen.getByTestId("settings.close"));
    expect(props.onClose).not.toHaveBeenCalled();

    // Once it clears, dismissal works again.
    act(() => vaultInFlight!(false));
    fireEvent.click(screen.getByTestId("settings.close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("the × button is disabled while in flight", () => {
    renderModal();
    fireEvent.click(screen.getByTestId("settings.tab-vault"));
    act(() => vaultInFlight!(true));
    expect(
      (screen.getByTestId("settings.close") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// The other gate, and the one that is invisible when it is missing: a panel
// that opens a `ModalShell` of its own puts TWO Esc listeners on `window`. One
// press would close the child dialog AND this modal under it — the user
// declines a consent and the whole surface disappears, which reads as a crash.
describe("SettingsModal — child-dialog gating", () => {
  function openAiPanel() {
    developerMode = true;
    const rendered = renderModal();
    fireEvent.click(screen.getByTestId("settings.tab-ai"));
    expect(aiDialogOpen).toBeDefined();
    return rendered;
  }

  it("Esc and the backdrop no-op while a panel's dialog is open", () => {
    const { props } = openAiPanel();
    act(() => aiDialogOpen!(true));

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("settings.modal"));
    expect(props.onClose).not.toHaveBeenCalled();

    // Closing the child hands the keys back.
    act(() => aiDialogOpen!(false));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("the rail keys stand down too, not only Esc", () => {
    // "/" would pull focus to the search box behind the dialog and the arrows
    // would cycle a rail the user cannot see — both reachable from a keyboard
    // that the dialog is supposed to own.
    openAiPanel();
    act(() => aiDialogOpen!(true));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByTestId("panel.ai")).toBeTruthy();
    expect(
      screen.getByTestId("settings.tab-ai").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("does not disable the × the way in-flight does", () => {
    // The child's own backdrop already covers the header, so a greyed close
    // button would be claiming a restriction that is not one.
    openAiPanel();
    act(() => aiDialogOpen!(true));
    expect(
      (screen.getByTestId("settings.close") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("SettingsModal: the rail scrolls instead of crushing its rows (myne-md/myne#1061)", () => {
  // The reported symptom was in a real window: turning Developer mode on or off
  // changes how many rows the rail has, and a rail with more rows than height
  // squeezed every one of them — padding gone, icons touching, the last rows cut
  // off — because a flex column shrinks its items to fit before anything
  // overflows. jsdom computes no layout, so the assertion is on the three
  // declarations that decide it: the scroll box, and the row height and padding
  // that must not be negotiated.
  it("gives the tab list the scroll and the rows a fixed height", () => {
    render(
      <SettingsModal vaultId="v1" open onClose={vi.fn()} onDeleteVaultSuccess={vi.fn()} />,
    );
    const nav = screen.getByRole("tablist");
    expect(nav.style.overflowY).toBe("auto");
    // `min-height: 0` is what lets the box be SHORTER than its content in a flex
    // column at all; without it the scroll never gets a box to scroll in.
    expect(nav.style.minHeight).toBe("0px");

    const tab = screen.getByTestId("settings.tab-account");
    expect(tab.style.flexShrink).toBe("0");
    expect(tab.style.height).toBe("40px");
    expect(tab.style.boxSizing).toBe("border-box");
  });
});
