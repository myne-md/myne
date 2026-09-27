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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatComposer } from "../../src/notes/components/ChatComposer";
import { clearAgentForLock, getAgent } from "../../src/notes/agent/agentStore";
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
  it("offers the scope control directly, not behind a disclosure", () => {
    // It used to render a caption plus a Change button, and pressing Change
    // replaced them with this same control — whose trigger you then pressed to
    // open the menu. Two clicks and a layout shift to reach a control that
    // already IS a disclosure (myne-md/myne#771).
    //
    // `design-notes/ai/0518` point 1 is what may not break: a
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
    // the mitigation `design-notes/ai/0515` names, not a nicety, so changing
    // how the picker is reached must not take the number with it.
    mount();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const option = screen
      .getAllByTestId("ai.composer-scope-option")
      .find((o) => o.getAttribute("data-value") === "Projects");
    fireEvent.click(option!);

    // The trigger names what was chosen — no second element to read it from.
    expect(screen.getByTestId("ai.composer-scope").textContent).toContain("Projects");
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
    expect(screen.queryByTestId("ai.composer-probe-at")).toBeNull();

    act(() => announce!({ attempt: 2, of: 3 }));
    expect(screen.getByTestId("ai.composer-probe-at").textContent).toContain(
      "agent.composer.checkingAt",
    );

    // **It is NOT on the button** (myne-md/myne#771). The label grew to
    // "Checking the model… (2/3)", and in a flex row with a `flex: 1` textarea
    // that collapsed the input to three characters wide mid-keystroke: the
    // user's own text squeezed out of the way by a status about the model. The
    // button keeps one label and gains a spinner; the count lives in a row
    // that already exists.
    expect(screen.getByTestId("ai.composer-send").textContent).not.toContain(
      "agent.composer.checkingAt",
    );

    // And it goes away when the probe does, rather than sticking on the last
    // attempt it happened to see.
    await act(async () => {
      settle!(PASSING);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByTestId("ai.composer-probe-at")).toBeNull(),
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
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const option = screen
      .getAllByTestId("ai.composer-scope-option")
      .find((o) => o.getAttribute("data-value") === "Projects");
    fireEvent.click(option!);
    await waitFor(() => expect(screen.getByTestId("ai.composer-scope-count")).toBeTruthy());
    // The size before sending, and what the excluded-folder clamp removed.
    // "Projects" is not a size (design-notes/ai/0515).
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
      <ChatComposer openNoteId={null} folders={folders} />,
    );
  }

  it("does not offer 'This note' when there is none", () => {
    noteless();
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    const labels = screen
      .getAllByTestId("ai.composer-scope-option")
      .map((o) => o.getAttribute("data-value"));
    expect(labels, "the open-note entry is still offered").not.toContain("");
    expect(labels).toEqual(["Projects", "Archive"]);
  });

  it("still offers it when there IS one", () => {
    // The gate is on the NOTE, not on the surface: the light panel has one
    // open almost always, and removing the entry there would take away the
    // common case's default.
    render(<ChatComposer openNoteId="n-1" folders={["Projects"]} />);
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    expect(
      screen.getAllByTestId("ai.composer-scope-option").map((o) => o.getAttribute("data-value")),
    ).toContain("");
  });

  it("names the choice rather than a value it does not have", () => {
    noteless();
    expect(screen.getByTestId("ai.composer-scope").textContent).not.toContain(
      "agent.composer.scopeOpenNote",
    );
  });

  it("says why Send is off, once there is something to send", () => {
    // A greyed button and nothing else reads as a broken app. A scope missing
    // while the box is EMPTY is not yet a problem, so the line waits for the
    // user to have typed — a scolding that arrives before the mistake is a
    // scolding about nothing.
    noteless();
    expect(screen.queryByTestId("ai.composer-needs-scope")).toBeNull();
    type("selam");
    expect(screen.getByTestId("ai.composer-needs-scope")).toBeTruthy();
    expect((screen.getByTestId("ai.composer-send") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("points the right WAY at the control it names", () => {
    // The sentence said "above" while the settings row sat under the composer:
    // they moved down in this same epic and the copy was written against where
    // they used to be. A direction in copy is a fact about the layout, and
    // nothing else in the tree compares the two — the string renders, the row
    // renders, and only a reader looking in the wrong place finds out.
    noteless();
    type("selam");
    const line = screen.getByTestId("ai.composer-needs-scope");
    const picker = screen.getByTestId("ai.composer-scope");
    const pickerIsBelow =
      (line.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // The catalog is stubbed to echo keys here, so the English wording is read
    // from `locales/en` directly: what is under test is that the word and the
    // DOM order agree, which a key alone cannot say.
    const english: string = JSON.parse(
      readFileSync(resolve(process.cwd(), "locales/en/common.json"), "utf8"),
    ).agent.composer.needsScope;
    expect(english.includes(pickerIsBelow ? "below" : "above"), english).toBe(true);
  });

  it("stops saying it once a folder is chosen, and Send comes alive", () => {
    noteless();
    type("selam");
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    fireEvent.click(
      screen
        .getAllByTestId("ai.composer-scope-option")
        .find((o) => o.getAttribute("data-value") === "Projects")!,
    );
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
  // opposite of the user-originated scope `design-notes/ai/0518` point 1
  // requires.

  function attachProjects(): void {
    fireEvent.click(screen.getByTestId("ai.composer-scope"));
    fireEvent.click(
      screen
        .getAllByTestId("ai.composer-scope-option")
        .find((o) => o.getAttribute("data-value") === "Projects")!,
    );
    expect(screen.getByTestId("ai.composer-scope").textContent).toContain("Projects");
  }

  it("drops the folder when a new conversation is started", () => {
    mount();
    attachProjects();
    act(() => {
      clearChat();
    });
    expect(screen.getByTestId("ai.composer-scope").textContent).not.toContain("Projects");
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
    expect(screen.getByTestId("ai.composer-scope").textContent).not.toContain("Projects");
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
    expect(screen.getByTestId("ai.composer-scope").textContent).toContain("Projects");
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
    expect(screen.getByTestId("ai.composer-scope").textContent).not.toContain("Projects");
  });
});
