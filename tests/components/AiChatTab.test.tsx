// @vitest-environment jsdom
//
// Component tests for `src/notes/components/AiChatTab.tsx` — the conversational
// chat surface (conversational-ai-chat tasks 6-13). Drives the real module-level
// `chatStore` and asserts the transcript, composer, citations, honesty note, and
// the folded-in summary-insert + tag-accept turn actions (tasks 10/11).
// `usePrefs` + i18n are mocked at their module boundaries (no Tauri IPC needed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
// Whether ASKING can answer, which is a second capability the header reads
// (myne-md/myne#545): retrieval is refused a remote provider outright, and the
// embedding model is not bundled, so a working provider says nothing about
// whether a question can be grounded.
let retrievalState: { embedding: { kind: string }; indexReady: boolean } = {
  embedding: { kind: "available" },
  indexReady: true,
};
vi.mock("../../src/hooks/useAiModelReady", () => ({
  useAiSurfaceState: () => surfaceState,
  useAiBackendClass: () => backendClass,
  useAiRetrievalState: () => retrievalState,
}));

// The agent bindings the folded-in surfaces reach for. Stubbed rather than left
// to reject at the seam, so a test failure means what it says.
const agentLastRun = vi.fn();
const agentUndo = vi.fn();
const agentCapability = vi.fn();
const agentStart = vi.fn();
const agentPreviewGrant = vi.fn();
const agentApproveScope = vi.fn();
const agentCancel = vi.fn();
vi.mock("../../src/lib/agent-run", () => ({
  agentLastRun: (...a: unknown[]) => agentLastRun(...a),
  agentUndo: (...a: unknown[]) => agentUndo(...a),
  agentCapability: (...a: unknown[]) => agentCapability(...a),
  agentStart: (...a: unknown[]) => agentStart(...a),
  agentPreviewGrant: (...a: unknown[]) => agentPreviewGrant(...a),
  agentApproveScope: (...a: unknown[]) => agentApproveScope(...a),
  agentCancel: (...a: unknown[]) => agentCancel(...a),
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

import { AI_CHAT_HONESTY_NOTE } from "../../src/lib/load-bearing-copy";
import { AiChatTab } from "../../src/notes/components/AiChatTab";
import { ChatComposer } from "../../src/notes/components/ChatComposer";
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
  openRun,
  setUndoable,
  settleStep,
  useAgent,
} from "../../src/notes/agent/agentStore";

beforeEach(() => {
  aiEnabled = true;
  aiProvider = null;
  backendClass = "in_process_local";
  surfaceState = { kind: "available" };
  retrievalState = { embedding: { kind: "available" }, indexReady: true };
  __resetChatForTest();
  clearAgent();
  agentLastRun.mockReset().mockResolvedValue(null);
  agentUndo.mockReset().mockResolvedValue({ reverted: 0, failed: [], notesCreatedNotReverted: 0 });
  agentCapability.mockReset();
  agentStart.mockReset();
  agentPreviewGrant.mockReset().mockResolvedValue({
    noteCount: 4,
    excludedCount: 0,
    memoryUpdated: 0,unknownCount: 0,
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

  // myne-md/myne#545. The header used to read the GENERATION row only, so a
  // configuration where asking can never answer rendered the provider's name,
  // which reads as ready. The three states below are what it reads now.
  describe("what the header says about asking", () => {
    it("says no search model when retrieval cannot run at all", () => {
      // The reported configuration: a provider named and working, and no local
      // embedding model. Retrieval is refused a provider outright (SYNC-16), so
      // no provider setting can make asking work here.
      aiProvider = "openrouter";
      backendClass = "remote";
      retrievalState = { embedding: { kind: "unavailable" }, indexReady: false };
      render(<AiChatTab />);
      const chip = screen.getByTestId("ai.chrome-status").textContent ?? "";
      expect(chip).toContain("aiChat.statusNoSearchModel");
      expect(chip).not.toContain("OpenRouter");
    });

    it("says it is preparing while the index is still being built", () => {
      // A state the guide documents and production could not reach: the
      // `gettingReady` prop had no caller, so its `false` default always won.
      retrievalState = { embedding: { kind: "available" }, indexReady: false };
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.chrome-status").textContent).toContain(
        "aiChat.statusGettingReady",
      );
    });

    it("goes back to naming the backend once retrieval is ready", () => {
      aiProvider = "openrouter";
      backendClass = "remote";
      retrievalState = { embedding: { kind: "available" }, indexReady: true };
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.chrome-status").textContent).toContain(
        "OpenRouter",
      );
    });
  });

  describe("conversational transcript + composer", () => {
    it("renders transcript turns from the chat store", () => {
      const token = sendChatMessage("what did I note about rust?");
      appendChatToken(token, "You wrote about ownership.");
      finalizeChatTurn(token);
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
      finalizeChatTurn(token);
      const onInsert = vi.fn();
      render(<AiChatTab onInsert={onInsert} />);
      fireEvent.click(screen.getByTestId("ai.insert-turn"));
      expect(onInsert).toHaveBeenCalledWith("This is the summary.");
    });

    it("shows no Insert action on an ordinary (non-insertable) chat turn", () => {
      const token = sendChatMessage("hi");
      appendChatToken(token, "hello");
      finalizeChatTurn(token);
      render(<AiChatTab onInsert={vi.fn()} />);
      expect(screen.queryByTestId("ai.insert-turn")).toBeNull();
    });

    it("renders no tag chips — the chat tab is not a tag surface (MYND-651)", () => {
      const token = sendChatMessage("Suggest tags for this note");
      finalizeChatTurn(token);
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
      finalizeChatTurn(token); // no tokens appended → empty answer
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

  /**
   * The degraded region NAMES the fault and then explains it (task 11 of
   * myne-md/myne#771). It used to be a bare sentence in `--fg-3`, with the name
   * carried only by the header chip a glance away — so the transcript said why
   * without saying what. `toContain` rather than `toBe` because the region now
   * holds both, and both are asserted: a title that stopped matching its chip
   * would put two different names for one fault on one screen.
   */
  function expectsFault(titleKey: string, bodyKey: string): void {
    expect(chip().textContent).toBe(titleKey);
    expect(body().textContent, "the fault is not named where it is explained").toContain(
      titleKey,
    );
    expect(body().textContent).toContain(bodyKey);
  }

  it("says no provider when nothing is set up", () => {
    surfaceState = { kind: "unavailable", cause: "no_model" };
    render(<AiChatTab />);
    expectsFault(
      "editor.chrome.rightPanel.aiChat.statusNoModel",
      "editor.chrome.rightPanel.aiChat.noModelHint",
    );
    expect(chip().getAttribute("data-ai-cause")).toBe("no-provider");
    // The cause rides on the SAME element as the testid: `e2e/ai-degradation`
    // reads both off one node, and splitting them would make that scenario
    // silently read `null` rather than fail.
    expect(body().getAttribute("data-ai-cause")).toBe("no-provider");
  });

  it("says not answering when the configured backend is unreachable", () => {
    surfaceState = { kind: "unavailable", cause: "unreachable" };
    render(<AiChatTab />);
    expectsFault(
      "editor.chrome.rightPanel.aiChat.statusUnreachable",
      "editor.chrome.rightPanel.aiChat.unreachableHint",
    );
    expect(chip().getAttribute("data-ai-cause")).toBe("unreachable");
    // The cause rides on the SAME element as the testid: `e2e/ai-degradation`
    // reads both off one node, and splitting them would make that scenario
    // silently read `null` rather than fail.
    expect(body().getAttribute("data-ai-cause")).toBe("unreachable");
  });

  it("says unavailable when the build has no local AI at all", () => {
    surfaceState = { kind: "absent" };
    render(<AiChatTab />);
    expectsFault(
      "editor.chrome.rightPanel.aiChat.statusUnavailable",
      "editor.chrome.rightPanel.aiChat.unavailableHint",
    );
    expect(chip().getAttribute("data-ai-cause")).toBe("unavailable");
    // The cause rides on the SAME element as the testid: `e2e/ai-degradation`
    // reads both off one node, and splitting them would make that scenario
    // silently read `null` rather than fail.
    expect(body().getAttribute("data-ai-cause")).toBe("unavailable");
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

    finalizeChatTurn(token, { kind: "remote", provider: "OpenRouter" });
    rerender(<AiChatTab />);
    const line = screen.getByTestId("ai.turn-answered-by");
    expect(line.getAttribute("data-answered-by")).toBe("remote");
  });

  it("does not retroactively re-label an earlier turn when a later one comes from elsewhere", () => {
    const first = sendChatMessage("one");
    appendChatToken(first, "local answer");
    finalizeChatTurn(first, { kind: "in-process" });
    const second = sendChatMessage("two");
    appendChatToken(second, "remote answer");
    finalizeChatTurn(second, { kind: "remote", provider: "OpenRouter" });

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
    finalizeChatTurn(token);
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.turn-answered-by")).toBeNull();
  });
});

describe("AiChatTab: the agent run is a turn in the same transcript", () => {
  const SUMMARY = {
    runId: "r1",
    summary: "",
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
    finalizeChatTurn(token);
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
    // remote arm's compensating control rests on (design-notes/ai/0515), so
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

  // myne-md/myne#741. The inline Before/After blocks are gone; a settled turn
  // carries a diff icon that opens one read-only modal. Read-only still: a
  // frozen proposal may quote a note that has since changed, so NOTHING in the
  // modal may write: no insert control, no apply button.
  it("opens a settled run's frozen proposal in a read-only diff modal", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({
      ...SUMMARY,
      proposal: {
        edits: [{ noteId: "n1", anchor: "old words", replacement: "new words" }],
        newNotes: [{ title: "Scratch", body: "fresh text", folder: null }],
      },
    });
    render(<AiChatTab />);

    expect(screen.queryByTestId("ai.proposal-diff")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.turn-diff"));

    const modal = screen.getByTestId("ai.proposal-diff-body");
    expect(modal.textContent).toContain("old words");
    expect(modal.textContent).toContain("new words");
    expect(modal.textContent).toContain("Scratch");
    expect(modal.textContent).toContain("fresh text");
    expect(
      screen
        .getAllByTestId("ai.proposal-edit")[0]!
        .getAttribute("data-note-id"),
    ).toBe("n1");
    // Read-only in the strong sense: the ONLY button in the modal is its close.
    // `ai.insert-turn` alone would pass even if a write control were added.
    expect(
      screen.getByTestId("ai.proposal-diff").querySelectorAll("button").length,
    ).toBe(1);
    expect(screen.getByTestId("ai.proposal-diff-close")).toBeTruthy();
    expect(screen.queryByTestId("ai.insert-turn")).toBeNull();
  });

  it("renders no diff icon for a run that proposed nothing", () => {
    sendAgentTurn("how many tasks", "This note");
    settleAgentTurn({ ...SUMMARY, edits: 0, newNotes: 0 });
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.turn-diff")).toBeNull();
    expect(screen.queryByTestId("ai.agent-proposal")).toBeNull();
  });

  // myne-md/myne#741. The strip under the composer is gone; the offer lives on
  // the host's current undoable run as a revert icon on that turn only.
  describe("the revert offer", () => {
    function offerRun(runId = "r1"): void {
      agentLastRun.mockResolvedValue({
        runId,
        restorePoints: [["n1", "s1"]],
        notesCreated: [],
      });
    }

    it("shows the revert icon only on the host's current undoable run", async () => {
      offerRun("r1");
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
      // The fallback is SUPPRESSED while a turn hosts the run; without this the
      // condition and "always show it" are indistinguishable.
      expect(screen.queryByTestId("ai.revert-fallback")).toBeNull();
      expect(agentLastRun).toHaveBeenCalled();
    });

    it("hides it when the host holds no undoable record", async () => {
      agentLastRun.mockResolvedValue(null);
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
      expect(screen.queryByTestId("ai.turn-revert")).toBeNull();
    });

    it("confirms before undoing and reports the result on the turn", async () => {
      offerRun("r1");
      agentUndo.mockResolvedValue({ reverted: 1, failed: [], notesCreatedNotReverted: 0 });
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());

      fireEvent.click(screen.getByTestId("ai.turn-revert"));
      expect(screen.getByTestId("ai.revert-confirm")).toBeTruthy();

      fireEvent.click(screen.getByTestId("ai.revert-confirm-undo"));
      await waitFor(() => expect(agentUndo).toHaveBeenCalledWith("r1"));
      expect(agentUndo).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
      // The offer is gone once the host consumes its record.
      expect(screen.queryByTestId("ai.turn-revert")).toBeNull();
    });

    it("cancels without calling undo", async () => {
      offerRun("r1");
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
      fireEvent.click(screen.getByTestId("ai.turn-revert"));
      fireEvent.click(screen.getByTestId("ai.revert-cancel"));
      expect(screen.queryByTestId("ai.revert-confirm")).toBeNull();
      expect(agentUndo).not.toHaveBeenCalled();
    });

    it("renders the icon only on the matching turn, not on an older run's turn", async () => {
      // Two settled runs with different ids and the host holding the FIRST. The
      // guard is `runId` equality, so the affordance must land on exactly one
      // turn. Without this fixture the guard is vacuous (the review's injection
      // removed it and every test stayed green).
      offerRun("r1");
      sendAgentTurn("first", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      sendAgentTurn("second", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r2" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getAllByTestId("ai.turn-revert")).toHaveLength(1));
      expect(screen.queryByTestId("ai.revert-fallback")).toBeNull();
      expect(agentLastRun).toHaveBeenCalled();
    });

    it("keeps the offer reachable when no turn hosts it", async () => {
      // A host record whose run is not in the open transcript: New chat, or a
      // switched conversation. The turn icon cannot render, so the header
      // fallback must, or the offer is live but unreachable.
      offerRun("r9");
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getByTestId("ai.revert-fallback")).toBeTruthy());
      expect(screen.queryByTestId("ai.turn-revert")).toBeNull();

      fireEvent.click(screen.getByTestId("ai.revert-fallback"));
      expect(screen.getByTestId("ai.revert-confirm")).toBeTruthy();
    });

    it("fails closed: a read that throws offers nothing", async () => {
      // Seed a live offer FIRST, so the assertion distinguishes a clearing
      // catch from an already-empty store (which passes vacuously, since
      // `beforeEach`'s `clearAgent` keeps `undoable`).
      setUndoable(
        { runId: "r1", restorePoints: [["n1", "s1"]], notesCreated: 0 },
        currentRunEpoch(),
      );
      agentLastRun.mockRejectedValue(new Error("locked"));
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
      expect(screen.queryByTestId("ai.turn-revert")).toBeNull();
      expect(screen.queryByTestId("ai.revert-fallback")).toBeNull();
    });

    it("re-reads rather than guessing when the undo itself fails", async () => {
      offerRun("r1");
      agentUndo.mockRejectedValue(new Error("noSuchRun"));
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());

      fireEvent.click(screen.getByTestId("ai.turn-revert"));
      fireEvent.click(screen.getByTestId("ai.revert-confirm-undo"));
      await waitFor(() => expect(agentUndo).toHaveBeenCalledWith("r1"));
      // The failure clears the report and re-reads the host: one read on mount,
      // at least one more after the failed undo.
      await waitFor(() => expect(agentLastRun.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(screen.queryByTestId("ai.undo-result")).toBeNull();
    });

    it("names the half an undo cannot do", async () => {
      offerRun("r1");
      agentUndo.mockResolvedValue({ reverted: 1, failed: [], notesCreatedNotReverted: 2 });
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, runId: "r1" });
      render(<AiChatTab />);
      await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
      fireEvent.click(screen.getByTestId("ai.turn-revert"));
      fireEvent.click(screen.getByTestId("ai.revert-confirm-undo"));
      await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
      // "The run was undone" otherwise reads as covering the notes it created.
      expect(screen.getByTestId("ai.undo-result").textContent).toContain(
        "agent.undo.createdNotReverted",
      );
    });
  });

  // myne-md/myne#568. In one mode a question is a run like any other and
  // `finish` is how it is answered, so the summary IS the reply. It used to
  // render only inside the review dialog, which is how a question about a note
  // got answered inside a "Review changes" screen.
  describe("the model's answer", () => {
    it("renders in the transcript", () => {
      sendAgentTurn("how many personal tasks are in this note", "This note");
      settleAgentTurn({
        ...SUMMARY,
        edits: 0,
        newNotes: 0,
        summary: "You have 16 personal tasks in this note.",
      });
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.agent-answer").textContent).toBe(
        "You have 16 personal tasks in this note.",
      );
    });

    it("suppresses the no-changes line when it answered", () => {
      // "The agent proposed no changes" is the right sentence for an edit
      // request that produced nothing, and exactly the wrong one under an
      // answer the user asked for: it reads as a failure report on a reply that
      // succeeded, which is what the user saw.
      sendAgentTurn("how many personal tasks are in this note", "This note");
      settleAgentTurn({
        ...SUMMARY,
        edits: 0,
        newNotes: 0,
        summary: "You have 16 personal tasks in this note.",
      });
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.agent-summary").textContent).not.toContain(
        "agent.review.noChanges",
      );
    });

    it("keeps the counts when the run BOTH answered and proposed", () => {
      // The two are not alternatives. A run can explain what it did and propose
      // the edits in the same breath, and dropping either half would be a
      // narrower surface than before the fix.
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, summary: "I tightened four headings." });
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.agent-answer").textContent).toBe(
        "I tightened four headings.",
      );
      expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
        "agentTurn.proposed:4",
      );
    });

    it("renders nothing at all when the run finished without one", () => {
      // Absence is a state rather than an empty paragraph: a run that proposed
      // edits and said nothing about them should not grow a blank line.
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn(SUMMARY);
      render(<AiChatTab />);
      expect(screen.queryByTestId("ai.agent-answer")).toBeNull();
    });

    // myne-md/myne#574. A run that stalls proposed nothing AND answered
    // nothing, so the no-changes line comes back and reports the less useful of
    // the two facts: it reads as a considered verdict on the note, when what
    // happened is that the run never did its work.
    it("says a stalled run gave no answer, rather than reporting no changes", () => {
      sendAgentTurn("how many personal tasks are in this note", "This note");
      settleAgentTurn({ ...SUMMARY, edits: 0, newNotes: 0, end: "stalled" });
      render(<AiChatTab />);
      const shown = screen.getByTestId("ai.agent-summary").textContent ?? "";
      expect(shown).toContain("agentTurn.noAnswer");
      expect(shown).not.toContain("agent.review.noChanges");
    });

    it("says the same for a run that ran out of steps", () => {
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({
        ...SUMMARY,
        edits: 0,
        newNotes: 0,
        end: "exhaustedIterations",
      });
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
        "agentTurn.noAnswer",
      );
    });

    it("keeps the no-changes line for a run that finished having decided so", () => {
      // The other direction, and the one that must not move: a `finished` run
      // with an empty proposal really did look and conclude there was nothing
      // to change. So did a `cancelled` one, by the user's own act.
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, edits: 0, newNotes: 0, end: "finished" });
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
        "agent.review.noChanges",
      );
    });

    it("shows the answer, not the no-answer line, when a stalled run still said something", () => {
      // A run can stall AFTER answering: the model replies and then goes round
      // in circles instead of finishing. The answer is still the answer.
      sendAgentTurn("how many personal tasks are in this note", "This note");
      settleAgentTurn({
        ...SUMMARY,
        edits: 0,
        newNotes: 0,
        end: "stalled",
        summary: "You have 16 personal tasks in this note.",
      });
      render(<AiChatTab />);
      expect(screen.getByTestId("ai.agent-answer").textContent).toBe(
        "You have 16 personal tasks in this note.",
      );
      const shown = screen.getByTestId("ai.agent-summary").textContent ?? "";
      expect(shown).not.toContain("agentTurn.noAnswer");
    });

    it("treats a whitespace-only summary as none", () => {
      // The model can close with a bare newline. Rendering that is an empty
      // bubble line, and worse, it would suppress the no-changes sentence on a
      // run that really did nothing.
      sendAgentTurn("tidy the headings", "Projects");
      settleAgentTurn({ ...SUMMARY, edits: 0, newNotes: 0, summary: "  \n " });
      render(<AiChatTab />);
      expect(screen.queryByTestId("ai.agent-answer")).toBeNull();
      expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
        "agent.review.noChanges",
      );
    });
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
    memoryUpdated: 0,}, currentRunEpoch());
  }

  it("renders the scope-expansion gate through the production mount path", async () => {
    // **This is the mount path nothing covered.** The gate used to render
    // inside the agent turn, i.e. inside the scrolling transcript at 92% of a
    // 280px sidebar; deleting its mount left the whole suite green.
    // `design-notes/ai/0515` makes this dialog the entire bound on
    // model-originated scope growth, so its reachability is the feature.
    parkOnScopeQuestion();
    render(<AiChatTab />);
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
    render(<AiChatTab />);
    await screen.findByTestId("agentScope.dialog");
    fireEvent.click(screen.getByTestId("ai.new-chat"));
    // Forgetting a run is not stopping one: the host keeps its run table, keeps
    // reading notes, and on a remote provider keeps spending the user's
    // requests. The strip that carried Stop is gone with the transcript.
    expect(agentCancel).toHaveBeenCalledWith("r1");
    expect(screen.queryByTestId("agentProgress.root")).toBeNull();
  });

});

