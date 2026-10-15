// @vitest-environment jsdom
//
// The mobile AI destination (myne-md/myne#456, myne-md/myne#457).
//
// **What is under test is the cost disclosure and the run lifecycle**, not the
// layout. `docs/decisions/ai/0515` rests the remote arm's lack of a volume
// bound on the run reporting what it cost, and `agentStart` returns only when
// the loop has STOPPED, so a surface that renders the figures from the reply
// alone discloses nothing at all for a run that is cancelled or that dies with
// the foreground. On a phone that is the ordinary case, not the exotic one.
//
// The store is shared verbatim with desktop (`@myne/agent-store`), so nothing
// here re-tests its arithmetic. What is asserted is that this surface drives it
// in the right ORDER and reads back what it wrote.

import i18n from "@myne/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { clearAgent, clearAgentForLock, currentRunEpoch, getAgent, setUndoable } from "@myne/agent-store";
import { buildMentionTargets } from "@myne/note-mentions";
import type { AgentRunView, RunProgress } from "@myne/agent-protocol";
// The COMPLETE binding mock, from one place. A per-file mock breaks whenever a
// different task wires a new call into a surface this file mounts, and the spec
// that then fails is never the one whose subject changed.
import {
  agentCancel,
  agentCapability,
  agentLastRun,
  agentPreviewGrant,
  agentRunModule,
  agentStart,
  agentUndo,
  resetAgentRunMock,
} from "../helpers/agentRunMock";

vi.mock("../../src/lib/agent-run", () => agentRunModule());

const {
  mockChatsList,
  mockChatsRead,
  mockChatsCreate,
  mockChatsAppendTurn,
} = vi.hoisted(() => ({
  mockChatsList: vi.fn(),
  mockChatsRead: vi.fn(),
  mockChatsCreate: vi.fn(),
  mockChatsAppendTurn: vi.fn(),
}));

vi.mock("../../src/lib/chats", () => ({
  chatsList: mockChatsList,
  chatsRead: mockChatsRead,
  chatsCreate: mockChatsCreate,
  chatsAppendTurn: mockChatsAppendTurn,
}));

// The scope strip reads the provider to decide whether it may say the notes
// leave the device. Stubbed so this file's subject stays the cost disclosure;
// the strip's own claims are asserted in `AiScopeSheet.test.tsx`.
vi.mock("../../src/lib/use-prefs", () => ({
  usePrefs: () => ({ prefs: { ai_provider: "openrouter" } }),
}));

const { AiChatFlow } = await import("../../src/app/flows/AiChatFlow");
const { __resetChatHistoryForTest } = await import("../../src/lib/chatHistory");

const VIEW: AgentRunView = { runId: "run-1", scopeTotal: 3 };

/** A settled step with nothing proposed and the given answer. */
function finished(summary: string, cost: Partial<RunProgress> = {}) {
  return {
    view: VIEW,
    proposal: { edits: [], newNotes: [], summary },
    end: { kind: "finished" as const },
    iterations: cost.iterations ?? 0,
    notesRead: cost.notesRead ?? 0,
    charsOffDevice: cost.chars_off_device ?? null,
    excludedCount: 0,
  };
}

