// @vitest-environment jsdom
//
// The AI limit rows on mobile (myne-md/myne#617 and meeting-ai, reached this
// client in myne-md/myne#880).
//
// # What this pins
//
// Both prefs were enforced by the SHARED core and authored only from a computer.
// The budget is the quieter one: `core/src/plugins/agent/history.rs` reads
// `view.chat_history_budget`, so a phone already applied an inherited default it
// could not change. The prompt is the sharper one: the phone is where meeting
// capture happens.
//
// # The assertion that is not "the value was stored"
//
// The budget's whole reason to exist is the bound the HOST enforces, so what is
// asserted here is that the row's bound is the SHARED constant rather than a
// literal: `CHAT_HISTORY_BUDGET_MAX` is the copy the settings input needs, and
// `tests/lib/chatHistoryBudget.test.ts` reads the Rust file and fails when it
// drifts from the clamp the enforcement path applies. A row that rendered its own
// number would agree with the host by accident, and the drift is quiet in both
// directions (raise the Rust ceiling and the input keeps offering the old one;
// lower it and every write is silently reduced).
//
// The row deliberately does NOT clamp before sending: a second clamp would read
// as the control and hide the day the real one stopped working. That is why
// `budgetFromDraft` returns the parsed number rather than a clamped one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_HISTORY_BUDGET_MAX } from "@myne/agent-protocol";

const invoke = vi.fn();

vi.mock("../../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// The stub INTERPOLATES, so an assertion can prove the shared constant reached
// the sentence rather than a literal that happens to match it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

import { AiLimitsBlock, budgetFromDraft } from "../../src/components/AiLimitsBlock";

function writes(cmd: string): unknown[] {
  return invoke.mock.calls
    .filter((c) => (c as [string])[0] === cmd)
    .map((c) => (c as [string, Record<string, unknown>])[1]);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
});

afterEach(cleanup);

describe("mobile AI limits", () => {
  it("writes the budget through the chokepoint", async () => {
    render(<AiLimitsBlock budget={null} meetingPrompt={null} />);
    const field = screen.getByTestId("settings.aiLimits.budget") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "4000" } });
    fireEvent.click(screen.getByTestId("settings.aiLimits.budget-commit"));

    await waitFor(() => expect(writes("plugin:prefs|set_chat_history_budget")).toHaveLength(1));
    expect(writes("plugin:prefs|set_chat_history_budget")[0]).toEqual({ budget: 4000 });
  });

  it("renders the SHARED bound, not a literal of its own", () => {
    render(<AiLimitsBlock budget={null} meetingPrompt={null} />);
    const notice = screen.getByTestId("settings.aiLimits.budget-max").textContent ?? "";
    // The shared constant is the value the host clamps to, held to the Rust file
    // by `tests/lib/chatHistoryBudget.test.ts`.
    expect(notice).toContain(String(CHAT_HISTORY_BUDGET_MAX));
    // And the row does not send a clamp of its own.
    const src: string = readFileSync(join(process.cwd(), "src/components/AiLimitsBlock.tsx"), "utf8");
    expect(src).toContain("CHAT_HISTORY_BUDGET_MAX");
    expect(src).not.toMatch(/Math\.min\(/);
  });

  it("writes the meeting prompt, and clears it back to the default", async () => {
    render(<AiLimitsBlock budget={null} meetingPrompt={"old"} />);
    const field = screen.getByTestId("settings.aiLimits.meetingPrompt") as HTMLInputElement;
    expect(field.value).toBe("old");
    fireEvent.change(field, { target: { value: "Summarise in three bullets." } });
    fireEvent.click(screen.getByTestId("settings.aiLimits.prompt-commit"));

    await waitFor(() => expect(writes("plugin:prefs|set_meeting_ai_prompt")).toHaveLength(1));
    expect(writes("plugin:prefs|set_meeting_ai_prompt")[0]).toEqual({
      prompt: "Summarise in three bullets.",
    });

    fireEvent.click(screen.getByTestId("settings.aiLimits.prompt-reset"));
    await waitFor(() => expect(writes("plugin:prefs|set_meeting_ai_prompt")).toHaveLength(2));
    expect(writes("plugin:prefs|set_meeting_ai_prompt")[1]).toEqual({ prompt: null });
  });

  it("states which pref is device-local and which is shared", () => {
    // They behave differently after a write, so the block says which is which
    // rather than leaving the reader to find out on the next sync.
    render(<AiLimitsBlock budget={null} meetingPrompt={null} />);
    expect(screen.getByTestId("settings.aiLimits.budget-scope").textContent).toContain(
      "settings.ai.historyBudgetDeviceLocal",
    );
    expect(screen.getByTestId("settings.aiLimits.prompt-scope").textContent).toContain(
      "settings.ai.meetingPromptShared",
    );
  });

  it("does not write when a field was not edited", async () => {
    render(<AiLimitsBlock budget={1000} meetingPrompt={"kept"} />);
    fireEvent.click(screen.getByTestId("settings.aiLimits.budget-commit"));
    fireEvent.click(screen.getByTestId("settings.aiLimits.prompt-commit"));
    await Promise.resolve();
    expect(writes("plugin:prefs|set_chat_history_budget")).toEqual([]);
    expect(writes("plugin:prefs|set_meeting_ai_prompt")).toEqual([]);
  });

  it("reports a failed write and rolls the field back to disk truth", async () => {
    // The re-seed effects are keyed on the STORED value, which a failed write
    // leaves unchanged, so without the rollback the field keeps what the user
    // typed while `vault.prefs` keeps the old one and nothing says so. The
    // desktop twin reports through `usePrefs`'s `onShowToast`.
    invoke.mockImplementation(async () => {
      throw new Error("write failed");
    });
    const onToast = vi.fn();
    render(<AiLimitsBlock budget={1000} meetingPrompt={null} onToast={onToast} />);
    const field = screen.getByTestId("settings.aiLimits.budget") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "4000" } });
    fireEvent.click(screen.getByTestId("settings.aiLimits.budget-commit"));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("settings.saveSettingError"));
    await waitFor(() => expect(field.value).toBe("1000"));
  });
});

describe("budgetFromDraft", () => {
  it("reads empty as the host default, not as zero", () => {
    // `Number("")` is 0, so the naive read turns "clear the field" into "send no
    // history at all", which is a different setting.
    expect(budgetFromDraft("")).toBeNull();
    expect(budgetFromDraft("   ")).toBeNull();
  });

  it("accepts zero as a real value", () => {
    expect(budgetFromDraft("0")).toBe(0);
  });

  it("refuses input that is not a non-negative integer", () => {
    expect(budgetFromDraft("abc")).toBeUndefined();
    expect(budgetFromDraft("-1")).toBeUndefined();
    expect(budgetFromDraft("1.5")).toBeUndefined();
  });

  it("passes a value above the bound through, because the host clamps", () => {
    expect(budgetFromDraft(String(CHAT_HISTORY_BUDGET_MAX + 5000))).toBe(
      CHAT_HISTORY_BUDGET_MAX + 5000,
    );
  });
});
