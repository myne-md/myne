// @vitest-environment jsdom
//
// Component tests for `src/notes/components/AiChatTab.tsx` — the conversational
// chat surface (conversational-ai-chat tasks 6-13). Drives the real module-level
// `chatStore` and asserts the transcript, composer, citations, honesty note, and
// the folded-in summary-insert + tag-accept turn actions (tasks 10/11).
// `usePrefs` + i18n are mocked at their module boundaries (no Tauri IPC needed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
  appendChatToken,
  finalizeChatTurn,
  sendChatMessage,
  __resetChatForTest,
} from "../../src/notes/ai/chatStore";

beforeEach(() => {
  aiEnabled = true;
  __resetChatForTest();
});
afterEach(() => {
  cleanup();
  __resetChatForTest();
});

describe("AiChatTab", () => {
  it("shows the empty hint when idle and AI is enabled", () => {
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.chat-tab")).toBeTruthy();
    expect(screen.queryByTestId("ai.transcript")).toBeNull();
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

  describe("conversational transcript + composer", () => {
    it("renders transcript turns from the chat store", () => {
      const token = sendChatMessage("what did I note about rust?");
      appendChatToken(token, "You wrote about ownership.");
      finalizeChatTurn(token, []);
      render(<AiChatTab />);
      const turns = screen.getAllByTestId("ai.turn");
      expect(turns).toHaveLength(2);
      expect(turns[0].getAttribute("data-role")).toBe("user");
      expect(turns[1].getAttribute("data-role")).toBe("assistant");
      expect(turns[1].textContent).toContain("You wrote about ownership.");
    });

    it("shows the streaming caret on an in-flight assistant turn", () => {
      const token = sendChatMessage("q");
      appendChatToken(token, "partial…");
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.turn-streaming")).toBeTruthy();
    });

    it("renders the composer when onSend is wired and AI is on; hidden when AI off", () => {
      render(<AiChatTab onSend={vi.fn()} />);
      expect(screen.getByTestId("ai.composer-input")).toBeTruthy();
      expect(screen.getByTestId("ai.composer-send")).toBeTruthy();
      cleanup();

      render(<AiChatTab />);
      expect(screen.queryByTestId("ai.composer-input")).toBeNull();
      cleanup();

      aiEnabled = false;
      render(<AiChatTab onSend={vi.fn()} />);
      expect(screen.queryByTestId("ai.composer-input")).toBeNull();
    });

    it("fires onSend with the trimmed message and clears the composer", () => {
      const onSend = vi.fn();
      render(<AiChatTab onSend={onSend} />);
      const input = screen.getByTestId("ai.composer-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "  hello there  " } });
      fireEvent.click(screen.getByTestId("ai.composer-send"));
      expect(onSend).toHaveBeenCalledWith("hello there");
      expect(input.value).toBe("");
    });

    it("shows the Stop control (not Send) while streaming and fires onStop", () => {
      const onStop = vi.fn();
      const token = sendChatMessage("q");
      appendChatToken(token, "streaming…");
      render(<AiChatTab onSend={vi.fn()} onStop={onStop} />);
      expect(screen.queryByTestId("ai.composer-send")).toBeNull();
      fireEvent.click(screen.getByTestId("ai.composer-stop"));
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("renders citation chips and fires onOpenNote on click", () => {
      const token = sendChatMessage("q");
      appendChatToken(token, "answer");
      finalizeChatTurn(token, [
        { noteId: "01970e83aaaa", byteStart: 4, byteEnd: 20, score: 0.9 },
      ]);
      const onOpenNote = vi.fn();
      render(<AiChatTab onOpenNote={onOpenNote} />);
      fireEvent.click(screen.getByTestId("ai.citation"));
      expect(onOpenNote).toHaveBeenCalledWith("01970e83aaaa", 4, 20);
    });

    it("labels a citation with the note title when titleOf resolves it", () => {
      const token = sendChatMessage("q");
      appendChatToken(token, "a");
      finalizeChatTurn(token, [{ noteId: "01970e83aaaa", byteStart: 0, byteEnd: 3, score: 1 }]);
      render(
        <AiChatTab titleOf={(id) => (id === "01970e83aaaa" ? "My Rust Notes" : null)} />,
      );
      expect(screen.getByTestId("ai.citation").textContent).toBe("My Rust Notes");
    });

    it("hides the empty hint once the transcript has turns", () => {
      sendChatMessage("q");
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.transcript")).toBeTruthy();
    });

    it("renders the load-bearing honesty note verbatim when AI is ready", () => {
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.honesty-note").textContent).toBe(
        "Answers come from a small model running on your device and may be wrong — check the notes it cites.",
      );
    });
  });

  // conversational-ai-chat tasks 10/11 — summarize + tag folded into turns.
  describe("folded-in summary insert + tag accept (tasks 10/11)", () => {
    it("shows an Insert action on an insertable summary turn and fires onInsert", () => {
      const token = sendChatMessage("Summarize this note", { insertable: true });
      appendChatToken(token, "This is the summary.");
      finalizeChatTurn(token, []);
      const onInsert = vi.fn();
      render(<AiChatTab onInsert={onInsert} />);
      fireEvent.click(screen.getByTestId("ai.insert-turn"));
      expect(onInsert).toHaveBeenCalledWith("This is the summary.");
    });

    it("shows no Insert action on an ordinary (non-insertable) chat turn", () => {
      const token = sendChatMessage("hi");
      appendChatToken(token, "hello");
      finalizeChatTurn(token, []);
      render(<AiChatTab onInsert={vi.fn()} />);
      expect(screen.queryByTestId("ai.insert-turn")).toBeNull();
    });

    it("renders no tag chips — the chat tab is not a tag surface (MYND-651)", () => {
      const token = sendChatMessage("Suggest tags for this note");
      finalizeChatTurn(token, []);
      render(<AiChatTab />);
      expect(screen.queryByTestId("ai.tag-chip")).toBeNull();
      expect(screen.queryByTestId("ai.turn-tags")).toBeNull();
    });

    it("shows a placeholder for an empty finalized assistant answer", () => {
      const token = sendChatMessage("Hello");
      finalizeChatTurn(token, []); // no tokens appended → empty answer
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.no-answer")).toBeTruthy();
      // The user turn is not treated as a no-answer placeholder.
      expect(screen.getAllByTestId("ai.turn")[0].getAttribute("data-role")).toBe("user");
    });
  });
});