beforeEach(() => {
  resetAgentRunMock();
  // The store is MODULE SCOPE and outlives every unmount, which is the property
  // that makes the lock teardown necessary rather than optional. Here it means
  // one test's run would otherwise be the next test's opening state.
  clearAgent();
  // **And `clearAgent` deliberately KEEPS the probe verdict**, because a new run
  // is not a backend change and re-probing would spend the provider's requests
  // again for every message. Only a vault-leaving event drops it. Without this
  // line the first spec to send would answer the gate for every spec after it,
  // and the three that assert a refusal would find a passing verdict already in
  // the store and never probe at all. That is exactly how it failed once.
  clearAgentForLock();
  // The transcript write-dedup is module state too: without the reset, one
  // test's persisted payload is the next test's "already written".
  __resetChatHistoryForTest();
  // No conversations by default: continue-last and persistence specs opt in.
  // Without this the mount effect's chatsList rejects (no Tauri in jsdom)
  // and every mount renders the history-error paragraph.
  mockChatsList.mockReset().mockResolvedValue([]);
  mockChatsRead.mockReset().mockRejectedValue(new Error("no conversation"));
  mockChatsCreate.mockReset().mockResolvedValue("c0ffee".padEnd(32, "0"));
  mockChatsAppendTurn.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount(over: Partial<React.ComponentProps<typeof AiChatFlow>> = {}) {
  render(<AiChatFlow grant={{ kind: "folder", value: "" }} {...over} />);
}

function type(text: string) {
  fireEvent.change(screen.getByTestId("ai.composer-input"), { target: { value: text } });
}

describe("AiChatFlow", () => {
  it("has one composer and one mode, with no Ask/Edit control", () => {
    mount();

    // `docs/decisions/ai/0524` collapsed the two modes into one, so a mode
    // switch here would offer a choice the host does not have. Asserted as an
    // ABSENCE, which is the only way to pin "we did not add one back".
    expect(screen.getByTestId("ai.composer-input")).toBeTruthy();
    expect(screen.queryByTestId("ai.composer-mode")).toBeNull();
    expect(screen.queryByTestId("ai.composer-ask")).toBeNull();
  });

  it("answers a question from the run's summary, without proposing an edit", async () => {
    agentStart.mockResolvedValue(finished("Three of them mention the migration."));
    mount();
    type("which notes mention the migration?");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.agent-answer")).toBeTruthy());
    expect(screen.getByTestId("ai.agent-answer").textContent).toBe(
      "Three of them mention the migration.",
    );
    // The task went to the host as the task, and the grant went as the grant.
    // Nothing else: scope arithmetic and the excluded-folder clamp are decided
    // host-side and none of them is sent from the WebView.
    expect(agentStart).toHaveBeenCalledWith(
      "which notes mention the migration?",
      { kind: "folder", value: "" },
      // The interface language and the chat-history seed, which develop's
      // myne-md/myne#618 and #617 made REQUIRED arguments. Asserted rather
      // than skipped: the whole point of checking the whole call is that a new
      // argument cannot be added without someone deciding it should be. Empty
      // here because no conversation is open; the seeding spec below pins the
      // non-empty case.
      "en",
      [],
      // The offered settings, which myne-md/myne#850 made a REQUIRED argument
      // for the same reason: an empty list is this client's honest answer, and
      // the assertion is what makes a future argument a decision.
      [],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("links a note the answer names, and opens it on press (myne-md/myne#867)", async () => {
    // The defect: a model that answered "it is under Personal/Things I have/
    // Pixel 10 Graphene OS" left that name as flat text, so the one thing the
    // reader wanted next, the note, was as pressable as any other word. The
    // matcher is shared with desktop and tested there; what this pins is the
    // WIRING, because a shared matcher that no surface calls is a feature that
    // ships inert.
    const onOpenNote = vi.fn();
    agentStart.mockResolvedValue(
      finished("It is under Personal/Things I have/Pixel 10 Graphene OS."),
    );
    mount({
      mentionTargets: buildMentionTargets([
        { noteUuid: "n1", title: "Pixel 10 Graphene OS", folder: "Personal/Things I have/" },
      ]),
      onOpenNote,
    });
    type("where did that note go?");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.agent-answer")).toBeTruthy());
    // Scoped to the live answer: the same text also lands in the settled turn
    // below it, so a whole-screen lookup finds it twice, which is this
    // surface's existing shape, not something this change introduced.
    const link = within(screen.getByTestId("ai.agent-answer")).getByTestId(
      "ai.mention-link",
    );
    expect(link.textContent).toBe("Personal/Things I have/Pixel 10 Graphene OS");
    // The press reports the NOTE, and the screen opens it: the flow resolves
    // nothing itself.
    fireEvent.click(link);
    expect(onOpenNote).toHaveBeenCalledWith("n1");
  });

  it("advances the three cost figures DURING the run, not only after it", async () => {
    // The load-bearing assertion in this file. The reply is held open, so the
    // only figures on screen are the ones the live channel reported. A surface
    // that read them off the reply would show nothing here.
    let report: (p: RunProgress) => void = () => {};
    let settle: (r: ReturnType<typeof finished>) => void = () => {};
    agentStart.mockImplementation(
      (
        _task: string,
        _grant: unknown,
        // The language, the chat-history seed and the offered settings sit
        // between the grant and the callbacks since myne-md/myne#618, #617 and
        // #850 made them required. A mock that binds by position has to carry
        // every slot or the callbacks land one argument early.
        _language: unknown,
        _history: unknown,
        _settings: unknown,
        _onOpen: unknown,
        onProgress: (p: RunProgress) => void,
      ) => {
        report = onProgress;
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    );
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.agent-working")).toBeTruthy());
    act(() => report({ iterations: 2, notesRead: 5, charsOffDevice: 4096 }));

    // **Asserted on the STORE, not on the rendered sentence**, and that is a
    // fact about this harness rather than a weaker claim: `t()` here returns
    // the key, so the line renders as "agent.review.runSummaryRequests" with
    // every `{{count}}` unresolved, and a substring check for "4096" would be
    // asserting nothing either way. The store is where the figures actually
    // are, and `RunCostLine` is shared verbatim with desktop, whose own suite
    // renders it with a real catalog.
    await waitFor(() => {
      const s = getAgent();
      expect(s.iterations).toBe(2);
      expect(s.notesRead).toBe(5);
      expect(s.charsOffDevice).toBe(4096);
    });
    // Still running, and the line is on screen while it is. That pair is the
    // claim: disclosure DURING the spending, which is the whole reason the host
    // reports per round-trip rather than once at the end.
    expect(screen.getByTestId("ai.run-cost")).toBeTruthy();
    expect(screen.getByTestId("ai.agent-working")).toBeTruthy();

    act(() => settle(finished("", { iterations: 2, notesRead: 5 })));
    await waitFor(() => expect(screen.queryByTestId("ai.agent-working")).toBeNull());
  });

  it("keeps what a cancelled run cost on screen", async () => {
    // The case the live channel exists for. A cancelled run paid for every
    // round-trip it made, and the reply that would have disclosed them never
    // carries the figures the user is entitled to.
    let report: (p: RunProgress) => void = () => {};
    let open: (v: AgentRunView) => void = () => {};
    agentStart.mockImplementation(
      (
        _task: string,
        _grant: unknown,
        _language: unknown,
        _history: unknown,
        _settings: unknown,
        onOpen: (v: AgentRunView) => void,
        onProgress: (p: RunProgress) => void,
      ) => {
        open = onOpen;
        report = onProgress;
        return new Promise(() => {});
      },
    );
    agentCancel.mockResolvedValue(true);
    mount();
    type("rewrite everything");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.agent-working")).toBeTruthy());
    act(() => open(VIEW));
    act(() => report({ iterations: 3, notesRead: 9, charsOffDevice: 12000 }));

    fireEvent.click(screen.getByTestId("ai.composer-stop"));
    expect(agentCancel).toHaveBeenCalledWith("run-1");
    // The figures survive the cancel and the line is still rendered. The reply
    // that would have carried them is never coming, so this is the only
    // disclosure this run will ever make.
    expect(screen.getByTestId("ai.run-cost")).toBeTruthy();
    expect(getAgent().charsOffDevice).toBe(12000);
  });

  it("offers Stop only while a run is in flight, and Send otherwise", async () => {
    agentStart.mockImplementation(() => new Promise(() => {}));
    mount();
    expect(screen.queryByTestId("ai.composer-stop")).toBeNull();

    type("go");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("ai.composer-stop")).toBeTruthy());
    // Not both. A Send beside a Stop is an invitation to start a second run
    // over the first, which the store's own epoch note names as a real defect.
    expect(screen.queryByTestId("ai.composer-send")).toBeNull();
  });

  it("does not send an empty message", () => {
    mount();
    // Disabled rather than silently ignored, so the control says what it will
    // do before it is pressed.
    expect((screen.getByTestId("ai.composer-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    expect(agentStart).not.toHaveBeenCalled();
  });

  it("names the cause, and never echoes the task into the error", async () => {
    // Five distinct states: four refusals plus the network failure. Each is a
    // different problem with a different fix in a different place, and the two
    // easiest to collapse are kept apart on purpose: `NoCredential` means there
    // is nothing to send, `ConsentMissing` means you have not agreed to send
    // it. They were ONE Rust variant until myne-md/myne#456, which is how a
    // user who had never seen the consent screen was told "this kind of request
    // never goes to a provider".
    //
    // **The rejection shapes here are the ones the commands ACTUALLY produce**,
    // which they were not until myne-md/myne#456's third round. These tests
    // mocked bare strings like `"ConsentMissing"`, a wire shape mobile's agent
    // commands cannot emit: they reject with `AgentError`, which is
    // `#[serde(tag = "kind", content = "detail")]`. So the suite asserted a
    // contract that did not exist, and passed, while `AiChatFlow`'s
    // `GATE_REFUSALS` branch could not fire against the real one. The four gate
    // refusals now arrive as `AgentError::GateRefused` carrying the refusing
    // gate's own kind; the transport failure still arrives as an
    // `EngineError`-shaped object, because it is not a gate.
    const gate = (cause: string) => ({ kind: "GateRefused", detail: { cause } });
    const cases: [unknown, string][] = [
      [gate("feature_off"), "featureOff"],
      [gate("not_ready"), "notReady"],
      [gate("consent_missing"), "consentMissing"],
      [gate("no_credential"), "noCredential"],
      [{ kind: "Unreachable" }, "unreachable"],
    ];
    const seen = new Set<string>();
    for (const [variant, key] of cases) {
      agentStart.mockRejectedValue(variant);
      mount();
      type("my private question about the lawsuit");
      fireEvent.click(screen.getByTestId("ai.composer-send"));

      await waitFor(() => expect(screen.getByTestId("ai.turn-error")).toBeTruthy());
      const text = screen.getByTestId("ai.turn-error").textContent ?? "";
      // Asserted against the RESOLVED sentence for this cause's key, which is
      // the same lookup the component makes and still pins WHICH sentence
      // rather than merely that one appeared. It read `toContain(key)` while
      // the harness returned keys verbatim; the catalogs resolve now, so that
      // form would have passed on any sentence at all.
      expect(text).toContain(i18n.t(`settings.ai.providerError.${key}`));
      // And no two states share one. A set, because "five messages" is the
      // requirement and five hits on the same catch-all would satisfy a
      // per-case check.
      expect(seen.has(text)).toBe(false);
      seen.add(text);
      // The task is the user's own words. An error line that quotes it puts
      // note content somewhere it was never meant to be.
      expect(text).not.toContain("lawsuit");
      cleanup();
    }
    expect(seen.size).toBe(5);
  });
});

describe("AiChatFlow: the capability gate", () => {
  // **The defect this closes shipped on this client.** Without the gate, agent
  // mode was offered on every backend, while `core/src/plugins/agent/edit.rs`
  // and `probe.rs` BOTH name that gate as the reason the anchored edit format
  // may refuse a near-miss rather than fuzzy-match it. Two module docs were
  // false here and every check in the tree was green: the binding existed, its
  // ACL row existed, its Rust core existed, and nothing called it.

  it("does not probe on mount, only on send", async () => {
    // A probe is a third-party request (TB13). Firing it when the tab opens
    // would make OPENING A TAB an act of egress, which is the one thing the
    // consent screen promises does not happen.
    agentStart.mockResolvedValue(finished("done"));
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.composer-input")).toBeTruthy());
    expect(agentCapability).not.toHaveBeenCalled();

    type("go");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentCapability).toHaveBeenCalledTimes(1));
  });

  it("refuses the run when the backend cannot hold the edit format", async () => {
    agentCapability.mockResolvedValue({ passed: false });
    mount();
    type("rewrite my notes");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.composer-unsupported")).toBeTruthy());
    // The load-bearing half: the run never started.
    expect(agentStart).not.toHaveBeenCalled();
    // And the user keeps what they typed, so switching provider and sending
    // again does not cost them the message.
    expect((screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).value).toBe(
      "rewrite my notes",
    );
  });

  it("fails CLOSED when the probe cannot be answered at all", async () => {
    // An unanswerable probe is not evidence that the backend CAN hold the
    // format. Asserted separately from the failing verdict because the two are
    // different facts and get different sentences: a verdict that came back
    // failing MEASURED the model, while a probe that threw measured nothing,
    // and telling that user their model is incapable is a diagnosis the inputs
    // cannot support.
    agentCapability.mockRejectedValue(new Error("unreachable"));
    mount();
    type("go");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.composer-unsupported")).toBeTruthy());
    expect(agentStart).not.toHaveBeenCalled();
  });

  it("names the GATE refusal rather than reporting a failed probe", async () => {
    // **The probe passes through the same gate a run does**, so on a device that
    // inherited the provider and the key but has not consented here, the probe
    // is the call that gets refused. Reporting that as "we could not check your
    // model" names no fix while the fix is one tap away, and it undoes the
    // separation the error taxonomy was built for, where a missing key and a
    // missing consent are deliberately never merged. Caught by a Playwright
    // scenario that had asserted the consent refusal since before the gate
    // existed, which is the whole argument for that scenario driving the host's
    // own taxonomy rather than a canned answer.
    agentCapability.mockRejectedValue("ConsentMissing");
    mount();
    type("go");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("ai.turn-error")).toBeTruthy());
    // Not the model's message.
    expect(screen.queryByTestId("ai.composer-unsupported")).toBeNull();
    expect(agentStart).not.toHaveBeenCalled();
  });

  it("leaves the verdict UNASKED after a gate refusal, so a fix can be sent again", async () => {
    // The half that makes the distinction worth anything. Recording `failed`
    // here would block the composer for the session, and the session is exactly
    // when the user walks to Settings, consents, and comes back.
    agentCapability.mockRejectedValue("ConsentMissing");
    mount();
    type("go");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("ai.turn-error")).toBeTruthy());

    // They fixed it. The next send probes again and runs.
    agentCapability.mockResolvedValue({ passed: true });
    agentStart.mockResolvedValue(finished("done"));
    type("go again");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(1));
    expect(agentCapability).toHaveBeenCalledTimes(2);
  });

  it("asks at most once per session, however many times the user sends", async () => {
    // On a remote provider a probe costs `threshold.attempts` requests, and
    // this surface remounts on an ordinary tab switch. The verdict is session
    // state in the run store for exactly that reason, so re-asking would be
    // paying twice for an answer nothing invalidated.
    agentStart.mockResolvedValue(finished("done"));
    mount();
    type("one");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(1));

    type("two");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(2));

    expect(agentCapability).toHaveBeenCalledTimes(1);
  });
});

