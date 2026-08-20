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
// Which backend the HOST says is serving. Separate from `aiProvider` on
// purpose: naming a provider and having one answer are different facts, and the
// surface must render the second (myne-md/myne#466).
let backendClass: string | null = "in_process_local";
vi.mock("../../src/hooks/useAiModelReady", () => ({
  useAiSurfaceState: () => surfaceState,
  useAiBackendClass: () => backendClass,
}));

// The agent bindings the folded-in surfaces reach for. Stubbed rather than left
// to reject at the seam, so a test failure means what it says.
const agentLastRun = vi.fn();
const agentCapability = vi.fn();
const agentStart = vi.fn();
const agentPreviewGrant = vi.fn();
const agentApproveScope = vi.fn();
const agentCancel = vi.fn();
vi.mock("../../src/lib/agent-run", () => ({
  agentLastRun: (...a: unknown[]) => agentLastRun(...a),
  agentCapability: (...a: unknown[]) => agentCapability(...a),
  agentStart: (...a: unknown[]) => agentStart(...a),
  agentPreviewGrant: (...a: unknown[]) => agentPreviewGrant(...a),
  agentApproveScope: (...a: unknown[]) => agentApproveScope(...a),
  agentCancel: (...a: unknown[]) => agentCancel(...a),
  agentUndo: vi.fn(),
}));

// `AgentProgress` asks which arm is serving before it renders the expansion
// dialog's egress line. Only that one member is stubbed; `providerLabelOf` and
// `answeredByOf` stay real, because the tab renders the provider chip through
// them and a stub would make the chip assertion prove nothing.
const aiCapabilityReport = vi.fn();
vi.mock("../../src/lib/ai-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-capability")>()),
  aiCapabilityReport: (...a: unknown[]) => aiCapabilityReport(...a),
}));

