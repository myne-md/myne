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
const catalogList = vi.fn();
const attachmentReadExtractedText = vi.fn();
const attachmentImport = vi.fn();
vi.mock("../../src/lib/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/attachments")>()),
  catalogList: (...a: unknown[]) => catalogList(...a),
  attachmentReadExtractedText: (...a: unknown[]) => attachmentReadExtractedText(...a),
  attachmentImport: (...a: unknown[]) => attachmentImport(...a),
}));

vi.mock("../../src/lib/agent-run", () => ({
  agentCapability: (...a: unknown[]) => agentCapability(...a),
  agentStart: (...a: unknown[]) => agentStart(...a),
  agentPreviewGrant: (...a: unknown[]) => agentPreviewGrant(...a),
}));

import {
  ChatComposer,
  VAULT_SCOPE_SENTINEL,
} from "../../src/notes/components/ChatComposer";
import { clearAgentForLock, getAgent } from "../../src/notes/agent/agentStore";
import { bumpIndexNonce } from "../../src/notes/indexNonce";
import {
  clearChat,
  getChat,
  hydrateChatTurns,
  sendChatMessage,
  __resetChatForTest,
} from "../../src/notes/ai/chatStore";

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
  render(<ChatComposer surface="agent" openNoteId="n1" folders={["Projects"]} {...props} />);
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
  catalogList.mockReset().mockResolvedValue([
    {
      id: "0184a2b3c4d5e6f708192a3b4c5d6e7f",
      content_type: "application/pdf",
      created_at: 1,
      filename: "lecture.pdf",
      size: 2048,
    },
  ]);
  attachmentReadExtractedText
    .mockReset()
    .mockResolvedValue({ text: "the lecture, in words", source_format: "pdf", truncated: false });
  attachmentImport.mockReset().mockResolvedValue({
    id: "0184a2b3c4d5e6f708192a3b4c5d6e81",
    content_type: "image/png",
    filename: "image.png",
    size: 512,
    created_at: 2,
    deduplicated: false,
    original_size: 512,
    container_changed: false,
  });
});
afterEach(() => {
  cleanup();
  __resetChatForTest();
  clearAgentForLock();
});

