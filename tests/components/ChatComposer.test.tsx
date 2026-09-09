// @vitest-environment jsdom
//
// Component tests for `src/notes/components/ChatComposer.tsx`, the AI tab's ONE
// composer (myne-md/myne#533).
//
// Three of these are not ergonomics tests. `does not probe on mount, or on
// typing` is the TB13 property in test form: the edit-format probe issues
// `threshold.attempts` requests to whatever provider is configured, so a surface
// that fires it without the user asking sends third-party requests on their
// account. `fails closed when the probe cannot be answered` is the other half:
// an unanswerable probe is not evidence the backend can hold the anchored
// format. And `does not re-probe after a remount` is what those requests COST:
// the verdict is session state now (myne-md/myne#568), because holding it in
// this component meant an ordinary tab switch in the right panel bought the
// whole probe again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
    // The composer reads `i18n.language` and passes it to the run, because the
    // host cannot read the chosen language (it lives in localStorage). A mock
    // returning only `t` made every send throw before it reached `startAgentRun`.
    i18n: { language: "en" },
  }),
}));

const agentCapability = vi.fn();
const agentStart = vi.fn();
const agentPreviewGrant = vi.fn();
vi.mock("../../src/lib/agent-run", () => ({
  agentCapability: (...a: unknown[]) => agentCapability(...a),
  agentStart: (...a: unknown[]) => agentStart(...a),
  agentPreviewGrant: (...a: unknown[]) => agentPreviewGrant(...a),
}));

import { ChatComposer } from "../../src/notes/components/ChatComposer";
import { clearAgentForLock, getAgent } from "../../src/notes/agent/agentStore";
import { getChat, __resetChatForTest } from "../../src/notes/ai/chatStore";

