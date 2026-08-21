// @vitest-environment jsdom
//
// Component tests for `src/notes/components/ChatComposer.tsx`, the AI tab's ONE
// composer (myne-md/myne#533).
//
// Two of these are not ergonomics tests. `does not probe when the mode changes`
// is the TB13 property in test form: the edit-format probe issues
// `threshold.attempts` requests to whatever provider is configured, so a surface
// that fires it without the user asking sends third-party requests on their
// account. And `fails closed when the probe cannot be answered` is the other
// half: an unanswerable probe is not evidence the backend can hold the anchored
// format.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
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
  const onSend = vi.fn();
  render(
    <ChatComposer
      onSend={onSend}
      streaming={false}
      openNoteId="n1"
      folders={["Projects"]}
      {...props}
    />,
  );
  return { onSend };
}

function type(text: string) {
  fireEvent.change(screen.getByTestId("ai.composer-input"), { target: { value: text } });
}

beforeEach(() => {
  __resetChatForTest();
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
});

describe("ChatComposer", () => {
  it("offers the scope control in Edit mode and not in Ask", () => {
    // The "only one composer" claim belongs to `AiChatTab` and to e2e `ag6`,
    // where the second one could actually reappear; from inside this component
    // counting its own single textarea would only restate the JSX.
    mount();
    // Ask mode makes no grant, so it is not asked to explain one.
    expect(screen.queryByTestId("ai.composer-scope-current")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
    // Collapsed by default (issue A): the scope reads as text with a control to
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
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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

  it("does not probe when the mode changes", async () => {
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
    fireEvent.click(screen.getByTestId("ai.composer-mode-ask"));
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
    type("something");
    // Still nothing: typing is not asking either.
    expect(agentCapability).not.toHaveBeenCalled();
  });

  it("routes Ask-mode sends to the chat, never to the agent", () => {
    const { onSend } = mount();
    type("what did I write about tea");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    expect(onSend).toHaveBeenCalledWith("what did I write about tea");
    expect(agentCapability).not.toHaveBeenCalled();
    expect(agentStart).not.toHaveBeenCalled();
  });

  it("probes once on the first Edit-mode send, then starts the run", async () => {
    const { onSend } = mount();
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentCapability).toHaveBeenCalledTimes(1);
    // The third argument is the open-channel callback the run reports its id
    // through (myne-md/myne#544); the scope is what this test is about.
    expect(agentStart).toHaveBeenCalledWith(
      "tidy the headings",
      { kind: "notes", value: ["n1"] },
      expect.any(Function),
    );
    expect(onSend).not.toHaveBeenCalled();
    // A second send reuses the verdict rather than paying for it again.
    type("and the lists");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(2));
    expect(agentCapability).toHaveBeenCalledTimes(1);
  });

  it("sends the run under the attached folder, with the host's count shown first", async () => {
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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
      expect.any(Function),
    );
  });

  it("says the size could not be checked rather than showing nothing", async () => {
    agentPreviewGrant.mockRejectedValue(new Error("no"));
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(getChat().turns).toHaveLength(2));
    expect(getChat().turns[1]!.agentSummary).toBeUndefined();
  });

  it("leaves a failed start readable in the turn, said once", async () => {
    agentStart.mockRejectedValue(new Error("no"));
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-mode-edit"));
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

  it("sends on Enter and breaks the line on Shift+Enter", () => {
    const { onSend } = mount();
    const input = screen.getByTestId("ai.composer-input");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("first");
  });

  it("does not send the first syllable an IME is still composing", () => {
    const { onSend } = mount();
    const input = screen.getByTestId("ai.composer-input");
    fireEvent.change(input, { target: { value: "ç" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers Stop instead of Send while a generation streams", () => {
    const onStop = vi.fn();
    mount({ streaming: true, onStop });
    expect(screen.queryByTestId("ai.composer-send")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.composer-stop"));
    expect(onStop).toHaveBeenCalled();
  });
});
