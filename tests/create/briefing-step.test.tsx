// @vitest-environment jsdom
//
// MYND-114 first-run safety briefing — component-level contract.
//
// The E2E (`e2e/vault-creation.e2e.ts` "MYND-114 …") drives this through
// the production binary; this Vitest spec pins the same gating logic at
// the component boundary so the contract is verifiable off the Linux
// harness (tauri-driver is Linux-only). Two layers:
//   (a) <BriefingStep> in isolation — per-statement gating, the opt-in
//       "Why?" disclosure, and the Back/Continue callbacks.
//   (b) <CreateVault withBriefing> — the briefing is the FIRST step on the
//       first-run entry, and acknowledging it advances to PasswordStep;
//       without the flag the flow opens directly on PasswordStep.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../../src/lib/app-window", () => ({
  HAS_TAURI: false,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }),
}));

import { BriefingStep } from "../../src/screens/vault-creation/BriefingStep";
import { CreateVault } from "../../src/screens/CreateVault";
import { LOST_BOTH_SECRETS_SENTENCE } from "../../src/lib/load-bearing-copy";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function continueBtn(): HTMLButtonElement {
  return screen.getByTestId("create.briefing-continue") as HTMLButtonElement;
}

describe("<BriefingStep> — acknowledgement gating", () => {
  it("renders all three statements with their own acknowledgement checkbox", () => {
    render(<BriefingStep onBack={() => {}} onContinue={() => {}} />);
    expect(screen.getByText("Your password unlocks your vault. We don't store it.")).toBeTruthy();
    expect(screen.getByText("Your recovery phrase is your only backup.")).toBeTruthy();
    expect(screen.getByText("There is no email recovery. There never will be.")).toBeTruthy();
    expect(screen.getAllByTestId("create.briefing-ack")).toHaveLength(3);
  });

  it("keeps Continue disabled until ALL three are acknowledged, then enables it", () => {
    const onContinue = vi.fn();
    render(<BriefingStep onBack={() => {}} onContinue={onContinue} />);
    const acks = screen.getAllByTestId("create.briefing-ack");

    expect(continueBtn().disabled).toBe(true);
    fireEvent.click(acks[0]);
    expect(continueBtn().disabled).toBe(true);
    fireEvent.click(acks[1]);
    expect(continueBtn().disabled).toBe(true);
    fireEvent.click(acks[2]);
    expect(continueBtn().disabled).toBe(false);

    fireEvent.click(continueBtn());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("re-gates Continue if an acknowledgement is unticked", () => {
    render(<BriefingStep onBack={() => {}} onContinue={() => {}} />);
    const acks = screen.getAllByTestId("create.briefing-ack");
    acks.forEach((a) => fireEvent.click(a));
    expect(continueBtn().disabled).toBe(false);
    fireEvent.click(acks[1]); // untick one
    expect(continueBtn().disabled).toBe(true);
  });

  it("'Why?' is opt-in: hidden by default, expands inline, and re-collapses", () => {
    const { container } = render(<BriefingStep onBack={() => {}} onContinue={() => {}} />);
    expect(screen.queryAllByTestId("create.briefing-why-text")).toHaveLength(0);

    const why = container.querySelector(
      '[data-testid="create.briefing-why"][data-ack-id="phrase-backup"]',
    ) as HTMLButtonElement;
    expect(why.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(why);
    expect(why.getAttribute("aria-expanded")).toBe("true");
    const text = container.querySelector(
      '[data-testid="create.briefing-why-text"][data-ack-id="phrase-backup"]',
    );
    // The normative fixed string is stated, plainly, once.
    expect(text?.textContent).toContain(LOST_BOTH_SECRETS_SENTENCE);

    fireEvent.click(why);
    expect(why.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("create.briefing-why-text")).toHaveLength(0);
  });

  it("Back fires onBack without requiring any acknowledgement", () => {
    const onBack = vi.fn();
    render(<BriefingStep onBack={onBack} onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId("create.briefing-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("<CreateVault withBriefing> — first-run routing", () => {
  function renderFlow(withBriefing: boolean) {
    return render(
      <CreateVault
        withBriefing={withBriefing}
        onBack={() => {}}
        onAutoUnlockSuccess={() => {}}
        onAutoUnlockFailed={() => {}}
      />,
    );
  }

  it("opens on the briefing step (not password) when withBriefing is set, then advances", () => {
    renderFlow(true);
    expect(screen.getByTestId("create.briefing")).toBeTruthy();
    expect(screen.queryByTestId("create.password-input")).toBeNull();

    screen.getAllByTestId("create.briefing-ack").forEach((a) => fireEvent.click(a));
    fireEvent.click(screen.getByTestId("create.briefing-continue"));

    // Acknowledged → PasswordStep.
    expect(screen.getByTestId("create.password-input")).toBeTruthy();
    expect(screen.queryByTestId("create.briefing")).toBeNull();
  });

  it("opens directly on the password step when withBriefing is unset (picker/switcher entry)", () => {
    renderFlow(false);
    expect(screen.getByTestId("create.password-input")).toBeTruthy();
    expect(screen.queryByTestId("create.briefing")).toBeNull();
  });
});