const PASSING = {
  passed: true,
  passes: 2,
  threshold: { attempts: 3, required: 2, provisional: false },
  attempts: [],
};
const FAILING = {
  passed: false,
  passes: 0,
  threshold: { attempts: 3, required: 2, provisional: true },
  attempts: [],
};
const STEP = {
  view: { runId: "r1", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
  proposal: { edits: [{ noteId: "n1", anchor: "a", replacement: "b" }], newNotes: [], summary: "" },
  end: { kind: "finished" },
  iterations: 2,
  notesRead: 1,
  charsOffDevice: null,
  excludedCount: 0,
};

function mount(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  render(<ChatComposer openNoteId="n1" folders={["Projects"]} {...props} />);
}

function type(text: string) {
  fireEvent.change(screen.getByTestId("ai.composer-input"), { target: { value: text } });
}

beforeEach(() => {
  __resetChatForTest();
  // **And the run store, which `cleanup()` cannot reach** (myne-md/myne#568).
  // The probe verdict used to be this component's own state, so unmounting was
  // enough to unask the question; it is session state now, kept deliberately
  // across remounts and dropped only by the vault teardown. Without this, test
  // two inherits test one's verdict and the probe-count assertions measure the
  // wrong thing — which is exactly the leak the field exists to create in
  // production, so the reset belongs here rather than in the field.
  clearAgentForLock();
  agentCapability.mockReset().mockResolvedValue(PASSING);
  agentStart.mockReset().mockResolvedValue(STEP);
  agentPreviewGrant.mockReset().mockResolvedValue({
    noteCount: 12,
    excludedCount: 2,
    unknownCount: 0,
    newTotal: 12,
  });
});
afterEach(() => {
  cleanup();
  __resetChatForTest();
  clearAgentForLock();
});

describe("ChatComposer", () => {
  it("offers the scope control, collapsed", () => {
    // The "only one composer" claim belongs to `AiChatTab` and to e2e `ag6`,
    // where the second one could actually reappear; from inside this component
    // counting its own single textarea would only restate the JSX.
    mount();
    // Collapsed by default (#550): the scope reads as text with a control to
    // change it, and the dropdown is one step back rather than gone.
    expect(screen.getByTestId("ai.composer-scope-current")).toBeTruthy();
    expect(screen.queryByTestId("ai.composer-scope")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.composer-scope-change"));
    expect(screen.getByTestId("ai.composer-scope")).toBeTruthy();
  });

  it("collapses the picker once a folder is chosen, and still shows its size", async () => {
    // The property issue A may not break: the count before sending is part of
    // the mitigation `docs/decisions/ai/0515` names, not a nicety, so moving
    // the picker behind a control must not take the number with it.
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope-change"));
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const option = screen
      .getAllByTestId("ai.composer-scope-option")
      .find((o) => o.getAttribute("data-value") === "Projects");
    fireEvent.click(option!);

    // Back to one line, naming what was chosen.
    expect(screen.queryByTestId("ai.composer-scope")).toBeNull();
    expect(screen.getByTestId("ai.composer-scope-current").textContent).toContain(
      "Projects",
    );
    await waitFor(() =>
      expect(screen.getByTestId("ai.composer-scope-count").textContent).toContain("12"),
    );
  });

  it("does not probe on mount, or on typing", async () => {
    // The name used to say "when the mode changes", from the two-mode world
    // that #552 removed; the property is unchanged and is the one that matters,
    // TB13. Mounting is not asking and neither is typing.
    mount();
    expect(agentCapability).not.toHaveBeenCalled();
    type("something");
    expect(agentCapability).not.toHaveBeenCalled();
  });

  it("counts the probe's attempts on the button while it waits", async () => {
    // myne-md/myne#575. The probe was measured at 40 seconds on a remote
    // provider, and the button said one unchanging thing for the whole of it,
    // which reads as a hang. Driven through the real binding's callback rather
    // than by setting state, so deleting the `onAttempt` argument in
    // `ensureCapability` fails this rather than leaving it green.
    let announce: ((p: { attempt: number; of: number }) => void) | undefined;
    let settle: ((v: unknown) => void) | undefined;
    agentCapability.mockImplementation((onAttempt: unknown) => {
      announce = onAttempt as (p: { attempt: number; of: number }) => void;
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    // Before the host has announced anything there is no number to show, and a
    // "0 of 3" would describe nothing.
    await waitFor(() => expect(announce).toBeDefined());
    expect(screen.getByTestId("ai.composer-send").textContent).toContain(
      "agent.composer.checking",
    );

    act(() => announce!({ attempt: 2, of: 3 }));
    expect(screen.getByTestId("ai.composer-send").textContent).toContain(
      "agent.composer.checkingAt",
    );

    // And it goes away when the probe does, rather than sticking on the last
    // attempt it happened to see.
    await act(async () => {
      settle!(PASSING);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("ai.composer-send").textContent).not.toContain(
        "agent.composer.checking",
      ),
    );
  });

  it("does not re-probe after a remount", async () => {
    // myne-md/myne#568. `AiChatTab` mounts conditionally on the right panel's
    // active tab, so this is an ordinary tab switch away and back, and it used
    // to cost `threshold.attempts` fresh provider requests every time: the
    // verdict lived in this component's own state and died with it. Asserted on
    // the CALL COUNT rather than on the store, because the store holding a
    // value proves nothing about whether the composer consults it.
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentCapability).toHaveBeenCalledTimes(1);

    cleanup();
    mount();
    type("and the lists");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(2));
    expect(agentCapability).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the vault is left", async () => {
    // The other direction, and the reason the verdict is not simply cached
    // forever: the AI provider settings live in `vault.prefs`, so the next
    // vault opened can be configured against a different backend. A carried-over
    // verdict would be a claim about a model that is no longer in use.
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentCapability).toHaveBeenCalledTimes(1);

    cleanup();
    clearAgentForLock();
    expect(getAgent().probeVerdict).toBeNull();
    mount();
    type("and the lists");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(2));
    expect(agentCapability).toHaveBeenCalledTimes(2);
  });

  it("sends every message to the agent, questions included", async () => {
    // The single mode (myne-md/myne#552). There is no longer a route that
    // bypasses the agent, and a question is answered by the run rather than by
    // a second flow: this is what the vault-search tool exists to make true.
    mount();
    type("what did I write about tea");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentStart.mock.calls[0][0]).toBe("what did I write about tea");
  });

  it("probes once on the first send, then starts the run", async () => {
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentCapability).toHaveBeenCalledTimes(1);
    // Third is the interface language, which the host cannot read for itself
    // (myne-md/myne#618); fourth is the visible chat history the run is seeded
    // with (myne-md/myne#617); fifth is the open-channel callback the run
    // reports its id through (myne-md/myne#544). The scope is what this test is
    // about, and asserting the whole call is what keeps a new argument from
    // being added without anyone deciding it should be.
    expect(agentStart).toHaveBeenCalledWith(
      "tidy the headings",
      { kind: "notes", value: ["n1"] },
      "en",
      expect.any(Array),
      expect.any(Function),
      expect.any(Function),
    );
    // A second send reuses the verdict rather than paying for it again.
    type("and the lists");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(2));
    expect(agentCapability).toHaveBeenCalledTimes(1);
  });

  it("sends the run under the attached folder, with the host's count shown first", async () => {
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope-change"));
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const option = screen
      .getAllByTestId("ai.composer-scope-option")
      .find((o) => o.getAttribute("data-value") === "Projects");
    fireEvent.click(option!);
    await waitFor(() => expect(screen.getByTestId("ai.composer-scope-count")).toBeTruthy());
    // The size before sending, and what the excluded-folder clamp removed.
    // "Projects" is not a size (docs/decisions/ai/0515).
    expect(screen.getByTestId("ai.composer-scope-count").textContent).toContain("12");
    expect(screen.getByTestId("ai.composer-scope-excluded").textContent).toContain("2");
    type("rename the concept");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentStart).toHaveBeenCalledWith(
      "rename the concept",
      { kind: "folder", value: "Projects" },
      "en",
      expect.any(Array),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("names the excluded-folders control when the host refuses an emptied scope", async () => {
    // myne-md/myne#675: `start_run` refuses with `EmptyGrant` before any model
    // call when the clamp emptied the scope, and the turn must name the list
    // and where it lives, not the generic "could not start", which sends the
    // user to check their setup for a preference doing its job.
    agentStart.mockRejectedValue({ kind: "EmptyGrant" });
    mount();
    type("summarize this");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    await waitFor(() =>
      expect(getChat().turns.at(-1)?.text).toContain("settings.ai.providerError.emptyGrant"),
    );
  });

  it("says the size could not be checked rather than showing nothing", async () => {
    agentPreviewGrant.mockRejectedValue(new Error("no"));
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope-change"));
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const option = screen
      .getAllByTestId("ai.composer-scope-option")
      .find((o) => o.getAttribute("data-value") === "Projects");
    fireEvent.click(option!);
    // An absent count reads as "no folder attached", and the count before
    // sending is part of the mitigation, not a nicety.
    await waitFor(() =>
      expect(screen.getByTestId("ai.composer-scope-unavailable")).toBeTruthy(),
    );
    expect(screen.queryByTestId("ai.composer-scope-count")).toBeNull();
  });

  it("names the unanswerable probe as unanswerable, not as an incapable model", async () => {
    agentCapability.mockRejectedValue(new Error("no"));
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("ai.composer-unsupported")).toBeTruthy());
    const shown = screen.getByTestId("ai.composer-unsupported").textContent ?? "";
    // Nothing was measured about the model, so the sentence that says the model
    // is incapable would claim more than the input can prove.
    expect(shown).toContain("agent.composer.unchecked");
    expect(shown).not.toContain("agent.composer.unsupported");
  });

  it("fails closed when the probe cannot be answered", async () => {
    agentCapability.mockRejectedValue(new Error("no"));
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("ai.composer-unsupported")).toBeTruthy());
    expect(agentStart).not.toHaveBeenCalled();
    // And it stays refused: the button is not offered again on the next press.
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    expect(agentStart).not.toHaveBeenCalled();
  });

  it("names the verdict when the model simply cannot hold the format", async () => {
    agentCapability.mockResolvedValue(FAILING);
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("ai.composer-unsupported")).toBeTruthy());
    const shown = screen.getByTestId("ai.composer-unsupported").textContent ?? "";
    expect(shown).toContain("agent.composer.unsupportedDetail");
    // The pass mark is admitted to be unmeasured rather than presented as a
    // fact about the model.
    expect(shown).toContain("agent.composer.unsupportedProvisional");
    expect(agentStart).not.toHaveBeenCalled();
    // …and the message survives the refusal, so switching to a backend that can
    // hold the format does not cost the user what they typed.
    expect((screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).value).toBe(
      "tidy the headings",
    );
  });

  it("puts the run into the transcript, under the scope it was sent with", async () => {
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(getChat().turns).toHaveLength(2));
    const [user, agent] = getChat().turns;
    // BOTH turns are `agent`, which is what keeps the task out of the ask
    // model's conversation history: `kind` says which flow produced a turn, not
    // how it looks. Rendering asks the role instead.
    expect(user!.kind).toBe("agent");
    expect(user!.role).toBe("user");
    expect(user!.text).toBe("tidy the headings");
    expect(user!.scopeLabel).toBe("agent.composer.scopeOpenNote");
    expect(agent!.kind).toBe("agent");
    expect(agent!.role).toBe("assistant");
    // Not a stream, so the ask composer's Stop control must not appear.
    expect(getChat().streaming).toBe(false);
    // The settle mirror, through the real `settleRunIntoChat` rather than by
    // calling `settleAgentTurn` directly. Without this the whole body of that
    // function could be deleted and every test would still pass, which is the
    // definition of a claim rather than coverage.
    expect(agent!.agentSummary).toMatchObject({
      runId: "r1",
      edits: 1,
      newNotes: 0,
      notesRead: 1,
      iterations: 2,
      charsOffDevice: null,
      end: "finished",
    });
  });

  it("carries the model's closing summary onto the turn", async () => {
    // myne-md/myne#568, and driven through the real `settleRunIntoChat` for the
    // reason the test above states: calling `settleAgentTurn` directly would let
    // the line that reads `proposal.summary` be deleted with everything still
    // green.
    //
    // This is the half that one mode was missing. The agent answers a question
    // through `finish`, so the summary is the ANSWER; before this it reached
    // only `agentStore`, whose one renderer is the review dialog, and a question
    // about a note got answered inside a "Review changes" screen.
    agentStart.mockResolvedValue({
      ...STEP,
      proposal: {
        edits: [],
        newNotes: [],
        summary: "You have 16 personal tasks in this note.",
      },
    });
    mount();
    type("how many personal tasks are in this note");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(getChat().turns).toHaveLength(2));
    expect(getChat().turns[1]!.agentSummary?.summary).toBe(
      "You have 16 personal tasks in this note.",
    );
  });

  it("does not freeze a run that stopped to ASK for more scope", async () => {
    // Its step returned, so `running` is false, but the loop is paused on a
    // question the scope dialog is putting to the user. Freezing there prints
    // "the agent proposed no changes" underneath a dialog about to make it
    // propose some.
    agentStart.mockResolvedValue({
      ...STEP,
      proposal: { edits: [], newNotes: [], summary: "" },
      end: { kind: "awaitingScope", folder: "Projects", reason: "why" },
    });
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(getChat().turns).toHaveLength(2));
    expect(getChat().turns[1]!.agentSummary).toBeUndefined();
  });

  it("leaves a failed start readable in the turn, said once", async () => {
    agentStart.mockRejectedValue(new Error("no"));
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(getChat().turns).toHaveLength(2));
    const agentTurn = getChat().turns[1]!;
    // The store's copy of the failure dies with the next `beginRun()`, so the
    // turn keeps its own. Otherwise a second run erases what happened to the
    // first one from a transcript that is still showing it.
    expect(agentTurn.error).toBe(true);
    expect(agentTurn.text).toBe("agent.composer.startFailed");
  });

  it("sends on Enter and breaks the line on Shift+Enter", async () => {
    mount();
    const input = screen.getByTestId("ai.composer-input");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(agentStart).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentStart.mock.calls[0][0]).toBe("first");
  });

  it("does not send the first syllable an IME is still composing", () => {
    mount();
    const input = screen.getByTestId("ai.composer-input");
    fireEvent.change(input, { target: { value: "ç" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(agentStart).not.toHaveBeenCalled();
  });

});