const stopChat = vi.fn();
vi.mock("../../src/lib/ai-chat", () => ({
  stopChat: (...a: unknown[]) => stopChat(...a),
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
  failChatTurn,
  finalizeChatTurn,
  sendAgentTurn,
  sendChatMessage,
  settleAgentTurn,
  __resetChatForTest,
} from "../../src/notes/ai/chatStore";
import {
  beginRun,
  clearAgent,
  currentRunEpoch,
  setUndoable,
  settleStep,
  useAgent,
} from "../../src/notes/agent/agentStore";

beforeEach(() => {
  aiEnabled = true;
  aiProvider = null;
  backendClass = "in_process_local";
  surfaceState = { kind: "available" };
  __resetChatForTest();
  clearAgent();
  agentLastRun.mockReset().mockResolvedValue(null);
  agentCapability.mockReset();
  agentStart.mockReset();
  agentPreviewGrant.mockReset().mockResolvedValue({
    noteCount: 4,
    excludedCount: 0,
    unknownCount: 0,
    newTotal: 5,
  });
  agentApproveScope.mockReset();
  agentCancel.mockReset().mockResolvedValue(true);
  aiCapabilityReport.mockReset().mockResolvedValue({ compiled: false });
  stopChat.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  __resetChatForTest();
  clearAgent();
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

    it("stops claiming on-device inference once a provider is SERVING", () => {
      // The surface prints the provider's own name in the status chip a few
      // pixels away, so the pre-fix build said "OpenRouter" and "running on
      // your device" at the same time. `threat-model.md` TB13: on that arm the
      // decrypted note text leaves the machine.
      aiProvider = "openrouter";
      backendClass = "remote";
      render(<AiChatTab />);
      const note = screen.getByTestId("ai.honesty-note").textContent ?? "";
      expect(note).not.toContain("on your device");
      expect(note).toContain("OpenRouter");
      expect(note).toContain("may be wrong");
      // The chip and the note now agree about which backend is answering.
      expect(screen.getByTestId("ai.chrome-status").textContent).toContain("OpenRouter");
    });

    it("does not name a provider the host is not actually using", () => {
      // `active()` falls back to the local arm on six conditions with the pref
      // still set: no model chosen, consent or key missing, a preferences
      // snapshot from another vault. Naming it then attributes a note's text to
      // a third party that received nothing, which is myne-md/myne#466's
      // defect. The NAME comes from the preferences and the CLASS from the
      // host, and the name shows only for the class the host says is active.
      aiProvider = "openrouter";
      backendClass = "in_process_local";
      render(<AiChatTab />);
      const note = screen.getByTestId("ai.honesty-note").textContent ?? "";
      expect(note).toContain("on your device");
      expect(note).not.toContain("OpenRouter");
      expect(screen.getByTestId("ai.chrome-status").textContent).not.toContain(
        "OpenRouter",
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
      // Both routes to an empty answer arrive here, because they converge
      // BEFORE the store: a local engine finalizes with no text, and
      // `ai-chat.ts` finalizes the remote `empty_completion` cause rather than
      // failing it (the model was reached and answered with nothing). That is
      // why the component tests one field rather than a boolean plus a sibling
      // string, and why the boundary owns the classification.
      const token = sendChatMessage("Hello");
      finalizeChatTurn(token, []); // no tokens appended → empty answer
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.no-answer")).toBeTruthy();
      // The user turn is not treated as a no-answer placeholder.
      expect(screen.getAllByTestId("ai.turn")[0].getAttribute("data-role")).toBe("user");
    });
  });

  // myne#466 — four situations used to render one sentence. These assert the
  // routing DIFFERS, which is the whole claim; asserting each in isolation
  // would pass against a collapsed implementation, and did.
  describe("a provider that answered without answering (myne#466)", () => {
    it("renders a policy refusal as an alert that points at the provider", () => {
      const token = sendChatMessage("Hello");
      failChatTurn(token, "policy_refused");
      render(<AiChatTab />);
      expect(screen.queryByTestId("ai.no-answer")).toBeNull();
      const alert = screen.getByTestId("ai.turn-error");
      // Not the "try rephrasing" advice, and not the old catch-all's untrue
      // claim that nothing was sent — the note text HAD been sent.
      expect(alert.textContent).not.toMatch(/rephras/i);
      expect(alert.textContent).toMatch(/provider/i);
    });

    it("keeps the three failure causes distinct from one another", () => {
      const seen = new Set<string>();
      for (const cause of ["policy_refused", "local_model_missing", "not_ready"] as const) {
        __resetChatForTest();
        const token = sendChatMessage("Hello");
        failChatTurn(token, cause);
        const { unmount } = render(<AiChatTab />);
        seen.add(screen.getByTestId("ai.turn-error").textContent ?? "");
        unmount();
      }
      expect(seen.size, "two causes render the same sentence").toBe(3);
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
    backendClass = "remote";
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

describe("AiChatTab: the agent run is a turn in the same transcript", () => {
  const SUMMARY = {
    runId: "r1",
    edits: 4,
    newNotes: 1,
    notesRead: 6,
    iterations: 3,
    charsOffDevice: null,
    end: "finished" as const,
  };

  it("renders one transcript holding both kinds of turn", () => {
    const token = sendChatMessage("what did I write about tea");
    appendChatToken(token, "you wrote…");
    finalizeChatTurn(token, []);
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn(SUMMARY);

    render(<AiChatTab />);
    const kinds = screen.getAllByTestId("ai.turn").map((el) => el.getAttribute("data-kind"));
    // Two text turns from the question, then BOTH halves of the run. The task
    // is an ordinary bubble that belongs to the agent flow, and `data-kind`
    // reports the flow so the DOM says what the store says.
    expect(kinds).toEqual(["text", "text", "agent", "agent"]);
    const roles = screen.getAllByTestId("ai.turn").map((el) => el.getAttribute("data-role"));
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(screen.getAllByTestId("ai.transcript")).toHaveLength(1);
  });

  it("states the run's outcome and its cost, counts only", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn(SUMMARY);
    render(<AiChatTab />);

    const summary = screen.getByTestId("ai.agent-summary").textContent ?? "";
    expect(summary).toContain("agentTurn.proposed:4");
    expect(summary).toContain("agentTurn.newNotes:1");

    // The three figures the review screen reports. The third is the one the
    // remote arm's compensating control rests on (docs/decisions/ai/0515), so
    // "the run stayed local" must not render as a zero character count.
    const cost = screen.getByTestId("ai.agent-run-cost").textContent ?? "";
    expect(cost).toContain("runSummaryRequests:3");
    expect(cost).toContain("runSummaryNotes:6");
    expect(cost).toContain("agent.review.runSummaryOnDevice");
    expect(cost).not.toContain("runSummaryOffDevice");
  });

  it("keeps a remote run's off-device character count distinct from a local one", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({ ...SUMMARY, charsOffDevice: 0 });
    render(<AiChatTab />);
    // Remote, and nothing was sent. Not the same statement as "it stayed here",
    // and collapsing the two is what this asserts against.
    expect(screen.getByTestId("ai.agent-run-cost").textContent).toContain(
      "runSummaryOffDevice:0",
    );
  });

  it("shows the scope the task was sent under, on the user's own turn", () => {
    sendAgentTurn("tidy the headings", "Projects");
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.turn-scope").textContent).toContain("Projects");
  });

  it("counts only what the run actually proposed", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({ ...SUMMARY, edits: 0, newNotes: 1 });
    render(<AiChatTab />);
    const partial = screen.getByTestId("ai.agent-summary").textContent ?? "";
    expect(partial).toContain("agentTurn.newNotes:1");
    // A run that created a note and changed none must not also claim "proposed
    // 0 changes"; each half of the sentence is present only when it is true.
    expect(partial).not.toContain("agentTurn.proposed");
  });

  it("says nothing was proposed rather than showing an empty run", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({ ...SUMMARY, edits: 0, newNotes: 0 });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
      "agent.review.noChanges",
    );
  });

  it("names a run that was cancelled or ran out of steps", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({ ...SUMMARY, end: "cancelled" });
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.agent-run-end").textContent).toContain(
      "agent.progress.cancelled",
    );
  });

  it("keeps a finished run readable after its proposal has been dropped", () => {
    // Closing the review screen calls `clearAgent()`, which is the ordinary
    // thing to do. Before the counts were frozen onto the turn, that left the
    // transcript showing a run that had said nothing.
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn(SUMMARY);
    clearAgent();
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
      "agentTurn.proposed:4",
    );
  });
});