describe("ChatComposer", () => {
  it("offers the scope control directly, not behind a disclosure", () => {
    // It used to render a caption plus a Change button, and pressing Change
    // replaced them with this same control — whose trigger you then pressed to
    // open the menu. Two clicks and a layout shift to reach a control that
    // already IS a disclosure (myne-md/myne#771).
    //
    // `docs/decisions/ai/0518` point 1 is what may not break: a
    // user-originated scope control must be ON the composer, because removing
    // it routes every folder-scale run through the model-originated expansion,
    // which is the injection-reachable path. One click instead of two is a
    // change of cost, not of presence.
    mount();
    expect(screen.getByTestId("ai.composer-scope")).toBeTruthy();
    expect(screen.queryByTestId("ai.composer-scope-change")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    expect(screen.getAllByTestId("ai.composer-scope-option").length).toBeGreaterThan(0);
  });

  it("keeps the size beside the picker once a folder is chosen", async () => {
    // The property issue A may not break: the count before sending is part of
    // the mitigation `docs/decisions/ai/0515` names, not a nicety, so changing
    // how the picker is reached must not take the number with it.
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const option = screen
      .getAllByTestId("ai.composer-scope-option")
      .find((o) => o.getAttribute("data-value") === "Projects");
    fireEvent.click(option!);

    // The trigger names what was chosen — no second element to read it from.
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toContain("Projects");
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

  it("says it is checking, ON the button, while the probe runs", async () => {
    // **The reversal, and the reason** (myne-md/myne#848, on the user's read):
    // the probe used to print a caption under the row, "Checking the model…
    // (2/3)", which is a line of prose for a state the user is already looking
    // at the control for, and the fraction described Myne's retry loop rather
    // than anything the user could act on. The button says one word instead.
    //
    // The note this replaces said the label must NOT change, because the
    // sentence it changed to collapsed the textarea beside it mid-keystroke.
    // That is still true of a sentence. This is one word, swapped in a window
    // that OPENS when the user has just pressed Send and CLOSES when the field
    // is cleared, not one they are typing into.
    let settle: ((v: unknown) => void) | undefined;
    agentCapability.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() =>
      expect(screen.getByTestId("ai.composer-send").textContent).toContain(
        "agent.composer.checking",
      ),
    );
    // The caption is gone, and so is the progress it carried: `ensureCapability`
    // no longer passes an `onAttempt` sink at all.
    expect(screen.queryByTestId("ai.composer-probe-at")).toBeNull();

    // And it goes back to Send when the probe does, rather than sticking.
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
      // The settings catalogue the client offers the run (myne-md/myne#850).
      // Asserted in the whole-call shape below so a new argument cannot be
      // added without a decision, which is what this expectation is for.
      expect.arrayContaining(["editor.weekly-notes-folder"]),
      // The documents this message carries (myne-md/myne#913). An ordinary
      // message carries none, and the empty list is asserted rather than
      // skipped: a run that silently attached something would change what
      // leaves the device without the user picking a file.
      [],
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
      // The settings catalogue the client offers the run (myne-md/myne#850).
      // Asserted in the whole-call shape below so a new argument cannot be
      // added without a decision, which is what this expectation is for.
      expect.arrayContaining(["editor.weekly-notes-folder"]),
      // The documents this message carries (myne-md/myne#913). An ordinary
      // message carries none, and the empty list is asserted rather than
      // skipped: a run that silently attached something would change what
      // leaves the device without the user picking a file.
      [],
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
    // The store's copy of the failure dies with the next `beginRun(null)`, so the
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

describe("ChatComposer: the settings sit under the input", () => {
  // They were two full-width rows ABOVE it, between the transcript and the
  // thing the user came to type in — a quarter of a 280px panel spent on two
  // choices almost nobody changes per message, read past on every visit.
  //
  // Nothing else reports the order: both arrangements render, both are
  // reachable, and every other test in this file finds its control by testid
  // regardless of where it sits. So the only way this stays fixed is to say so.

  function order(a: string, b: string): boolean {
    const first = screen.getByTestId(a);
    const second = screen.getByTestId(b);
    return (
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  }

  it("makes the permission mode a dropdown, not a button that toggles", async () => {
    // **A control whose value is a word from a set is a dropdown**
    // (myne-md/myne#848). It was a button that CHANGED the mode on press, which
    // made the row hold two idioms for the same kind of choice: the scope
    // control said what it was set to and offered the alternatives, and this one
    // said what it was set to and hid the alternative behind the press that also
    // changed it.
    mount();
    const trigger = screen.getByTestId("ai.composer-permission");
    // The value is written on the trigger, and there is a menu to open.
    expect(screen.getByTestId("ai.composer-permission-value").textContent).toBe(
      "agent.composer.permissionAsk",
    );
    expect(screen.queryByTestId("ai.composer-permission-menu")).toBeNull();
    fireEvent.click(trigger);
    const options = screen.getAllByTestId("ai.composer-permission-option");
    expect(options.map((o) => o.getAttribute("data-value"))).toEqual(["ask", "auto"]);
    // …and the other option is where the mode changes.
    expect(getAgent().autoApply).toBe(false);
    fireEvent.click(options[1]!);
    expect(getAgent().autoApply).toBe(true);
    expect(screen.getByTestId("ai.composer-permission-value").textContent).toBe(
      "agent.composer.permissionAuto",
    );
    // The menu closes on the pick, and the way back is the same menu.
    expect(screen.queryByTestId("ai.composer-permission-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("ai.composer-permission"));
    fireEvent.click(
      screen
        .getAllByTestId("ai.composer-permission-option")
        .find((o) => o.getAttribute("data-value") === "ask")!,
    );
    expect(getAgent().autoApply).toBe(false);
  });

  it("keeps the row's captions SHORT, which is what keeps it on one line", async () => {
    // jsdom has no layout, so the assertion is on the mechanism. The full
    // sentence the composer used to render, "N notes are excluded from AI and
    // stay out", is ~220px at this font and pushed the row past the composer's
    // ~493px, wrapping the caption onto its own line as soon as the permission
    // read "Apply automatically" (myne-md/myne#848). The row keeps the compact
    // form; the expansion dialog and mobile keep the sentence, where there is
    // room for it and it is not a status line.
    agentPreviewGrant.mockResolvedValue({
      noteCount: 431,
      excludedCount: 0,
      unknownCount: 0,
      newTotal: 431,
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.composer-scope-count")).toBeTruthy());
    expect(screen.getByTestId("ai.composer-scope-count").textContent).toBe(
      "agent.composer.scopeCount:431",
    );
    expect(screen.getByTestId("ai.composer-scope-excluded").textContent).toBe(
      "agent.composer.scopeExcluded:0",
    );
  });

  it("puts the scope and the permission mode after the composer input", () => {
    mount();
    expect(order("ai.composer-input", "ai.composer-scope"), "scope is above the input").toBe(
      true,
    );
    expect(
      order("ai.composer-input", "ai.composer-permission"),
      "the permission mode is above the input",
    ).toBe(true);
  });

  it("keeps the send control with the input, not with the settings", () => {
    // The input and its Send are one act and stay one row. Only the settings
    // moved — if Send had gone with them, typing and sending would be split by
    // two dropdowns.
    mount();
    expect(order("ai.composer-input", "ai.composer-send")).toBe(true);
    expect(order("ai.composer-send", "ai.composer-scope"), "Send fell below the settings").toBe(
      true,
    );
  });

  it("keeps the capability refusal above everything", async () => {
    // The one thing that must be read BEFORE the next attempt: it is where a
    // user finds out that agent mode is unavailable on the model they chose,
    // and a notice below the composer is a notice read after the attempt it
    // would have saved. It appears only once a probe has come back, so it takes
    // a send to reach — which is the same path every other refusal case here
    // uses.
    agentCapability.mockResolvedValue(FAILING);
    mount();
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("ai.composer-unsupported")).toBeTruthy());
    expect(order("ai.composer-unsupported", "ai.composer-input")).toBe(true);
    expect(order("ai.composer-unsupported", "ai.composer-scope")).toBe(true);
  });
});

describe("ChatComposer: the empty input is one row", () => {
  // `scrollHeight` measures the RENDERED text, and a textarea with no value
  // renders its placeholder — so a placeholder that wraps at panel width
  // reported two lines and the box opened two rows tall before the user had
  // typed anything.
  //
  // The reason it is worth a test rather than a shorter string: left as it
  // was, the empty composer's height is a property of the COPY. Translate the
  // placeholder into a longer language and it grows again, in that locale
  // only, with nothing in the code to point at — and `locales/` has 31 of them.

  /**
   * jsdom reports `scrollHeight: 0` for everything, and the effect skips a
   * zero measurement — so WITHOUT this stub neither case can reach the state
   * it is about. The first would pass against an implementation with no guard
   * at all, which is exactly what happened: removing `if (message === "")`
   * left it green. The fixture has to be able to hold the defect.
   */
  function withMeasuredHeight(px: number, body: () => void): void {
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => px,
    });
    try {
      body();
    } finally {
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
    }
  }

  const input = () => screen.getByTestId("ai.composer-input") as HTMLTextAreaElement;

  it("does not size itself from the placeholder", () => {
    withMeasuredHeight(64, () => {
      mount();
      // The measurement is available and deliberately not used: an empty value
      // means there is nothing of the user's to fit, whatever the placeholder
      // happens to occupy.
      expect(input().style.height, "an empty input took a measured height").toBe("auto");
    });
  });

  it("sizes itself once there is something to size", () => {
    withMeasuredHeight(64, () => {
      mount();
      type("a message long enough to wrap in a side panel, several times over");
      // The guard is on EMPTINESS, not on the effect: a non-empty value still
      // goes through the measure-and-write path.
      expect(input().style.height).toBe("64px");
    });
  });
});

describe("ChatComposer: with no note open, it says so and offers the way out", () => {
  // The dead end a user actually hit. In the AGENT TAB the tab is usually the
  // focused pane, so there is no open note — and the picker's one entry was an
  // unconditional "This note". It named something that did not exist, resolved
  // to `null`, and left Send permanently disabled with no other scope in the
  // list to pick instead.
  //
  // A control lying about its own value is worse than one with nothing in it:
  // the user reads "This note" and concludes the app is broken rather than
  // that they have a choice to make.

  function noteless(folders: readonly string[] = ["Projects", "Archive"]) {
    render(
      <ChatComposer surface="agent" openNoteId={null} folders={folders} />,
    );
  }

  it("does not offer 'This note' when there is none", () => {
    noteless();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const labels = screen
      .getAllByTestId("ai.composer-scope-option")
      .map((o) => o.getAttribute("data-value"));
    expect(labels, "the open-note entry is still offered").not.toContain("");
    // The vault entry is FIRST since myne-md/myne#848: it is the default, so it
    // is the one the trigger reads back most of the time.
    expect(labels).toEqual([VAULT_SCOPE_SENTINEL, "Projects", "Archive"]);
  });

  it("still offers it when there IS one", () => {
    // The gate is on the NOTE, not on the surface: the light panel has one
    // open almost always, and removing the entry there would take away the
    // common case's default.
    render(<ChatComposer surface="agent" openNoteId="n-1" folders={["Projects"]} />);
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    expect(
      screen.getAllByTestId("ai.composer-scope-option").map((o) => o.getAttribute("data-value")),
    ).toContain("");
  });

  it("names the choice rather than a value it does not have", () => {
    noteless();
    expect(screen.getByTestId("ai.composer-scope-value").textContent).not.toContain(
      "agent.composer.scopeOpenNote",
    );
  });

  it("opens on the whole vault when no note is open", () => {
    // myne-md/myne#848. The default IS a scope now: with no folder attached and
    // no note open, the run covers the vault minus the excluded folders, and the
    // trigger says so rather than reading "nothing selected".
    noteless();
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toContain(
      "agent.composer.scopeAllVault",
    );
    // An icon-only control states the KIND in its glyph and the value in its
    // name, which is the trade this change made (myne-md/myne#848).
    expect(screen.getByTestId("ai.composer-scope").querySelector("svg")).not.toBeNull();
  });

  it("sends the vault grant, and shows what it excludes, including zero", async () => {
    // The count is the reason the scope control exists
    // (`docs/decisions/ai/0515`): a number the user did not expect has to be
    // explainable in place. Rendering the excluded line at ZERO is the other
    // half, an absent line cannot be told apart from "we did not check".
    agentPreviewGrant.mockResolvedValue({
      noteCount: 40,
      excludedCount: 0,
      unknownCount: 0,
      newTotal: 40,
    });
    noteless();
    await waitFor(() => expect(screen.getByTestId("ai.composer-scope-count")).toBeTruthy());
    expect(agentPreviewGrant).toHaveBeenCalledWith({ kind: "vault" });
    expect(screen.getByTestId("ai.composer-scope-count").textContent).toContain("40");
    expect(screen.getByTestId("ai.composer-scope-excluded").textContent).toContain("0");
  });

  it("has no needs-scope line at all, because a scope always exists", () => {
    // The line is gone rather than unreachable-but-present: it warned about a
    // disabled Send with no scope, and with the vault default that state cannot
    // arise. A rule that renders nowhere is a rule nobody will notice being
    // wrong.
    noteless();
    type("selam");
    expect(screen.queryByTestId("ai.composer-needs-scope")).toBeNull();
    expect((screen.getByTestId("ai.composer-send") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("ChatComposer — the attached scope belongs to one conversation", () => {
  // The reported defect (myne-md/myne#771): "it persists the same exact note
  // between chats". A folder attached once stayed attached for every later
  // conversation, because nothing remounts this composer when the transcript
  // is swapped under it — so the grant a user chose for ONE question silently
  // became the standing grant for every question after it, which is the
  // opposite of the user-originated scope `docs/decisions/ai/0518` point 1
  // requires.

  function attachProjects(): void {
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    fireEvent.click(
      screen
        .getAllByTestId("ai.composer-scope-option")
        .find((o) => o.getAttribute("data-value") === "Projects")!,
    );
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toContain("Projects");
  }

  it("drops the folder when a new conversation is started", () => {
    mount();
    attachProjects();
    act(() => {
      clearChat();
    });
    expect(screen.getByTestId("ai.composer-scope-value").textContent).not.toContain("Projects");
  });

  it("drops the folder when another conversation is opened", () => {
    // `openConversation` replaces the transcript through `hydrateChatTurns`,
    // which is the boundary this keys on. The id never passes through the
    // composer, so a fix keyed on an id would not see this at all.
    mount();
    attachProjects();
    act(() => {
      hydrateChatTurns([
        {
          id: "t1",
          kind: "text",
          role: "user",
          text: "önceki",
          streaming: false,
          error: false,
          insertable: false,
        },
      ]);
    });
    expect(screen.getByTestId("ai.composer-scope-value").textContent).not.toContain("Projects");
  });

  it("actually SENDS under the dropped scope, not merely relabels the trigger", () => {
    // The trigger's text and the grant handed to the host are two different
    // values, and only the second one decides what the model reads. A reset
    // that moved the label and left `attached` would pass the two tests above.
    mount();
    attachProjects();
    act(() => {
      clearChat();
    });
    type("what is this");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    return waitFor(() => {
      expect(agentStart).toHaveBeenCalledWith(
        "what is this",
        { kind: "notes", value: ["n1"] },
        "en",
        expect.any(Array),
        expect.arrayContaining(["editor.weekly-notes-folder"]),
        [],
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  it("KEEPS the folder across a message inside the same conversation", () => {
    // The other direction, and the one that says why this is a conversation
    // epoch rather than the run epoch sitting beside it in the same module.
    // `runEpoch` bumps on every SEND too, so a reset keyed on it would throw
    // the user's scope away between two messages they read as one thread —
    // and the three tests above would all still pass.
    mount();
    attachProjects();
    act(() => {
      sendChatMessage("ilk mesaj");
    });
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toContain("Projects");
  });

  it("crosses the boundary even when the transcript was already empty", () => {
    // "New conversation" on a fresh tab dispatches CLEARED over an empty
    // store, and `dispatchChat` returns early when the reducer hands back the
    // same state — so a boundary announced only by that dispatch is invisible
    // on exactly the path a user takes when they pick a scope, change their
    // mind, and press New again.
    mount();
    expect(getChat().turns.length).toBe(0);
    attachProjects();
    act(() => {
      clearChat();
    });
    expect(screen.getByTestId("ai.composer-scope-value").textContent).not.toContain("Projects");
  });
});

// myne-md/myne#848. The composer's zero state and its controls.
//
// The two claims worth testing here are both about WHERE a fact lives rather
// than whether it renders: the field refuses the keystroke instead of the send
// (so a user finds out before typing a paragraph), and the sentence that says
// what is missing is the field's PLACEHOLDER rather than a line under it, which
// is why the assertion is on the placeholder and on the ABSENCE of the old
// caption, not on a new caption's wording.
describe("ChatComposer, a session anchored to a note pins its scope (myne-md/myne#848)", () => {
  // The user's read: a session opened FROM a note is about that note, so the
  // scope is settled and the picker would only invite a mistake. Widening is a
  // session-level decision, a new conversation starts vault-wide.
  it("renders no picker at all", () => {
    mount({ anchoredNoteId: "n7" });
    expect(screen.queryByTestId("ai.composer-scope")).toBeNull();
    expect(screen.queryByTestId("ai.composer-scope-wrap")).toBeNull();
    // The DISCLOSURE is untouched: the count and the excluded figure are what
    // `docs/decisions/ai/0515` names as the mitigation, and they are not the
    // picker.
    expect(screen.getByTestId("ai.composer-permission")).toBeTruthy();
  });

  it("sends the anchored note, whatever the picker was left on", async () => {
    // A scope chosen for a previous, unanchored session must not survive into
    // this one. `attached` is still reset on the conversation epoch; this
    // asserts the stronger claim, the picker cannot move an anchored scope.
    mount({ anchoredNoteId: "n7" });
    type("tidy the headings");
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalled());
    expect(agentStart.mock.calls.at(-1)![1]).toEqual({
      kind: "notes",
      value: ["n7"],
    });
  });

  it("keeps the picker when the session is not anchored", () => {
    // The LIGHT panel's composer: the note is whatever the editor has open
    // beside the box, and changing the scope for one message is the idiom.
    mount({ openNoteId: "n1", anchoredNoteId: null });
    expect(screen.getByTestId("ai.composer-scope")).toBeTruthy();
  });
});

describe("ChatComposer, the blocked zero state", () => {
  function emptyScope() {
    agentPreviewGrant.mockResolvedValue({
      noteCount: 0,
      excludedCount: 0,
      unknownCount: 0,
      newTotal: 0,
    });
  }

  it("refuses the keystroke and highlights the picker when the scope is empty", async () => {
    emptyScope();
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("ai.composer-scope-wrap").getAttribute("data-blocked")).toBe(
        "true",
      ),
    );
    expect((screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    // The highlight is the accent ring, and it has to be visible: a state that
    // only sets `data-blocked` tells a reader and nobody else.
    const wrap = screen.getByTestId("ai.composer-scope-wrap");
    expect(wrap.style.outline).toContain("2px solid");
  });

  it("says what is needed in the placeholder, with no line under the field", async () => {
    emptyScope();
    mount();
    await waitFor(() =>
      expect((screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).disabled).toBe(
        true,
      ),
    );
    expect(
      (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).placeholder,
    ).toBe("agent.composer.blockedScope");
    // The caption is gone, and this is the half that keeps it gone: the graph
    // had a warning line under the field, and reviving one would satisfy the
    // first assertion above while undoing the decision.
    expect(screen.queryByTestId("ai.composer-needs-scope")).toBeNull();
  });

  it("shows the sidebar its own sentence about what is missing", async () => {
    emptyScope();
    render(<ChatComposer surface="sidebar" openNoteId="n1" folders={["Projects"]} />);
    await waitFor(() =>
      expect((screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).disabled).toBe(
        true,
      ),
    );
    // Different copy, same state: the sidebar has a note open beside the box, so
    // "every note is excluded, or the vault is empty" is the wrong sentence for
    // what the user is looking at.
    expect(
      (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).placeholder,
    ).toBe("agent.composer.blockedScopeSidebar");
  });

  it("says it is GETTING READY while the scope's size is unknown", async () => {
    // **Unanswered is not empty** (myne-md/myne#848, on the user's report). The
    // size comes from the host, and while that read is in flight the composer
    // knows nothing about the scope. It used to say so in the vault's words,
    // "every note is excluded from AI, or the vault is empty", which is a claim
    // about the vault made before the vault was asked.
    let settle: ((p: unknown) => void) | undefined;
    agentPreviewGrant.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mount();
    expect(
      (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).placeholder,
    ).toBe("agent.composer.preparing");
    // Still enabled: the field is not blocked, it is waiting, and a user can
    // type while the count arrives.
    expect((screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).disabled).toBe(
      false,
    );

    await act(async () => {
      settle!({ noteCount: 431, excludedCount: 0, unknownCount: 0, newTotal: 431 });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).placeholder,
      ).toBe("agent.composer.placeholder"),
    );
  });

  it("does NOT fall back to 'getting ready' while the index catches up", async () => {
    // **The flicker** (myne-md/myne#848, on the user's report: "it still goes
    // back and forth between getting ready and ask ai while the note count
    // progresses"). An index bump re-asks for the count, and clearing the
    // previous answer on every ask made the placeholder oscillate once per
    // re-indexed note. The clearing is for a SCOPE change, a stale number
    // under a new scope's name, and an index bump is the same scope.
    mount();
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).placeholder,
      ).toBe("agent.composer.placeholder"),
    );
    // The re-ask HANGS, so the in-flight window is observable: an immediately
    // resolving mock would hide the very state this is about.
    agentPreviewGrant.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      bumpIndexNonce();
      await Promise.resolve();
    });
    // The previous answer stays up while the new one is in flight, so neither
    // the placeholder nor the count moves.
    expect(
      (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).placeholder,
    ).toBe("agent.composer.placeholder");
    expect(screen.getByTestId("ai.composer-scope-count")).toBeTruthy();
  });

  it("re-asks for the count when the vault INDEX changes", async () => {
    // **The bug behind the report** (myne-md/myne#848): `vault.indices` hydrates
    // at unlock and the notes changed since its snapshot are re-applied after
    // it, so a count asked for in that window is answered against a half-filled
    // index, 0 notes on a vault that has 431, and nothing was going to re-ask.
    // The index's own nonce (myne#277) is the signal that the answer moved.
    mount();
    await waitFor(() => expect(agentPreviewGrant).toHaveBeenCalledTimes(1));
    act(() => bumpIndexNonce());
    await waitFor(() => expect(agentPreviewGrant).toHaveBeenCalledTimes(2));
  });

  it("closes the scope menu when the user looks away from it", () => {
    // myne-md/myne#848. It used to close only by pressing its own trigger again,
    // so a user who opened it and then pressed anywhere else had to find the
    // trigger and press it twice. Escape is the keyboard half of the same ask.
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    expect(screen.getByTestId("ai.composer-scope-menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("ai.composer-scope-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    expect(screen.getByTestId("ai.composer-scope-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("ai.composer-scope-menu")).toBeNull();
  });

  it("keeps the menu open when the press is INSIDE it", () => {
    // The other direction: a dismissal that also closed on the menu's own
    // presses would make the control unusable.
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    fireEvent.mouseDown(screen.getByTestId("ai.composer-scope-menu"));
    expect(screen.getByTestId("ai.composer-scope-menu")).toBeTruthy();
  });

  it("writes the current scope beside its icon, not only in its name", () => {
    mount();
    // `This note` when a note is open and nothing is attached: the value the run
    // will use, as text, which is what the user asked for.
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toBe(
      "agent.composer.scopeOpenNote",
    );
  });

  it("DOES size itself from the copy when the field is blocked", async () => {
    // The one exception to the rule above, and the reason is the copy itself: a
    // blocked field has nothing else to say, and clipping its sentence at the
    // first line hides the only explanation on screen (myne-md/myne#848).
    agentPreviewGrant.mockResolvedValue({
      noteCount: 0,
      excludedCount: 0,
      unknownCount: 0,
      newTotal: 0,
    });
    // The stub has to stay in place across the await: the preview resolves
    // asynchronously, and the measure-and-write runs on the render after it.
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 64,
    });
    const box = () => screen.getByTestId("ai.composer-input") as HTMLTextAreaElement;
    try {
      mount();
      await waitFor(() => expect(box().disabled).toBe(true));
      await waitFor(() => expect(box().style.height).toBe("64px"));
    } finally {
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
    }
  });

  it("grows to exactly five lines and then scrolls", () => {
    mount();
    const input = screen.getByTestId("ai.composer-input") as HTMLTextAreaElement;
    // Asserted as a RATIO rather than as the literal "7em": the ceiling is
    // expressed in `em` so it follows the type scale, and a test pinning the
    // string would pass at any line height while the comment claimed five.
    const lines = parseFloat(input.style.maxHeight) / parseFloat(input.style.lineHeight);
    expect(lines).toBe(5);
    expect(input.style.overflowY).toBe("auto");
  });
});

// ---- attached documents (myne-md/myne#913) --------------------------------
//
// The two properties that must not break: a document reaches the run as TEXT
// under the user's own pick (not as an id the host re-reads later, and not as
// part of the task string, which would stop it being counted off-device), and a
// file with no extractable text is a sentence rather than a message that goes
// out without it.
describe("ChatComposer: attached documents", () => {
  it("sends the chosen document's text with the run", async () => {
    mount();
    type("summarise the lecture");
    fireEvent.click(screen.getByTestId("ai.composer-attach"));

    const option = await screen.findByTestId("ai.attachment-option");
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId("ai.attachment-picker-confirm"));

    // The chip names what the message carries, and can be taken off again.
    const chip = await screen.findByTestId("ai.composer-attachment");
    expect(chip.textContent).toContain("lecture.pdf");
    expect(chip.getAttribute("data-attachment-id")).toBe(
      "0184a2b3c4d5e6f708192a3b4c5d6e7f",
    );

    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(agentStart).toHaveBeenCalledTimes(1));

    // Argument five is the attachments list (task, grant, language, history,
    // settings, attachments, ...). Asserting the POSITION is deliberate: a
    // shift here is what would silently send documents as the settings list.
    const call = agentStart.mock.calls[0]!;
    expect(call[5]).toEqual([
      { name: "lecture.pdf", text: "the lecture, in words" },
    ]);
    // And the task stays the user's words: the document is not spliced into it.
    expect(call[0]).toBe("summarise the lecture");
    expect(call[0]).not.toContain("the lecture, in words");
    // The chips are gone once the run has started.
    await waitFor(() => expect(screen.queryByTestId("ai.composer-attachment")).toBeNull());
  });

  it("keeps the message in the box when the file has no readable text", async () => {
    attachmentReadExtractedText.mockReset().mockResolvedValue(null);
    mount();
    type("summarise the lecture");
    fireEvent.click(screen.getByTestId("ai.composer-attach"));
    fireEvent.click(await screen.findByTestId("ai.attachment-option"));
    fireEvent.click(screen.getByTestId("ai.attachment-picker-confirm"));

    fireEvent.click(screen.getByTestId("ai.composer-send"));

    const error = await screen.findByTestId("ai.composer-attachment-error");
    expect(error.textContent).toContain("agent.attachments.noText");
    // Nothing was sent, and the typed message is still there to send again.
    expect(agentStart).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId("ai.composer-input") as HTMLTextAreaElement).value,
    ).toBe("summarise the lecture");
    // The chip stays, so the user can remove it rather than re-pick.
    expect(screen.getByTestId("ai.composer-attachment")).toBeTruthy();
  });
});

// ---- pasting a file into a conversation (myne-md/myne#913) ----------------
describe("ChatComposer: pasted files", () => {
  it("imports a pasted file as a chat attachment, not a library one", async () => {
    mount();
    const file = new File(["hello"], "image.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("ai.composer-input"), {
      clipboardData: { files: [file] },
    });

    // The scope is the whole point: a pasted file is stored encrypted and kept
    // out of the library, so it must be imported with `chat` and never with the
    // default. Asserting the argument is what keeps a refactor from silently
    // filing it in the library.
    await waitFor(() => expect(attachmentImport).toHaveBeenCalledTimes(1));
    expect(attachmentImport.mock.calls[0]![1]).toBe("chat");
    const chip = await screen.findByTestId("ai.composer-attachment");
    expect(chip.textContent).toContain("image.png");
  });

  it("does not swallow a paste that carries no file", () => {
    // Ordinary text paste must reach the textarea untouched: intercepting it
    // would mean typing a sentence into the box stops working.
    mount();
    const notPrevented = fireEvent.paste(screen.getByTestId("ai.composer-input"), {
      clipboardData: { files: [] },
    });
    // `fireEvent.paste` returns false when a handler called preventDefault.
    expect(notPrevented).toBe(true);
    expect(attachmentImport).not.toHaveBeenCalled();
  });
});

describe("ChatComposer: the scope names the note", () => {
  it("shows the note's name rather than the pointer", () => {
    // myne-md/myne#913: `Working on: This note` is a pointer, not a name. In a
    // pane running two notes side by side it does not say WHICH note the run is
    // about, and in a transcript read back later it says nothing at all.
    mount({ openNoteId: "n1", openNoteTitle: "Software Testing HW" });
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toBe(
      "Software Testing HW",
    );
  });

  it("falls back to the generic label when the caller has no name", () => {
    // A caller with no note set still has to render, so the fallback is not
    // dead code: it is the arm a test or an isolated surface takes.
    mount({ openNoteId: "n1", openNoteTitle: null });
    expect(screen.getByTestId("ai.composer-scope-value").textContent).toBe(
      "agent.composer.scopeOpenNote",
    );
  });
});
