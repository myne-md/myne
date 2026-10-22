// @vitest-environment jsdom
//
// Component tests for `src/notes/components/AiChatTab.tsx` — the conversational
// chat surface (conversational-ai-chat tasks 6-13). Drives the real module-level
// `chatStore` and asserts the transcript, composer, citations, honesty note, and
// the folded-in summary-insert + tag-accept turn actions (tasks 10/11).
// `usePrefs` + i18n are mocked at their module boundaries (no Tauri IPC needed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// **Both hooks the mention wiring reads** (myne-md/myne#867), partial in the
// style the neighbouring mocks use so the module's other exports stay real:
// other components in this graph import them.
//
// A mention needs a note set and somewhere a press lands, and neither is
// mountable here: `useWorkspace` throws outside its provider, and
// `useResolverNotes` reads the sidebar cache. Both are the surface's inputs
// rather than its behaviour, so they are the two things worth stubbing.
const { openNewTabInFocused } = vi.hoisted(() => ({
  openNewTabInFocused: vi.fn(),
}));
vi.mock("../../src/notes/workspaceContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/workspaceContext")>()),
  useWorkspace: () => ({ openNewTabInFocused, openInFocused: vi.fn() }),
}));
/** The vault's note set, as `useResolverNotes` reports it. Mutable so a test can
 *  put a note in it without mounting a vault. */
let resolverNoteSet: ResolverNote[] = [];
vi.mock("../../src/notes/resolverNotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/resolverNotes")>()),
  useResolverNotes: () => resolverNoteSet,
}));

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
const clipboardWriteText = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardWriteText,
}));

vi.mock("../../src/lib/ai-chat", () => ({
  stopChat: (...a: unknown[]) => stopChat(...a),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // `provider` is interpolated so the notice popover's receiver line can be
    // asserted with the NAME in it (myne-md/myne#848). The stub echoes keys, so
    // without this a test could only see which branch rendered, never that the
    // provider reached the sentence.
    t: (key: string, opts?: { count?: number; provider?: string }) =>
      opts?.count !== undefined
        ? `${key}:${opts.count}`
        : opts?.provider !== undefined
          ? `${key}:${opts.provider}`
          : key,
  }),
}));

import { AI_CHAT_HONESTY_NOTE } from "../../src/lib/load-bearing-copy";
import type { ResolverNote } from "../../src/notes/resolveWikilink";
import { AiChatTab } from "../../src/notes/components/AiChatTab";
import { resetConversationBinding } from "../../src/notes/ai/conversationBinding";
import { CHIP_KEY } from "../../src/notes/ai/restingCause";
import type { ProviderErrorCause } from "../../src/lib/engine-error";