describe("AiChatTab: the shape of a chat", () => {
  it("puts the composer last, under one scrolling transcript", () => {
    const token = sendChatMessage("hello");
    finalizeChatTurn(token);
    render(<AiChatTab />);

    const tab = screen.getByTestId("ai.chat-tab");
    const composer = screen.getByTestId("ai.composer");
    const transcript = screen.getByTestId("ai.transcript");

    // **The composer is the surface's LAST child** (myne-md/myne#771), which is
    // what keeps it under the reader's hands instead of somewhere down a page
    // that scrolls as a whole. The conversation body moved out of the tab into
    // the shared `ConversationSurface`, so the tab's own last child is that
    // surface; the invariant is unchanged and follows the composer's parent.
    const surface = composer.parentElement!;
    expect(surface.lastElementChild).toBe(composer);
    expect(tab.contains(surface)).toBe(true);

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
    finalizeChatTurn(token);
    render(<AiChatTab />);
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
    finalizeChatTurn(token);
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.new-chat")).toBeTruthy();
  });

  it("drops the transcript and the open run, but not the undo offer", () => {
    const token = sendChatMessage("hello");
    finalizeChatTurn(token);
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({
      runId: "r1",
      summary: "",
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

describe("ChatComposer: Send turns into Stop while a run works", () => {
  function startRunning(): void {
    beginRun();
    openRun(
      { runId: "r1", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
      currentRunEpoch(),
    );
  }

  it("swaps Send for Stop and stops host-side on click", () => {
    startRunning();
    render(<ChatComposer openNoteId="n1" folders={[]} />);
    expect(screen.queryByTestId("ai.composer-send")).toBeNull();
    const stop = screen.getByTestId("ai.composer-stop");
    fireEvent.click(stop);
    expect(agentCancel).toHaveBeenCalledWith("r1");
  });

  it("ignores Enter while running instead of sending a second run", () => {
    startRunning();
    render(<ChatComposer openNoteId="n1" folders={[]} />);
    agentStart.mockClear();
    fireEvent.change(screen.getByTestId("ai.composer-input"), {
      target: { value: "a second question" },
    });
    fireEvent.keyDown(screen.getByTestId("ai.composer-input"), { key: "Enter" });
    expect(agentStart).not.toHaveBeenCalled();
  });
});

describe("AiChatTab: the panel's exit to the deep surface", () => {
  // Task 10 of myne-md/myne#771. The panel is the shallow end — one
  // conversation, no list, no history chrome — and this control is the way out
  // of it into the agent tab, focused on the open note.
  //
  // It shipped wired and untested: `tsc` is content either way, the button
  // renders whether or not the callback is reachable, and the failure mode is
  // a control that does nothing. The panel is a sibling subtree of the
  // workspace controller, so "the callback is threaded" is the whole risk.

  it("offers the control only when the panel has somewhere to send you", () => {
    // The prop is optional, and absent is a real case: the panel is rendered in
    // tests and in surfaces with no workspace behind them. Offering an exit
    // that goes nowhere is worse than not offering one.
    render(<AiChatTab />);
    expect(screen.queryByTestId("ai.focus-agent")).toBeNull();
    cleanup();

    render(<AiChatTab onFocusAgent={() => {}} />);
    expect(screen.getByTestId("ai.focus-agent")).toBeTruthy();
  });

  it("calls back exactly once when pressed", () => {
    const onFocusAgent = vi.fn();
    render(<AiChatTab onFocusAgent={onFocusAgent} />);
    fireEvent.click(screen.getByTestId("ai.focus-agent"));
    expect(onFocusAgent).toHaveBeenCalledTimes(1);
  });

  it("is reachable and operable from the keyboard", () => {
    // It is an icon-only control in a row of icon-only controls, so it is
    // exactly the kind that ends up mouse-only by accident.
    const onFocusAgent = vi.fn();
    render(<AiChatTab onFocusAgent={onFocusAgent} />);
    const button = screen.getByTestId("ai.focus-agent") as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("names itself, since its glyph does not", () => {
    render(<AiChatTab onFocusAgent={() => {}} />);
    const button = screen.getByTestId("ai.focus-agent");
    expect(button.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
    expect(
      button.textContent?.trim(),
      "an icon-only control's name is its aria-label, not its contents",
    ).toBe("");
  });
});

describe("AiChatTab: telling the two speakers apart", () => {
  // A transcript at panel width is a column of near-identical blocks, and the
  // one distinction that matters — what YOU said against what a model said
  // about your notes — was the weakest signal on the surface: two adjacent
  // greys, distinguished further only by an alignment a long wrapped turn
  // erases, under a caption in `--text-xs`.
  //
  // Driven through the STORE, like every other transcript case in this file: a
  // turn is what is under test, not the path that produced one.

  function twoTurns(): HTMLElement[] {
    const token = sendChatMessage("what does tf:drive do");
    appendChatToken(token, "It is the **one-command orchestrator**.");
    finalizeChatTurn(token);
    render(<AiChatTab />);
    return screen.getAllByTestId("ai.turn");
  }

  it("gives the user's side the accent and the model's the paper", () => {
    const [user, assistant] = twoTurns();
    expect(user!.getAttribute("data-role")).toBe("user");
    expect(user!.style.background).toContain("var(--accent-soft)");
    expect(user!.style.border).toContain("var(--accent)");
    // The model's side stays neutral deliberately: the accent is the app's
    // emphasis colour, and lending it to model output would emphasise the one
    // thing this surface's own honesty note says may be wrong.
    expect(assistant!.style.background).not.toContain("var(--accent-soft)");
    expect(assistant!.style.background).toContain("var(--paper-2)");
  });

  it("puts a glyph beside each speaker's name, hidden from a reader", () => {
    // The word already names the speaker. A screen reader announcing "image,
    // robot, Assistant" is the same fact twice with a guess in the middle.
    const turns = twoTurns();
    for (const turn of turns) {
      const glyph = turn.querySelector("svg");
      expect(glyph, "the speaker has no glyph").not.toBeNull();
      expect(
        glyph!.closest("[aria-hidden='true']"),
        "the glyph is announced to a screen reader",
      ).not.toBeNull();
    }
  });

  it("renders the model's markdown and leaves the user's text alone", () => {
    // Only the model wrote markdown on purpose. Re-interpreting what the user
    // typed would mean a message containing `*` coming back italic.
    const [user, assistant] = twoTurns();
    expect(assistant!.querySelector("strong")?.textContent).toBe(
      "one-command orchestrator",
    );
    expect(user!.textContent).toContain("what does tf:drive do");
    expect(user!.querySelector("strong")).toBeNull();
  });
});

describe("AiChatTab: the honesty note costs a line, not a third of the panel", () => {
  // Load-bearing copy, pinned by full-literal equality. It is CLAMPED once
  // there is a conversation, never hidden: the text is in the DOM either way,
  // so it is present to a screen reader, to a text search and to the three
  // tests earlier in this file that assert its exact wording.

  it("is fully expanded while the transcript is empty", () => {
    // The moment the claim is being made. Clamping it here would be hiding it.
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.honesty-note").getAttribute("data-clamped")).toBeNull();
    expect(screen.queryByTestId("ai.honesty-toggle")).toBeNull();
  });

  it("clamps once there is a conversation, and offers the way back", () => {
    const token = sendChatMessage("hello");
    finalizeChatTurn(token);
    render(<AiChatTab />);

    expect(screen.getByTestId("ai.honesty-note").getAttribute("data-clamped")).toBe("true");
    const toggle = screen.getByTestId("ai.honesty-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByTestId("ai.honesty-note").getAttribute("data-clamped")).toBeNull();
    expect(screen.getByTestId("ai.honesty-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the whole sentence in the DOM while clamped", () => {
    // Clamped, not conditionally rendered. `-webkit-line-clamp` hides overflow
    // visually and changes nothing about what is there — which is what makes
    // reducing its height a layout decision rather than a copy one.
    const token = sendChatMessage("hello");
    finalizeChatTurn(token);
    render(<AiChatTab />);
    const note = screen.getByTestId("ai.honesty-note");
    expect(note.getAttribute("data-clamped")).toBe("true");
    expect(note.textContent).toBe(AI_CHAT_HONESTY_NOTE);
  });
});
