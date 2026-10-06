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
//       first-run entry, and acknowledging it advances to the NAME step;
//       without the flag the flow opens directly on the name step. (It was
//       PasswordStep in both places until myne-md/myne#468 put naming the
//       vault first, which is the one thing this layer exists to pin: the
//       briefing gate is a step-ORDER contract, so a reordering that skipped
//       or double-showed the briefing would land here.)

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

  it("opens on the briefing step (not the name step) when withBriefing is set, then advances", () => {
    renderFlow(true);
    expect(screen.getByTestId("create.briefing")).toBeTruthy();
    expect(screen.queryByTestId("create.name-input")).toBeNull();

    screen.getAllByTestId("create.briefing-ack").forEach((a) => fireEvent.click(a));
    fireEvent.click(screen.getByTestId("create.briefing-continue"));

    // Acknowledged → NameStep, which is the first numbered step.
    expect(screen.getByTestId("create.name-input")).toBeTruthy();
    expect(screen.queryByTestId("create.briefing")).toBeNull();
    // And the password is still one step away, so the briefing did not skip a step.
    expect(screen.queryByTestId("create.password-input")).toBeNull();
  });

  it("opens directly on the name step when withBriefing is unset (picker/switcher entry)", () => {
    renderFlow(false);
    expect(screen.getByTestId("create.name-input")).toBeTruthy();
    expect(screen.queryByTestId("create.briefing")).toBeNull();
  });

  it("the name step leads to the password step, and Back from it returns the typed name", () => {
    // The name is held in reducer state rather than in the step, which is what
    // lets Back be a real back-step. Before this the password step's Back left
    // vault creation entirely, so there was nothing to preserve.
    renderFlow(false);
    const input = screen.getByTestId("create.name-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Research" } });
    fireEvent.click(screen.getByTestId("create.name-continue"));
    expect(screen.getByTestId("create.password-input")).toBeTruthy();

    fireEvent.click(screen.getByTestId("create.secondary"));
    expect(
      (screen.getByTestId("create.name-input") as HTMLInputElement).value,
      "Back re-asked for a name the user had already given",
    ).toBe("Research");
  });
});
