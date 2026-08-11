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
let aiProvider: string | null = null;
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { ai_enabled: aiEnabled, ai_provider: aiProvider } }),
}));

// The backend state the tab reads (#191 tasks 1+3). Mocked at the HOOK rather
// than at `invoke`, so these tests drive the four states directly instead of
// reconstructing a wire payload for each.
let surfaceState: { kind: string; cause?: string | null } = { kind: "available" };
vi.mock("../../src/hooks/useAiModelReady", () => ({
  useAiSurfaceState: () => surfaceState,
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
  aiProvider = null;
  surfaceState = { kind: "available" };
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

// The resting state names its ACTUAL cause (#191 task 3).
//
// The old copy said "No model selected. Choose one in Settings" for every
// unavailable backend. That is wrong in two of the three cases — it tells a
// user whose runtime merely is not running to redo a setup they already did,
// and it offers a settings page to a build with no local AI compiled in. These
// assert the three are DIFFERENT, which is the whole claim; a spec that checked
// each in isolation would pass against a collapsed implementation.
describe("AiChatTab resting cause", () => {
  const chip = () => screen.getByTestId("ai.chrome-status");
  const body = () => screen.getByTestId("ai.status-no-model");

  it("says no provider when nothing is set up", () => {
    surfaceState = { kind: "unavailable", cause: "no_model" };
    render(<AiChatTab />);
    expect(chip().textContent).toBe("editor.chrome.rightPanel.aiChat.statusNoModel");
    expect(body().textContent).toBe("editor.chrome.rightPanel.aiChat.noModelHint");
    expect(chip().getAttribute("data-ai-cause")).toBe("no-provider");
  });

  it("says not answering when the configured backend is unreachable", () => {
    surfaceState = { kind: "unavailable", cause: "unreachable" };
    render(<AiChatTab />);
    expect(chip().textContent).toBe("editor.chrome.rightPanel.aiChat.statusUnreachable");
    expect(body().textContent).toBe("editor.chrome.rightPanel.aiChat.unreachableHint");
    expect(chip().getAttribute("data-ai-cause")).toBe("unreachable");
  });

  it("says unavailable when the build has no local AI at all", () => {
    surfaceState = { kind: "absent" };
    render(<AiChatTab />);
    expect(chip().textContent).toBe("editor.chrome.rightPanel.aiChat.statusUnavailable");
    expect(body().textContent).toBe("editor.chrome.rightPanel.aiChat.unavailableHint");
    expect(chip().getAttribute("data-ai-cause")).toBe("unavailable");
  });

  it("keeps the three apart — no two render the same sentence", () => {
    const chips = new Set<string>();
    const bodies = new Set<string>();
    for (const state of [
      { kind: "unavailable", cause: "no_model" },
      { kind: "unavailable", cause: "unreachable" },
      { kind: "absent" },
    ]) {
      surfaceState = state;
      const { unmount } = render(<AiChatTab />);
      chips.add(chip().textContent ?? "");
      bodies.add(body().textContent ?? "");
      unmount();
    }
    // Counted SEPARATELY. A composite of the two would stay unique while two
    // causes shared a body, which is exactly the collapse under test — the
    // sentence is the part the user reads.
    expect(chips.size).toBe(3);
    expect(bodies.size).toBe(3);
  });

  it("treats timeout and refused as not answering too", () => {
    for (const cause of ["timeout", "refused"]) {
      surfaceState = { kind: "unavailable", cause };
      const { unmount } = render(<AiChatTab />);
      expect(chip().getAttribute("data-ai-cause")).toBe("unreachable");
      unmount();
    }
  });

  it("shows nothing degraded while the host read is still in flight", () => {
    // A surface that flashed "No provider" for a frame before the answer
    // arrived would be telling the user something false.
    surfaceState = { kind: "checking" };
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.status-no-model")).toBeNull();
    expect(chip().getAttribute("data-ai-cause")).toBe("ready");
  });
});

// Attribution (#191 task 4, SYNC-13): which backend produced each answer.
describe("AiChatTab attribution", () => {
  it("names the active provider on the resting chip instead of a bare 'Ready'", () => {
    aiProvider = "openrouter";
    render(<AiChatTab />);
    // A proper noun, not a translation key — provider names are not i18n'd.
    expect(screen.getByTestId("ai.chrome-status").textContent).toBe("OpenRouter");
  });

  it("keeps 'Ready' when no provider is named", () => {
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.chrome-status").textContent).toBe(
      "editor.chrome.rightPanel.aiChat.statusReady",
    );
  });

  it("carries a finalized turn's own attribution, and none while it streams", () => {
    const token = sendChatMessage("who");
    appendChatToken(token, "an answer");
    const { rerender } = render(<AiChatTab />);
    // Streaming: nobody has answered yet, so nothing may claim to have.
    expect(screen.queryByTestId("ai.turn-answered-by")).toBeNull();

    finalizeChatTurn(token, [], { kind: "remote", provider: "OpenRouter" });
    rerender(<AiChatTab />);
    const line = screen.getByTestId("ai.turn-answered-by");
    expect(line.getAttribute("data-answered-by")).toBe("remote");
  });

  it("does not retroactively re-label an earlier turn when a later one comes from elsewhere", () => {
    const first = sendChatMessage("one");
    appendChatToken(first, "local answer");
    finalizeChatTurn(first, [], { kind: "in-process" });
    const second = sendChatMessage("two");
    appendChatToken(second, "remote answer");
    finalizeChatTurn(second, [], { kind: "remote", provider: "OpenRouter" });

    render(<AiChatTab />);
    const kinds = screen
      .getAllByTestId("ai.turn-answered-by")
      .map((el) => el.getAttribute("data-answered-by"));
    // The whole meaning of "persistent": switching provider must not rewrite
    // history. A re-render that read the LIVE backend would report both as
    // remote.
    expect(kinds).toEqual(["in-process", "remote"]);
  });

  it("renders no empty line for a turn finalized without provenance", () => {
    const token = sendChatMessage("no provenance");
    appendChatToken(token, "text");
    finalizeChatTurn(token, []);
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.turn-answered-by")).toBeNull();
  });
});