describe("AiChatFlow: conversation history (myne-md/myne#675)", () => {
  const ROWS = [
    { id: "a1", created_at: 100, title: "Older", updated_at: 100, version: 1 },
    { id: "b2", created_at: 200, title: "Newer", updated_at: 300, version: 2 },
  ];
  const PAYLOAD = JSON.stringify({
    title_derived_from: "Newer",
    turns: [
      { id: "h1", kind: "text", role: "user", text: "previous question" },
      { id: "h2", kind: "text", role: "assistant", text: "previous answer" },
    ],
  });

  it("continues the newest conversation on mount", async () => {
    mockChatsList.mockResolvedValue(ROWS);
    mockChatsRead.mockResolvedValue(PAYLOAD);
    mount();

    // The newest row's turns render; the older row's id is never read.
    await waitFor(() => expect(mockChatsRead).toHaveBeenCalledWith("b2"));
    expect(screen.getByTestId("ai.chat").textContent).toContain("previous question");
    expect(screen.getByTestId("ai.chat").textContent).toContain("previous answer");
  });

  it("renders the turn-end memory marker for a turn that wrote memory (myne-md/myne#697)", async () => {
    // The transparency half of the automatic-write model: a run that wrote
    // says so on its own turn. Seeded through history (the marker reads
    // turn.agentSummary.memoryUpdated), not through a live run.
    mockChatsList.mockResolvedValue(ROWS);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({
        title_derived_from: "Newer",
        turns: [
          { id: "h1", kind: "text", role: "user", text: "remember this" },
          {
            id: "h2",
            kind: "text",
            role: "assistant",
            text: "done",
            agentSummary: {
              runId: "run-9",
              summary: "done",
              edits: 0,
              newNotes: 0,
              notesRead: 1,
              iterations: 2,
              charsOffDevice: 120,
              memoryUpdated: 1,
              end: "finished",
            },
          },
        ],
      }),
    );
    mount();

    await waitFor(() => expect(screen.getByTestId("ai.memory-updated")).toBeTruthy());
  });

  it("appends the settled pair to the open conversation", async () => {
    mockChatsList.mockResolvedValue([]);
    agentStart.mockResolvedValue(finished("settled answer"));
    mount();
    type("a fresh question");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    // First send creates (no conversation open yet) with both turns.
    await waitFor(() => expect(mockChatsCreate).toHaveBeenCalledTimes(1));
    const created = JSON.parse(mockChatsCreate.mock.calls[0]![0] as string);
    expect(created.turns.map((t: { text: string }) => t.text)).toEqual([
      "a fresh question",
      "",
    ]);
    expect(created.turns[1].agentSummary.summary).toBe("settled answer");
    // And the pair renders in the transcript.
    expect(screen.getByTestId("ai.chat").textContent).toContain("a fresh question");
  });

  it("seeds the next run with the open conversation", async () => {
    mockChatsList.mockResolvedValue(ROWS);
    mockChatsRead.mockResolvedValue(PAYLOAD);
    agentStart.mockResolvedValue(finished("follow-up answer"));
    mount();
    await waitFor(() => expect(mockChatsRead).toHaveBeenCalled());

    type("follow up");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    // Fourth argument is the history seed: the continued turns, not [].
    const seed = agentStart.mock.calls[0]![3] as { role: string; text: string }[];
    expect(seed).toEqual([
      { role: "user", text: "previous question" },
      { role: "assistant", text: "previous answer" },
    ]);
  });
});

