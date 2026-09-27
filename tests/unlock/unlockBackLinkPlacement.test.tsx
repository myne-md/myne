// @vitest-environment jsdom
//
// Where the way OUT of the unlock screen sits (myne-md/myne#773).
//
// The screen was deboxed and the back control went with the rest of the chrome
// into the page's top-right, beside "create a vault". That is wrong and the
// reason generalises: a global action belongs in the top bar, and this is not
// one — it is the escape from the specific question the heading asks, so it
// belongs against that question. Reading order says the same thing. A user
// arriving at "Unlock your vault" should meet the way out BEFORE the demand,
// not after it, in a corner, in a different landmark.
//
// It has no test otherwise: moving it broke nothing, typechecked, and left the
// control perfectly clickable — which is exactly why it moved without anyone
// noticing until it was on screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {} }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));

import { Unlock } from "../../src/screens/Unlock";

const STATUS_CMD = "plugin:quick-unlock|quick_unlock_status";
const VAULT_LIST_CMD = "plugin:vault-unlock|vault_list";

/** Two vaults, so the back-to-picker control is offered at all. */
function renderWithTwoVaults() {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === STATUS_CMD) {
      return Promise.resolve({ configured: false, method: null, available: false });
    }
    if (cmd === VAULT_LIST_CMD) {
      return Promise.resolve([{ id: "a" }, { id: "b" }]);
    }
    return Promise.resolve(undefined);
  });
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onResumeRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
      onBack={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the way back sits with the question it answers", () => {
  it("is in the content column, not in the page's top bar", async () => {
    const { container } = renderWithTwoVaults();
    const back = await screen.findByTestId("unlock.back-to-picker");
    const header = container.querySelector("header") as HTMLElement;
    const main = container.querySelector("main") as HTMLElement;
    expect(header, "the shell has no header").not.toBeNull();
    expect(header.contains(back), "the back control is up in the chrome").toBe(false);
    expect(main.contains(back), "the back control is not in the task column").toBe(true);
  });

  it("comes before the heading in reading order", async () => {
    renderWithTwoVaults();
    // `compareDocumentPosition` rather than an index: the suspicion banner
    // renders between the two whenever it fires, so a positional assertion
    // would be about a layout that only sometimes exists.
    const back = await screen.findByTestId("unlock.back-to-picker");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(
      back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the escape must be met before the demand",
    ).toBeTruthy();
  });

  it("is a labelled control, not a bare glyph", async () => {
    renderWithTwoVaults();
    // It carries its own words, unlike the icon-only chrome it briefly joined.
    // At this size an unlabelled arrow on a pre-unlock screen is a guess.
    const back = await screen.findByTestId("unlock.back-to-picker");
    expect(back.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // …and the arrow beside those words is an icon rather than a text glyph,
    // which `editor/src/host/lib/icons.ts` asks for by name: a character
    // inherits the text metrics and sits off the label's baseline at every size.
    expect(back.querySelector("svg"), "the arrow is a text character").not.toBeNull();
  });

  it("is withdrawn while an attempt is in flight", async () => {
    // Unchanged by the move, and worth keeping honest: leaving it during
    // `decrypting` offers to abandon an unlock mid-IPC.
    const { container } = renderWithTwoVaults();
    await screen.findByTestId("unlock.back-to-picker");
    const input = screen.getByTestId("unlock.password-input");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(input, { target: { value: "something" } });
    fireEvent.click(screen.getByTestId("unlock.submit"));
    await waitFor(() =>
      expect(screen.queryByTestId("unlock.back-to-picker")).toBeNull(),
    );
    void container;
  });

  it("sits against the heading rather than a full section above it", async () => {
    // The content column's `gap` is the distance between SECTIONS, and the
    // back control is not one: it is the escape from the question the heading
    // asks. At the full gap it floated midway between the wordmark and the
    // title with equal claim on both, and the screen read as three evenly
    // spaced strangers.
    renderWithTwoVaults();
    const back = await screen.findByTestId("unlock.back-to-picker");
    const pull = back.style.marginBlockEnd;
    expect(pull, "the back control takes the whole section gap").toBeTruthy();
    // Negative, i.e. it pulls UP against that gap. A positive margin here adds
    // to the distance, which is the defect wearing the fix's clothes.
    expect(pull.includes("-1") || pull.trimStart().startsWith("-"), pull).toBe(true);

    // And the heading's own pair is tighter still, so the three distances on
    // this screen are unequal by construction: lead-in, title+subtitle, form.
    const heading = screen.getByRole("heading", { level: 1 });
    const group = heading.parentElement as HTMLElement;
    expect(group.style.gap, "the title and its subtitle are a section apart").toBe(
      "var(--space-1)",
    );
    expect(group.querySelector("p"), "the subtitle is outside the group").not.toBeNull();
  });
});