import { ChatComposer } from "../../src/notes/components/ChatComposer";
import {
  appendChatToken,
  failChatTurn,
  finalizeChatTurn,
  sendAgentTurn,
  sendChatMessage,
  setActiveConversationId,
  settleAgentTurn,
  __resetChatForTest,
} from "../../src/notes/ai/chatStore";
import {
  beginRun,
  clearAgent,
  currentRunEpoch,
  getAgent,
  markConversationUnread,
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
  __resetChatForTest();
  // The mention wiring's two inputs (myne-md/myne#867): no notes, and a fresh
  // spy, so a test that forgets to set them cannot pass on the previous one's
  // leftovers.
  resolverNoteSet = [];
  openNewTabInFocused.mockClear();
  clearAgent();
  // The conversation binding is MODULE state now (it has to outlive the tab), so
  // a test that pins would otherwise hand the pin to the next one.
  resetConversationBinding();
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

  // myne-md/myne#466. The chip names what the HOST says is serving rather than
  // what the user named, so a named provider that is not answering does not
  // render as ready.
  describe("what the header says about the backend", () => {
    it("names the provider the host resolved as serving", () => {
      aiProvider = "openrouter";
      backendClass = "remote";
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

    it("opens a note the answer names, in a new tab", () => {
      // myne-md/myne#867, the reported case. The mention renders as a link and
      // the press goes through the workspace's own new-tab call: neither the
      // renderer nor this surface navigates by itself, so "open in a new tab"
      // is decided in one place.
      resolverNoteSet = [
        {
          noteUuid: "n-pixel",
          title: "Pixel 10 Graphene OS",
          folder: "Personal/Things I have/",
        },
      ];
      const token = sendChatMessage("where did I note that?");
      appendChatToken(token, "Under Personal/Things I have/Pixel 10 Graphene OS.");
      finalizeChatTurn(token);
      render(<AiChatTab />);
      const link = screen.getByTestId("ai.mention-link");
      expect(link.textContent).toBe("Personal/Things I have/Pixel 10 Graphene OS");
      fireEvent.click(link);
      expect(openNewTabInFocused).toHaveBeenCalledWith("n-pixel");
    });

    it("leaves a name the vault does not hold as plain text", () => {
      // The other half of the same claim: with no note set there is nothing to
      // link, and the sentence renders exactly as it did before the change.
      const token = sendChatMessage("q");
      appendChatToken(token, "Under Personal/Things I have/Pixel 10 Graphene OS.");
      finalizeChatTurn(token);
      render(<AiChatTab />);
      expect(screen.queryByTestId("ai.mention-link")).toBeNull();
      // The sentence is still there, whole, as prose. `getAllByTestId`: every
      // turn carries the same testid, which is what the surface's own scenarios
      // reach for.
      const rendered = screen
        .getAllByTestId("ai.turn-text")
        .map((el) => el.textContent ?? "");
      expect(
        rendered.some((text) =>
          text.includes("Personal/Things I have/Pixel 10 Graphene OS"),
        ),
      ).toBe(true);
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
describe("AiChatTab: a turn's words can be copied (myne-md/myne#848)", () => {
  beforeEach(() => {
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
  });

  /** This describe's own summary: the outer one is scoped to its parent
   *  `describe`, and reaching for it was a `ReferenceError` rather than a
   *  failing assertion. */
  const RUN = {
    runId: "r1",
    summary: "",
    edits: 0,
    newNotes: 0,
    notesRead: 6,
    iterations: 3,
    charsOffDevice: null,
    end: "finished" as const,
  };

  it("copies the answer, and not the bubble around it", async () => {
    // The transcript is the one place the text IS the point, and the only route
    // out was selecting the bubble by hand, which drags in the speaker caption,
    // the footprint's figures and the markdown's rendered punctuation.
    sendAgentTurn("how many personal tasks", "This note");
    settleAgentTurn({
      ...RUN,
      edits: 0,
      newNotes: 0,
      summary: "You have 16 personal tasks in this note.",
    });
    render(<AiChatTab />);
    // Scoped to the ASSISTANT turn: the run also renders the task as the user's
    // own turn, which has its own copy.
    const assistant = await screen.findByTestId("ai.agent-answer");
    const copy = within(
      assistant.closest('[data-testid="ai.turn"]') as HTMLElement,
    ).getByTestId("ai.turn-copy");
    // The name says WHAT is copied, so the control is not a bare glyph.
    expect(copy.getAttribute("aria-label")).toBe(
      "editor.chrome.rightPanel.aiChat.copyAnswer",
    );
    fireEvent.click(copy);
    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith(
        "You have 16 personal tasks in this note.",
      ),
    );
  });

  it("copies what the user typed, on their own turn", async () => {
    const token = sendChatMessage("what did I note about rust?");
    appendChatToken(token, "you wrote…");
    finalizeChatTurn(token);
    render(<AiChatTab />);
    const userTurn = screen.getAllByTestId("ai.turn")[0]!;
    const copy = within(userTurn).getByTestId("ai.turn-copy");
    expect(copy.getAttribute("aria-label")).toBe(
      "editor.chrome.rightPanel.aiChat.copyYourMessage",
    );
    fireEvent.click(copy);
    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith("what did I note about rust?"),
    );
  });

  it("says which way it went, on the control, and then goes back", async () => {
    // `lib/clipboard.ts` exists so a copy names its OUTCOME, and neither arm
    // renders the value. Both directions are driven: a failed copy that looks
    // like a successful one is the exact defect that module was created for.
    sendAgentTurn("tidy the headings", "This note");
    settleAgentTurn({ ...RUN, summary: "Done." });
    render(<AiChatTab />);
    const answer = await screen.findByTestId("ai.agent-answer");
    const turn = answer.closest('[data-testid="ai.turn"]') as HTMLElement;
    fireEvent.click(within(turn).getByTestId("ai.turn-copy"));
    await waitFor(() =>
      expect(within(turn).getByTestId("ai.turn-copy").getAttribute("aria-label")).toBe(
        "editor.chrome.rightPanel.aiChat.copied",
      ),
    );

    clipboardWriteText.mockRejectedValueOnce(new Error("no clipboard"));
    fireEvent.click(within(turn).getByTestId("ai.turn-copy"));
    await waitFor(() =>
      expect(within(turn).getByTestId("ai.turn-copy").getAttribute("aria-label")).toBe(
        "editor.chrome.rightPanel.aiChat.copyFailed",
      ),
    );
  });

  it("offers nothing to copy while an answer is still arriving", async () => {
    const token = sendChatMessage("q");
    appendChatToken(token, "half an ans");
    render(<AiChatTab />);
    // Half an answer is a copy the user would have to notice was half an answer.
    // Scoped to the ASSISTANT turn: the user's own message is complete the
    // moment they sent it, and its copy is still offered.
    const assistant = screen
      .getAllByTestId("ai.turn")
      .find((el) => el.getAttribute("data-role") === "assistant")!;
    expect(within(assistant).queryByTestId("ai.turn-copy")).toBeNull();
  });

  it("offers nothing for a run that said nothing", async () => {
    sendAgentTurn("tidy the headings", "This note");
    // Edits but no words: a control that copies an empty string is worse than
    // no control.
    settleAgentTurn({
      ...RUN,
      edits: 2,
      newNotes: 0,
      summary: "",
      proposal: {
        edits: [{ noteId: "n1", anchor: "old words", replacement: "new words" }],
        newNotes: [],
      },
    });
    render(<AiChatTab />);
    const diff = await screen.findByTestId("ai.turn-diff");
    const turn = diff.closest('[data-testid="ai.turn"]') as HTMLElement;
    expect(within(turn).queryByTestId("ai.turn-copy")).toBeNull();
  });
});

describe("AiChatTab: a finished run is read by being on screen", () => {
  // **The other half of the rail's unread mark** (myne-md/myne#848). The settle
  // writes the mark for every conversation; what clears it is a surface
  // DISPLAYING the conversation, which is a fact only the surface has, an id
  // comparison in the settle got the closed-surface case wrong.
  it("clears the mark for the conversation it is showing", async () => {
    setActiveConversationId("c1");
    markConversationUnread("c1");
    expect(getAgent().unreadConversations).toContain("c1");
    render(<AiChatTab />);
    await waitFor(() => expect(getAgent().unreadConversations).not.toContain("c1"));
  });

  it("leaves another conversation's mark alone", async () => {
    // A mark that vanished because the user read something else is a mark that
    // lied about what they had seen.
    setActiveConversationId("c1");
    markConversationUnread("c2");
    render(<AiChatTab />);
    await waitFor(() => expect(screen.getByTestId("ai.chat-tab")).toBeTruthy());
    expect(getAgent().unreadConversations).toContain("c2");
  });
});

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

  it("names a missing model as a missing model, not as a missing provider", () => {
    // `NoModel` is the cause the report emits when the local arm is active with
    // no file, and the cause `remote_refusal` reports when a provider is named
    // with no model chosen. It was absent from the taxonomy, so it fell into the
    // surface's four-arm bucket and rendered "No provider" on a vault whose
    // provider was named (myne-md/myne#867).
    surfaceState = { kind: "unavailable", cause: "no_model" };
    render(<AiChatTab />);
    expectsFault(
      "editor.chrome.rightPanel.aiChat.statusNoModelChosen",
      "settings.ai.providerError.noModel",
    );
    expect(chip().getAttribute("data-ai-cause")).toBe("no_model");
    // The cause rides on the SAME element as the testid: `e2e/ai-degradation`
    // reads both off one node, and splitting them would make that scenario
    // silently read `null` rather than fail.
    expect(body().getAttribute("data-ai-cause")).toBe("no_model");
  });

  it("names consent the user has not given, instead of saying no provider", () => {
    // **The reported defect.** A provider named, a model chosen, consent not yet
    // recorded from this device: the header said "No provider" about a vault
    // whose provider was named, and named an action the user had already taken.
    surfaceState = { kind: "unavailable", cause: "consent_missing" };
    render(<AiChatTab />);
    expectsFault(
      "editor.chrome.rightPanel.aiChat.statusConsentMissing",
      "settings.ai.providerError.consentMissing",
    );
    expect(chip().getAttribute("data-ai-cause")).toBe("consent_missing");
  });

  it("tells a missing key from a rejected one", () => {
    // Two causes, two fixes, and the transcript showed one sentence for both
    // until myne-md/myne#466. Asserted here rather than through `expectsFault`,
    // which requires the sentence to quote the chip's label, and "Key rejected"
    // is not a phrase the provider's own sentence uses.
    for (const [cause, label, sentence] of [
      ["no_credential", "statusNoCredential", "noCredential"],
      ["unauthorized", "statusKeyRejected", "unauthorized"],
    ] as const) {
      surfaceState = { kind: "unavailable", cause };
      const { unmount } = render(<AiChatTab />);
      expect(chip().getAttribute("data-ai-cause")).toBe(cause);
      expect(chip().textContent).toBe(
        `editor.chrome.rightPanel.aiChat.${label}`,
      );
      expect(body().textContent).toContain(`settings.ai.providerError.${sentence}`);
      unmount();
    }
  });

  it("says not answering when the configured backend is unreachable", () => {
    surfaceState = { kind: "unavailable", cause: "unreachable" };
    render(<AiChatTab />);
    expectsFault(
      "editor.chrome.rightPanel.aiChat.statusUnreachable",
      "settings.ai.providerError.unreachable",
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
      { kind: "unavailable", cause: "consent_missing" },
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

  it("reports the host's own cause for EVERY cause, rather than a bucket", () => {
    // The property the bucket broke, asserted over the whole set rather than
    // over a handful of examples, because the failure mode was a DEFAULT arm:
    // any cause the four buckets did not name rendered "No provider".
    // `CHIP_KEY` is a total `Record` over the union, so its keys ARE the set.
    for (const cause of Object.keys(CHIP_KEY) as ProviderErrorCause[]) {
      surfaceState = { kind: "unavailable", cause };
      const { unmount } = render(<AiChatTab />);
      expect(chip().getAttribute("data-ai-cause")).toBe(cause);
      expect(chip().textContent).toBe(CHIP_KEY[cause]);
      unmount();
    }
  });

  it("shares one label across the causes that are one fact, and keeps their ids", () => {
    // Three transport failures are one thing to a reader, so they share the
    // label. Their IDS stay distinct, because a scenario that cannot tell them
    // apart cannot assert which one it faulted.
    for (const cause of ["timeout", "refused", "unreachable"]) {
      surfaceState = { kind: "unavailable", cause };
      const { unmount } = render(<AiChatTab />);
      expect(chip().getAttribute("data-ai-cause")).toBe(cause);
      expect(chip().textContent).toBe(
        "editor.chrome.rightPanel.aiChat.statusUnreachable",
      );
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

    // The three figures the review screen reports, one click away
    // (myne-md/myne#848). The third is the one the remote arm's compensating
    // control rests on (design-notes/ai/0515), so "the run stayed local" must
    // not render as a zero character count, and it must still be REACHABLE,
    // which is why this expands rather than looking for it on the line.
    fireEvent.click(screen.getByTestId("agentFootprint.disclosure"));
    const cost = screen.getByTestId("agentFootprint.runCost").textContent ?? "";
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
    fireEvent.click(screen.getByTestId("agentFootprint.disclosure"));
    expect(screen.getByTestId("agentFootprint.runCost").textContent).toContain(
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
  it("opens a settled run's frozen proposal inline, under its own turn", () => {
    sendAgentTurn("tidy the headings", "Projects");
    settleAgentTurn({
      ...SUMMARY,
      proposal: {
        edits: [{ noteId: "n1", anchor: "old words", replacement: "new words" }],
        newNotes: [{ title: "Scratch", body: "fresh text", folder: null }],
      },
    });
    render(<AiChatTab />);

    // Collapsed at rest: a settled proposal is a record, not a decision.
    expect(screen.queryByTestId("ai.proposal-diff-body")).toBeNull();
    const trigger = screen.getByTestId("ai.turn-diff");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const body = screen.getByTestId("ai.proposal-diff-body");
    expect(body.textContent).toContain("old words");
    expect(body.textContent).toContain("new words");
    expect(body.textContent).toContain("Scratch");
    expect(body.textContent).toContain("fresh text");
    expect(
      screen
        .getAllByTestId("ai.proposal-edit")[0]!
        .getAttribute("data-note-id"),
    ).toBe("n1");
    // **Inline, under the turn that proposed it** (myne-md/myne#913): the whole
    // point of the change is that it is not painted somewhere else.
    expect(body.closest('[data-testid="ai.turn"]')).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Read-only in the strong sense: nothing in the body writes. `ai.insert-turn`
    // alone would pass even if a write control were added.
    expect(body.querySelectorAll("button").length).toBe(0);
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
    // The end label is the line's own status now rather than a third caption
    // under the run: one line says how it ended, and the numbers are behind the
    // disclosure (myne-md/myne#848).
    expect(screen.getByTestId("agentFootprint.status").textContent).toContain(
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
    beginRun(null);
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
    // **The run's own entry IS in the transcript** (myne-md/myne#848), and that
    // is the point of the change: the running scope total is one of the four
    // bounds threat-model.md §7 names, and it now lives on the turn the run
    // belongs to, where scrolling back to it actually finds it. The DIALOG
    // above stays out of the scroller, which is the assertion that did not move.
    expect(scroller.contains(screen.getByTestId("agentFootprint"))).toBe(true);
  });

  it("reports the APPROVED leg's own failure, not a scope refusal", async () => {
    // **The defect the user hit** (myne-md/myne#848): every failure of the
    // approved leg was reported as "The scope could not be widened", so a user
    // who had just pressed Allow was told their permission had not been taken,
    // while `modelGrants` on the same turn showed it had, and the real cause
    // was thrown away. Three tags are driven here, because the mapping is the
    // whole fix and one arm would pass on any of them.
    parkOnScopeQuestion();
    render(<AiChatTab />);
    await screen.findByTestId("agentScope.dialog");

    agentApproveScope.mockRejectedValueOnce({ kind: "ProviderRejected" });
    fireEvent.click(screen.getByTestId("agentScope.approve"));
    await waitFor(() =>
      expect(screen.getByTestId("agentFootprint").textContent).toContain(
        "agent.composer.providerRejected",
      ),
    );
    expect(screen.getByTestId("agentFootprint").textContent).not.toContain(
      "agent.progress.expandFailed",
    );
  });

  it("keeps the scope sentence for the ONE tag it is about", async () => {
    // `RootGrant` is a folder grant that canonises to the vault root: the
    // approval really cannot be honoured, and this is the sentence that says so.
    parkOnScopeQuestion();
    render(<AiChatTab />);
    await screen.findByTestId("agentScope.dialog");
    agentApproveScope.mockRejectedValueOnce({ kind: "RootGrant" });
    fireEvent.click(screen.getByTestId("agentScope.approve"));
    await waitFor(() =>
      expect(screen.getByTestId("agentFootprint").textContent).toContain(
        "agent.progress.expandFailed",
      ),
    );
  });

  it("says the run stopped for a tag it cannot name", async () => {
    parkOnScopeQuestion();
    render(<AiChatTab />);
    await screen.findByTestId("agentScope.dialog");
    agentApproveScope.mockRejectedValueOnce({ kind: "ProviderFailed" });
    fireEvent.click(screen.getByTestId("agentScope.approve"));
    await waitFor(() =>
      expect(screen.getByTestId("agentFootprint").textContent).toContain(
        "agent.progress.legFailed",
      ),
    );
  });

  it("New chat stops the run host-side before forgetting it", async () => {
    parkOnScopeQuestion();
    render(<AiChatTab />);
    await screen.findByTestId("agentScope.dialog");
    fireEvent.click(screen.getByTestId("ai.new-chat"));
    // Forgetting a run is not stopping one: the host keeps its run table, keeps
    // reading notes, and on a remote provider keeps spending the user's
    // requests. The turn that carried the run's entry is gone with the
    // transcript, which was the defect the strip's independence from the
    // transcript used to hide (myne-md/myne#848).
    expect(agentCancel).toHaveBeenCalledWith("r1");
    expect(screen.queryByTestId("agentFootprint")).toBeNull();
  });

});

describe("AiChatTab: the transcript's scrollbar (myne-md/myne#848)", () => {
  it("hides the native bar, which paints over the messages", () => {
    // **The user's read**: the bar landed on the chat messages and was annoying
    // to look at. Two causes, one fix. The native bar is an OVERLAY on macOS, so
    // it paints over whatever is under it; and its thumb cannot resolve this
    // panel's tokens at all, a `var()` inside `::-webkit-scrollbar-thumb` takes
    // the ROOT's value, which in this app is the LIGHT theme's, so the
    // transcript drew a pale bar down a dark surface (myne-md/myne#727, which
    // this region never got). `ScrollArea` hides the native bar and draws a
    // themed element instead, inset from the edge and visible only while the
    // reader is scrolling.
    sendAgentTurn("tidy the headings", "This note");
    settleAgentTurn({
      runId: "r1",
      summary: "done",
      edits: 0,
      newNotes: 0,
      notesRead: 1,
      iterations: 1,
      charsOffDevice: null,
      end: "finished",
    });
    render(<AiChatTab />);
    const turns = screen.getByTestId("ai.transcript");
    const scroller = turns.parentElement as HTMLElement;
    // The class is what hides the native bar (`scrollbar-width: none` + a zero
    // `::-webkit-scrollbar`), so its absence is the defect coming back.
    expect(scroller.className).toContain("myne-scrollarea");
    // And the region is still the one that scrolls: the turns live inside it.
    expect(scroller.contains(turns)).toBe(true);
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
    beginRun(null);
    openRun(
      { runId: "r1", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
      currentRunEpoch(),
    );
  }

  it("swaps Send for Stop and stops host-side on click", () => {
    startRunning();
    render(<ChatComposer surface="agent" openNoteId="n1" folders={[]} />);
    expect(screen.queryByTestId("ai.composer-send")).toBeNull();
    const stop = screen.getByTestId("ai.composer-stop");
    fireEvent.click(stop);
    expect(agentCancel).toHaveBeenCalledWith("r1");
  });

  it("ignores Enter while running instead of sending a second run", () => {
    startRunning();
    render(<ChatComposer surface="agent" openNoteId="n1" folders={[]} />);
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

describe("AiChatTab: the status chip leads somewhere", () => {
  // It was a `<span>` — a passive label naming a fault with no route out of it.
  // The degraded chip is a button whose tooltip is the taxonomy's own sentence
  // and whose press lands on the control that clears it. `check-i18n.mjs` cannot
  // see a key that is never rendered; it verifies a USED key exists, not that an
  // existing key is used.

  it("is a button with the hint, when the fault has a fix", () => {
    surfaceState = { kind: "absent" };
    const onOpenSettings = vi.fn();
    render(<AiChatTab onOpenSettings={onOpenSettings} />);
    const chip = screen.getByTestId("ai.chrome-status");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("data-actionable")).toBe("true");
  });

  it("lands ON the control that clears it, not at the top of a panel", () => {
    // The AI panel is a dozen blocks tall. Opening it and leaving the user to
    // find the models block is the failure a deep link exists to prevent, and
    // the machinery was already here with one caller.
    surfaceState = { kind: "absent" };
    const onOpenSettings = vi.fn();
    render(<AiChatTab onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId("ai.chrome-status"));
    expect(onOpenSettings).toHaveBeenCalledWith("ai", "ai.models");
  });

  it("stays a plain label when the chip is a statement", () => {
    // A healthy chip names the provider that is answering. A statement with a
    // click target invites a press that would do nothing useful.
    surfaceState = { kind: "available" };
    render(<AiChatTab onOpenSettings={vi.fn()} />);
    const chip = screen.getByTestId("ai.chrome-status");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("data-actionable")).toBeNull();
  });

  it("stays a plain label when nothing can open Settings", () => {
    // Rendered in isolation, and in any surface with no settings shell behind
    // it. A button that goes nowhere is worse than a label.
    surfaceState = { kind: "absent" };
    render(<AiChatTab />);
    expect(screen.getByTestId("ai.chrome-status").tagName).toBe("SPAN");
  });

  it("does not offer a fix for a state the user chose", () => {
    // AI switched off is a deliberate choice, and a chip offering to undo one
    // is nagging. Same for a build compiled without local AI: no setting
    // changes it, so a control going somewhere would change nothing.
    aiEnabled = false;
    render(<AiChatTab onOpenSettings={vi.fn()} />);
    expect(screen.getByTestId("ai.chrome-status").tagName).toBe("SPAN");
  });
});

describe("AiChatTab: the provider notice explains itself (myne-md/myne#848)", () => {
  // The notice is one threat-model-bounded sentence about where the user's words
  // go, and it invites three follow-ups it could not answer: which provider,
  // what exactly leaves, and how to stop it. This is that conversation, one
  // click away, with the fourth answer being a LINK to the control rather than a
  // second copy of the setting.

  it("answers all four questions, naming the provider that is answering", async () => {
    aiProvider = "openrouter";
    backendClass = "remote";
    surfaceState = { kind: "available" };
    render(<AiChatTab onOpenSettings={vi.fn()} />);

    // Closed until asked: the notice is the claim, this is the disclosure.
    expect(screen.queryByTestId("ai.provider-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.honesty-note"));
    const popover = await screen.findByTestId("ai.provider-popover");
    // What leaves, and to whom.
    expect(popover.textContent).toContain("noticeLeaves");
    expect(screen.getByTestId("ai.notice-receives").textContent).toContain(
      "noticeReceiver:OpenRouter",
    );
    // How to stop it.
    expect(popover.textContent).toContain("noticeRevoke");
  });

  it("says nothing leaves the machine when the local arm is answering", async () => {
    backendClass = "in_process_local";
    surfaceState = { kind: "available" };
    render(<AiChatTab onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByTestId("ai.honesty-note"));
    // The other branch, and the one a wrong implementation would get by reusing
    // the remote sentence: naming a provider nobody is using is the exact defect
    // `activeProviderName` exists to prevent (myne-md/myne#466).
    expect(screen.getByTestId("ai.notice-receives").textContent).toContain(
      "noticeReceiverLocal",
    );
  });

  it("sends the user to the control, not to the top of the panel", async () => {
    const onOpenSettings = vi.fn();
    backendClass = "in_process_local";
    surfaceState = { kind: "available" };
    render(<AiChatTab onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId("ai.honesty-note"));
    fireEvent.click(screen.getByTestId("ai.notice-settings"));
    expect(onOpenSettings).toHaveBeenCalledWith("ai", "ai.provider");
  });

  it("keeps the load-bearing sentence VERBATIM inside the button", async () => {
    // The notice became a `<button>`; its text is a privacy property pinned by
    // literal equality and rendered verbatim in every locale, so the change of
    // element must not have changed a character of it.
    backendClass = "in_process_local";
    surfaceState = { kind: "available" };
    render(<AiChatTab onOpenSettings={vi.fn()} />);
    expect(screen.getByTestId("ai.honesty-note").textContent).toBe(AI_CHAT_HONESTY_NOTE);
  });
});

// ── The scope card and note-bound conversations (myne-md/myne#913) ──────────
//
// Two behaviours the issue names, each with the failure it prevents. Both are
// asserted on what the surface SAYS or DOES rather than on an internal flag:
// the card's failure was that a user could not read it, and the conversation
// binding's failure was that the transcript beside a note was about a different
// note.
describe("AiChatTab: scope card and note binding", () => {
  it("states the scope's question and what the choice never covers", async () => {
    render(<AiChatTab folders={["Work", "Journal"]} />);
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const menu = await screen.findByTestId("ai.composer-scope-menu");

    // The three answers the old menu did not give: what the choice is about,
    // that the folders are a section of their own, and what it applies to.
    expect(
      within(menu).getByTestId("ai.composer-scope-heading").textContent,
    ).toBe("agent.composer.scopeQuestion");
    expect(
      within(menu).getByTestId("ai.composer-scope-footer").textContent,
    ).toBe("agent.composer.scopeApplies");
    expect(
      within(menu).getAllByTestId("ai.composer-scope-group")[0]?.textContent,
    ).toBe("agent.composer.scopeFolders");

    // Exactly ONE option reads as the current one. A menu where every row looks
    // alike makes the user re-read the trigger to find out where they are.
    expect(
      menu.querySelectorAll(
        '[data-testid="ai.composer-scope-option"][data-active="true"]',
      ).length,
    ).toBe(1);
  });

  it("starts a fresh conversation when the open note changes", () => {
    sendAgentTurn("what is in this note", "This note");
    const { rerender } = render(<AiChatTab openNoteId="note-a" />);
    expect(screen.queryAllByTestId("ai.turn").length).toBeGreaterThan(0);

    rerender(<AiChatTab openNoteId="note-b" />);

    // The previous note's transcript is gone: the panel is about note-b now.
    expect(screen.queryAllByTestId("ai.turn").length).toBe(0);
  });

  it("keeps the conversation when the user has pinned it, and says so", () => {
    sendAgentTurn("what is in this note", "This note");
    const { rerender } = render(<AiChatTab openNoteId="note-a" />);

    fireEvent.click(screen.getByTestId("ai.keep-conversation"));
    expect(screen.getByTestId("ai.keep-conversation-mark")).toBeTruthy();
    expect(
      screen
        .getByTestId("ai.keep-conversation")
        .getAttribute("aria-pressed"),
    ).toBe("true");

    rerender(<AiChatTab openNoteId="note-b" />);

    // Pinned: the escape hatch the issue asks for. The transcript survives the
    // switch for the session, which is what driving one conversation across two
    // notes requires.
    expect(screen.queryAllByTestId("ai.turn").length).toBeGreaterThan(0);
  });

  it("starts fresh when a note is CLOSED and another opened", () => {
    // Closing A and opening B is a switch between two notes, and the first
    // version read it as a first mount because it compared against the last note
    // the panel SAW, which the close had already set to nothing. The transcript
    // for A then sat beside B.
    sendAgentTurn("what is in this note", "This note");
    const { rerender } = render(<AiChatTab openNoteId="note-a" />);
    expect(screen.queryAllByTestId("ai.turn").length).toBeGreaterThan(0);

    rerender(<AiChatTab openNoteId={null} />);
    rerender(<AiChatTab openNoteId="note-b" />);

    expect(screen.queryAllByTestId("ai.turn").length).toBe(0);
  });

  it("keeps the pin across a tab switch, because the tab unmounts", () => {
    // The pin was `useState`, and the right panel mounts this component only
    // while its tab is the AI one: switching tabs reset the pin silently, so the
    // very next note switch cleared a conversation the user had pinned.
    sendAgentTurn("what is in this note", "This note");
    const first = render(<AiChatTab openNoteId="note-a" />);
    fireEvent.click(screen.getByTestId("ai.keep-conversation"));
    first.unmount();

    const second = render(<AiChatTab openNoteId="note-a" />);
    expect(
      screen.getByTestId("ai.keep-conversation").getAttribute("aria-pressed"),
    ).toBe("true");

    second.rerender(<AiChatTab openNoteId="note-b" />);
    expect(screen.queryAllByTestId("ai.turn").length).toBeGreaterThan(0);
  });
});

describe("AiChatTab: a sent message carries its files (myne-md/myne#913)", () => {
  it("draws the files the message sent, and names them", () => {
    // The composer's chips used to be the only record of what was attached, and
    // they were cleared on send. The turn keeps them, so a question read back
    // later still says what it was about and the file is one click away.
    sendAgentTurn("what is in this picture", "This note", [
      { id: "aa11bb22", name: "screenshot.png", contentType: "image/png" },
    ]);
    render(<AiChatTab />);
    const chip = screen.getByTestId("ai.turn-attachment");
    expect(chip.getAttribute("data-attachment-id")).toBe("aa11bb22");
    expect(chip.textContent).toContain("screenshot.png");
  });
});