// myne-md/myne#741. The inline Before/After blocks and the undo strip under the
// composer are gone. A settled turn now carries two icons: one opens its frozen
// proposal read-only, the other reverts the host's current undoable run after a
// confirm. Seeded through history (the icons read `turn.agentSummary`), which is
// also what a live settle persists.
describe("AiChatFlow: turn diff and revert icons (myne-md/myne#741)", () => {
  const SUMMARY = {
    runId: "r1",
    summary: "done",
    edits: 0,
    newNotes: 0,
    notesRead: 1,
    iterations: 1,
    charsOffDevice: null,
    end: "finished",
  };

  function historyWith(agentSummary: Record<string, unknown>): void {
    mockChatsList.mockResolvedValue([
      { id: "b2", created_at: 200, title: "Newer", updated_at: 300, version: 2 },
    ]);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({
        title_derived_from: "Newer",
        turns: [
          { id: "h1", kind: "text", role: "user", text: "q" },
          { id: "h2", kind: "agent", role: "assistant", text: "", agentSummary },
        ],
      }),
    );
  }

  it("opens a settled run's frozen proposal in a read-only sheet", async () => {
    historyWith({
      ...SUMMARY,
      proposal: {
        edits: [{ noteId: "n1", anchor: "old words", replacement: "new words" }],
        newNotes: [{ title: "Scratch", body: "fresh text", folder: null }],
      },
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.turn-diff")).toBeTruthy());
    expect(screen.queryByTestId("ai.proposal-diff")).toBeNull();

    fireEvent.click(screen.getByTestId("ai.turn-diff"));

    const body = screen.getByTestId("ai.proposal-diff-body");
    expect(body.textContent).toContain("old words");
    expect(body.textContent).toContain("new words");
    expect(body.textContent).toContain("Scratch");
    expect(body.textContent).toContain("fresh text");
    expect(
      screen.getByTestId("ai.proposal-edit").getAttribute("data-note-id"),
    ).toBe("n1");
  });

  it("renders no diff icon for a run that proposed nothing", async () => {
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(mockChatsRead).toHaveBeenCalled());
    expect(screen.queryByTestId("ai.turn-diff")).toBeNull();
  });

  it("shows the revert icon only on the host's current undoable run", async () => {
    agentLastRun.mockResolvedValue({
      runId: "r1",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
    // The fallback is SUPPRESSED while a turn hosts the run; without this the
    // condition and "always show it" are indistinguishable.
    expect(screen.queryByTestId("ai.revert-fallback")).toBeNull();
    expect(agentLastRun).toHaveBeenCalled();
  });

  it("hides the revert icon when the host holds no undoable record", async () => {
    agentLastRun.mockResolvedValue(null);
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
    expect(screen.queryByTestId("ai.turn-revert")).toBeNull();
  });

  it("confirms before undoing and reports the result on the turn", async () => {
    agentLastRun.mockResolvedValue({
      runId: "r1",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    agentUndo.mockResolvedValue({ reverted: 1, failed: [], notesCreatedNotReverted: 0 });
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());

    fireEvent.click(screen.getByTestId("ai.turn-revert"));
    expect(screen.getByTestId("ai.revert-confirm")).toBeTruthy();

    fireEvent.click(screen.getByTestId("ai.revert-confirm-undo"));
    await waitFor(() => expect(agentUndo).toHaveBeenCalledWith("r1"));
    expect(agentUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
    // The offer is gone once the host consumes its record.
    await waitFor(() => expect(screen.queryByTestId("ai.turn-revert")).toBeNull());
  });

  it("cancels without calling undo", async () => {
    agentLastRun.mockResolvedValue({
      runId: "r1",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ai.turn-revert"));
    fireEvent.click(screen.getByTestId("ai.revert-cancel"));
    await waitFor(() => expect(screen.queryByTestId("ai.revert-confirm")).toBeNull());
    expect(agentUndo).not.toHaveBeenCalled();
  });

  it("renders the icon only on the matching turn, not on an older run's turn", async () => {
    // Two settled runs, the host holding the FIRST. The guard is `runId`
    // equality, so the affordance lands on exactly one turn. Without this
    // fixture the guard is vacuous.
    agentLastRun.mockResolvedValue({
      runId: "r1",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    mockChatsList.mockResolvedValue([
      { id: "b2", created_at: 200, title: "Newer", updated_at: 300, version: 2 },
    ]);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({
        title_derived_from: "Newer",
        turns: [
          { id: "h1", kind: "agent", role: "assistant", text: "", agentSummary: { ...SUMMARY, runId: "r1" } },
          { id: "h2", kind: "agent", role: "assistant", text: "", agentSummary: { ...SUMMARY, runId: "r2" } },
        ],
      }),
    );
    mount();
    await waitFor(() => expect(screen.getAllByTestId("ai.turn-revert")).toHaveLength(1));
    expect(screen.queryByTestId("ai.revert-fallback")).toBeNull();
    expect(agentLastRun).toHaveBeenCalled();
  });

  it("keeps the offer reachable when no turn hosts it", async () => {
    // A host record whose run is not in the open transcript: New chat, or a
    // switched conversation. The turn icon cannot render, so the toolbar
    // fallback must, or the offer is live but unreachable.
    agentLastRun.mockResolvedValue({
      runId: "r9",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.revert-fallback")).toBeTruthy());
    expect(screen.queryByTestId("ai.turn-revert")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.revert-fallback"));
    expect(screen.getByTestId("ai.revert-confirm")).toBeTruthy();
  });

  it("fails closed: a read that throws offers nothing", async () => {
    // Seed a live offer FIRST, so the assertion distinguishes a clearing catch
    // from an already-empty store (which passes vacuously, since `beforeEach`'s
    // `clearAgentForLock` nulls `undoable`).
    setUndoable(
      { runId: "r1", restorePoints: [["n1", "s1"]], notesCreated: 0 },
      currentRunEpoch(),
    );
    agentLastRun.mockRejectedValue(new Error("locked"));
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
    expect(screen.queryByTestId("ai.turn-revert")).toBeNull();
    expect(screen.queryByTestId("ai.revert-fallback")).toBeNull();
  });

  it("re-reads rather than guessing when the undo itself fails", async () => {
    agentLastRun.mockResolvedValue({
      runId: "r1",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    agentUndo.mockRejectedValue(new Error("noSuchRun"));
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ai.turn-revert"));
    fireEvent.click(screen.getByTestId("ai.revert-confirm-undo"));
    await waitFor(() => expect(agentUndo).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(agentLastRun.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId("ai.undo-result")).toBeNull();
  });

  it("names the half an undo cannot do", async () => {
    agentLastRun.mockResolvedValue({
      runId: "r1",
      restorePoints: [["n1", "s1"]],
      notesCreated: [],
    });
    agentUndo.mockResolvedValue({ reverted: 1, failed: [], notesCreatedNotReverted: 2 });
    historyWith(SUMMARY);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.turn-revert")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ai.turn-revert"));
    fireEvent.click(screen.getByTestId("ai.revert-confirm-undo"));
    await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
    // "The run was undone" otherwise reads as covering the notes it created.
    expect(screen.getByTestId("ai.undo-result").textContent).toContain("left in place");
  });
});