describe("AiChatTab: the live run's controls", () => {
  /** A run parked on a model-requested scope expansion, as the store holds it
   *  after `agent_start` returns `awaitingScope`. */
  function parkOnScopeQuestion() {
    sendAgentTurn("tidy the headings", "This note");
    beginRun();
    settleStep({
      view: { runId: "r1", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
      proposal: { edits: [], newNotes: [], summary: "" },
      end: { kind: "awaitingScope", folder: "Projects", reason: "to find the notes" },
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      excludedCount: 0,
    }, currentRunEpoch());
  }

  it("renders the scope-expansion gate through the production mount path", async () => {
    // **This is the mount path nothing covered.** The gate used to render
    // inside the agent turn, i.e. inside the scrolling transcript at 92% of a
    // 280px sidebar; deleting its mount left the whole suite green.
    // `docs/decisions/ai/0515` makes this dialog the entire bound on
    // model-originated scope growth, so its reachability is the feature.
    parkOnScopeQuestion();
    render(<AiChatTab onSend={() => {}} />);
    await screen.findByTestId("agentScope.dialog");
    expect(screen.getByTestId("agentScope.approve")).toBeTruthy();
    expect(screen.getByTestId("agentScope.decline")).toBeTruthy();

    // And it is NOT inside the scrolling region, so a reader who has scrolled
    // up cannot be asked a question they cannot see.
    const scroller = screen.getByTestId("ai.transcript").parentElement!;
    expect(scroller.contains(screen.getByTestId("agentScope.dialog"))).toBe(false);
    // The running scope total is one of the four bounds threat-model.md §7
    // names; it is outside the scroller for the same reason.
    expect(scroller.contains(screen.getByTestId("agentProgress.scopeTotal"))).toBe(false);
  });

  it("New chat stops the run host-side before forgetting it", async () => {
    parkOnScopeQuestion();
    render(<AiChatTab onSend={() => {}} />);
    await screen.findByTestId("agentScope.dialog");
    fireEvent.click(screen.getByTestId("ai.new-chat"));
    // Forgetting a run is not stopping one: the host keeps its run table, keeps
    // reading notes, and on a remote provider keeps spending the user's
    // requests. The strip that carried Stop is gone with the transcript.
    expect(agentCancel).toHaveBeenCalledWith("r1");
    expect(screen.queryByTestId("agentProgress.root")).toBeNull();
  });

  it("New chat stops an in-flight ask generation too", () => {
    const token = sendChatMessage("what is this note about");
    appendChatToken(token, "partial");
    render(<AiChatTab onSend={() => {}} />);
    fireEvent.click(screen.getByTestId("ai.new-chat"));
    // `clearChat()` resets `streaming`, so the Stop control disappears with the
    // transcript. Without this the generation runs on with nothing to end it.
    expect(stopChat).toHaveBeenCalled();
  });
});

describe("AiChatTab: the shape of a chat", () => {
  it("puts the composer last, under one scrolling transcript", () => {
    const token = sendChatMessage("hello");
    finalizeChatTurn(token, []);
    render(<AiChatTab onSend={() => {}} />);

    const tab = screen.getByTestId("ai.chat-tab");
    const composer = screen.getByTestId("ai.composer");
    const transcript = screen.getByTestId("ai.transcript");

    // The composer is the tab's LAST child, which is what keeps it under the
    // reader's hands instead of somewhere down a page that scrolls as a whole.
    expect(tab.lastElementChild).toBe(composer);

    // …and the region that scrolls is the transcript's own container, not the
    // tab. A tab that scrolled as one would carry the composer off screen the
    // moment a conversation got long, which is the shape this replaced.
    const scroller = transcript.parentElement!;
    expect(scroller.style.overflowY).toBe("auto");
    expect(tab.style.overflowY).toBe("");
    expect(scroller.contains(composer)).toBe(false);

    // One transcript, one composer, one Send. The tab used to mount two of the
    // last two (myne-md/myne#533).
    expect(screen.getAllByTestId("ai.transcript")).toHaveLength(1);
    expect(screen.getAllByTestId("ai.composer-input")).toHaveLength(1);
    expect(screen.getAllByTestId("ai.composer-send")).toHaveLength(1);
  });

  it("keeps the honesty note and the status out of the scrolling region", () => {
    const token = sendChatMessage("hello");
    finalizeChatTurn(token, []);
    render(<AiChatTab onSend={() => {}} />);
    const scroller = screen.getByTestId("ai.transcript").parentElement!;
    // Both are standing statements about what this surface is, so neither may
    // scroll away: the note is the fallibility warning the answers are read
    // against, and the chip names which backend is answering.
    expect(scroller.contains(screen.getByTestId("ai.honesty-note"))).toBe(false);
    expect(scroller.contains(screen.getByTestId("ai.chrome-status"))).toBe(false);
  });
});

describe("AiChatTab: starting a new conversation", () => {
  function Undoable() {
    // Reads the store so the assertion is about state rather than about a
    // render that might have been memoized away.
    return <span data-testid="probe.undoable">{useAgent().undoable ? "yes" : "no"}</span>;
  }

  it("is offered only once there is something to clear", () => {
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.new-chat")).toBeNull();
    cleanup();
    const token = sendChatMessage("hello");
    finalizeChatTurn(token, []);
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.new-chat")).toBeTruthy();
  });

  it("drops the transcript and the open run, but not the undo offer", () => {
    const token = sendChatMessage("hello");
    finalizeChatTurn(token, []);
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({
      runId: "r1",
      edits: 1,
      newNotes: 0,
      notesRead: 1,
      iterations: 1,
      charsOffDevice: null,
      end: "finished",
    });
    setUndoable(
      {
        runId: "r1",
        restorePoints: [["n1", "s1"]],
        notesCreated: [],
      } as never,
      currentRunEpoch(),
    );

    render(
      <>
        <AiChatTab />
        <Undoable />
      </>,
    );
    fireEvent.click(screen.getByTestId("ai.new-chat"));

    expect(screen.queryByTestId("ai.turn")).toBeNull();
    // The undo describes notes ALREADY written to the vault. Starting a new
    // conversation does not un-write them, so this must survive, which is why
    // the handler calls `clearAgent`, not `clearAgentForLock`.
    expect(screen.getByTestId("probe.undoable").textContent).toBe("yes");
  });
});
