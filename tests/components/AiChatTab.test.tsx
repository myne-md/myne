// @vitest-environment jsdom
//
// Component tests for `src/notes/components/AiChatTab.tsx` (note-summarization
// task 4 render + ai-ux-surface MYND-408). Drives the real module-level
// `aiOutputStore` and asserts the tab renders each lifecycle state. `usePrefs`
// + i18n are mocked at their module boundaries (no Tauri IPC needed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let aiEnabled = true;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { ai_enabled: aiEnabled } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import { AiChatTab } from "../../src/notes/components/AiChatTab";
import {
  dispatchAiOutput,
  __resetAiOutputForTest,
} from "../../src/notes/ai/aiOutputStore";
import {
  dispatchTagSuggest,
  __resetTagSuggestForTest,
} from "../../src/notes/ai/tagSuggestStore";

beforeEach(() => {
  aiEnabled = true;
  __resetAiOutputForTest();
  __resetTagSuggestForTest();
});
afterEach(() => {
  cleanup();
  __resetAiOutputForTest();
  __resetTagSuggestForTest();
});

describe("AiChatTab", () => {
  it("shows the empty hint when idle and AI is enabled", () => {
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.chat-tab")).toBeTruthy();
    expect(screen.queryByTestId("ai.thinking")).toBeNull();
    expect(screen.queryByTestId("ai.output")).toBeNull();
    expect(screen.getByTestId("ai.chrome-status").getAttribute("data-ai-enabled")).toBe(
      "true",
    );
  });

  it("reflects AI-off in the chrome status", () => {
    aiEnabled = false;
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.chrome-status").getAttribute("data-ai-enabled")).toBe(
      "false",
    );
  });

  it("renders the thinking affordance during a blocking call", () => {
    dispatchAiOutput({ type: "THINKING" });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.thinking")).toBeTruthy();
    expect(screen.queryByTestId("ai.output")).toBeNull();
  });

  it("renders the resolved output text", () => {
    dispatchAiOutput({
      type: "RESOLVED",
      text: "This is the summary.",
      truncated: false,
      summarizedChars: 0,
    });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.output").textContent).toBe("This is the summary.");
    expect(screen.queryByTestId("ai.truncation-notice")).toBeNull();
  });

  it("shows the truncation notice with the character count when truncated", () => {
    dispatchAiOutput({
      type: "RESOLVED",
      text: "partial",
      truncated: true,
      summarizedChars: 1200,
    });
    render(<AiChatTab />);
    const notice = screen.getByTestId("ai.truncation-notice");
    expect(notice.textContent).toContain("1200");
  });

  it("shows the Insert button only when onInsert is provided and fires it with the text", () => {
    dispatchAiOutput({
      type: "RESOLVED",
      text: "insert me",
      truncated: false,
      summarizedChars: 0,
    });
    const onInsert = vi.fn();
    render(<AiChatTab onInsert={onInsert} />);
    const btn = screen.getByTestId("ai.insert-summary");
    fireEvent.click(btn);
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith("insert me");
  });

  it("hides the Insert button when no onInsert is wired", () => {
    dispatchAiOutput({
      type: "RESOLVED",
      text: "x",
      truncated: false,
      summarizedChars: 0,
    });
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.insert-summary")).toBeNull();
  });

  it("renders the error state on failure", () => {
    dispatchAiOutput({ type: "FAILED" });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.output-error")).toBeTruthy();
  });

  it("clears the rendered output when the store is torn down (lock)", () => {
    dispatchAiOutput({
      type: "RESOLVED",
      text: "held",
      truncated: false,
      summarizedChars: 0,
    });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.output")).toBeTruthy();
    act(() => {
      dispatchAiOutput({ type: "CLEARED" });
    });
    expect(screen.queryByTestId("ai.output")).toBeNull();
  });

  it("renders tag-suggestion chips and fires onAcceptTag on click", () => {
    dispatchTagSuggest({
      type: "READY",
      suggestions: [
        { tag: "work", isNew: false },
        { tag: "rust", isNew: true },
      ],
    });
    const onAcceptTag = vi.fn();
    render(<AiChatTab onAcceptTag={onAcceptTag} />);
    const chips = screen.getAllByTestId("ai.tag-chip");
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]);
    expect(onAcceptTag).toHaveBeenCalledWith({ tag: "rust", isNew: true });
  });

  it("shows the tags-thinking affordance during a suggest pass", () => {
    dispatchTagSuggest({ type: "THINKING" });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.tags-thinking")).toBeTruthy();
    expect(screen.queryByTestId("ai.tag-chips")).toBeNull();
  });

  // semantic-search-qa (MYND-412) tasks 6/7 — the grounded-Q&A question box.
  it("renders the ask input + submit only when AI is on AND onAsk is wired", () => {
    // Wired + AI on → shown.
    render(<AiChatTab onAsk={vi.fn()} />);
    expect(screen.getByTestId("ai.ask-input")).toBeTruthy();
    expect(screen.getByTestId("ai.ask-submit")).toBeTruthy();
    cleanup();

    // No onAsk → not shown (isolation / read-only).
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.ask-input")).toBeNull();
    cleanup();

    // AI off → not shown even when onAsk is wired.
    aiEnabled = false;
    render(<AiChatTab onAsk={vi.fn()} />);
    expect(screen.queryByTestId("ai.ask-input")).toBeNull();
  });

  it("fires onAsk with the trimmed question on submit and clears the input", () => {
    const onAsk = vi.fn();
    render(<AiChatTab onAsk={onAsk} />);
    const input = screen.getByTestId("ai.ask-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  what did I note?  " } });
    fireEvent.click(screen.getByTestId("ai.ask-submit"));
    expect(onAsk).toHaveBeenCalledWith("what did I note?");
    expect(input.value).toBe("");
  });

  it("does not fire onAsk for a blank question (submit disabled / no-op)", () => {
    const onAsk = vi.fn();
    render(<AiChatTab onAsk={onAsk} />);
    const input = screen.getByTestId("ai.ask-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("ai.ask-submit"));
    expect(onAsk).not.toHaveBeenCalled();
  });
});
