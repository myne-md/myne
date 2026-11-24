// The agent pane's two views (myne-md/myne#771 task 6).
//
// One tab kind, two views. What this pins is the property the whole design rests
// on: the view is chosen by the workspace item's `agentView`, a Hub row that
// opens a conversation writes `focus` through the one writer, and a Hub tab with
// no `agentView` renders the Hub.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { mockSetAgentViewState, mockOpenInFocused, mockOpenNewTabInFocused, mockChatsList } =
  vi.hoisted(() => ({
    mockSetAgentViewState: vi.fn(),
    mockOpenInFocused: vi.fn(),
    mockOpenNewTabInFocused: vi.fn(),
    mockChatsList: vi.fn(),
  }));

vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    setAgentViewState: mockSetAgentViewState,
    openInFocused: mockOpenInFocused,
    // Where a note MENTION lands (myne-md/myne#867). A separate call from
    // `openInFocused` on purpose: the decision says a mention opens a new tab,
    // and this is the assertion that the agent tab routes it through the same
    // call the right panel does.
    openNewTabInFocused: mockOpenNewTabInFocused,
  }),
}));

vi.mock("../../src/notes/sidebarState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/sidebarState")>()),
  // The rail's anchor pill reads a note's NAME from the sidebar's cache
  // (myne-md/myne#848). The provider is not mounted here, and mounting the whole
  // sidebar to render a pane would be a different test.
  useSelectedNote: () => ({ cache: new Map() }),
}));

/** The vault's note set, as `useResolverNotes` reports it. Mutable, so a test
 *  can put a note in it without mounting a vault. Two consumers: the review
 *  card's title lookup and the mention matcher. */
let resolverNoteSet: import("../../src/notes/resolveWikilink").ResolverNote[] = [];
vi.mock("../../src/notes/resolverNotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/resolverNotes")>()),
  // A surface INPUT, the same reason the sidebar-state mock above exists:
  // mounting a vault to render a pane would be a different test.
  useResolverNotes: () => resolverNoteSet,
}));

vi.mock("../../src/lib/chats", () => ({
  // The roster notifier the wrappers fire (myne-md/myne#771). Mocked to a
  // no-op unsubscribe: what these files drive is the list, not the signal, and
  // a module mock that omits an export makes the importer throw at load.
  subscribeConversationRoster: () => () => {},
  chatsList: mockChatsList,
  chatsRename: vi.fn(),
  chatsDelete: vi.fn(),
}));

vi.mock("../../src/notes/ai/chatPersist", () => ({
  openConversation: vi.fn().mockResolvedValue("opened"),
  clearChatPersistForLock: vi.fn(),
  installChatPersistence: vi.fn(),
  hydrateActiveConversation: vi.fn(),
  isChatHydrateFailed: () => false,
  isChatPersistLagging: () => false,
  subscribeChatPersistHealth: () => () => {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/useDateTimeDisplay", () => ({
  useDateTimeDisplay: () => ({ locale: "en", timeZone: null }),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AgentPane } from "../../src/notes/agent/AgentPane";
import {
  beginRun,
  clearAgent,
  currentRunEpoch,
  settleApply,
  settleStep,
} from "../../src/notes/agent/agentStore";
import {
  appendChatToken,
  clearChat,
  finalizeChatTurn,
  getChat,
  markAgentTurnOutcome,
  sendAgentTurn,
  sendChatMessage,
  settleAgentTurn,
} from "../../src/notes/ai/chatStore";
import { AGENT_TAB_ID } from "../../src/notes/workspaceState";

beforeEach(() => {
  mockSetAgentViewState.mockReset();
  mockOpenInFocused.mockReset();
  mockOpenNewTabInFocused.mockReset();
  resolverNoteSet = [];
  mockChatsList.mockReset();
  mockChatsList.mockResolvedValue([]);
  clearAgent();
  // The chat store is module-scope too, so a test that seeds a transcript leaves
  // its turns for the next one: two `ai.agent-summary` nodes is how that reads.
  clearChat();
});

afterEach(() => cleanup());

describe("AgentPane: one screen, both columns", () => {
  // It was two views with a back control between them, and the tests below
  // used to assert which one was showing. There is one screen now
  // (`decisions/ai/0637`): the history rail beside the open conversation,
  // both mounted, at every width. The narrow arm hides one of them in CSS,
  // which is a fallback rather than a mode — so there is no `data-agent-view`
  // to assert on and nothing that "renders the Hub" as opposed to Focus.

  function paneAt(view?: { conversationId?: string; noteId?: string }) {
    return render(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          ...(view === undefined ? {} : { agentView: view }),
        }}
      />,
    );
  }

  it("follows the transcript to the bottom, and stops following once the reader scrolls up", () => {
    // **The stick-to-bottom wiring, which the review found pinned by nothing**
    // (myne-md/myne#894). The user reported the behaviour twice ("it does not
    // scroll down when a new message arrives", then "the chat stays where it is"),
    // and emptying the effect body left every test green. jsdom computes no layout,
    // so the box has to be given a height for the question to exist at all; and the
    // suite's own `ResizeObserver` stub is a no-op, so this installs a capturing one
    // for the duration of the test.
    const callbacks: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    class Capturing implements ResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(() => cb([], this));
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Capturing;

    try {
      const turnToken = sendChatMessage("q");
      appendChatToken(turnToken, "an answer");
      finalizeChatTurn(turnToken);
      paneAt({ conversationId: "c-1" });

      const scroller = screen.getByTestId("ai.transcript").parentElement;
      expect(scroller).not.toBeNull();
      let scrollTop = 0;
      Object.defineProperty(scroller, "scrollHeight", { value: 1_000, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true });
      Object.defineProperty(scroller, "scrollTop", {
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v;
        },
        configurable: true,
      });

      // A reader at the bottom is pulled to it when the content grows: firing the
      // observer's callback is what a real resize does. 200px short of the bottom
      // rather than exactly at it, because `pin` deliberately no-ops when the box
      // is already there (assigning `scrollTop` can itself fire another scroll).
      scrollTop = 200;
      act(() => {
        for (const cb of callbacks) cb();
      });
      expect(scrollTop).toBe(1_000);

      // And one who has scrolled up is left alone. The latch is recorded by the
      // scroller's own scroll event, which is the only thing that decides.
      scrollTop = 100;
      fireEvent.scroll(scroller!);
      act(() => {
        for (const cb of callbacks) cb();
      });
      expect(scrollTop).toBe(100);
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });

  it("reads the host's refusals BEFORE the model's claim (myne-md/myne#848)", () => {
    // **The ordering rule, asserted where both halves are siblings.** It used to
    // be asserted inside the review card, which worked while the card rendered the
    // summary too. The summary is now the turn's answer and the card mounts under
    // it, so a block inside the card would be read after the prose it contradicts:
    // the misreading `myne-md/myne#848` was fixed for (ten moves refused, the
    // summary reporting them as applied, believed). The block therefore renders in
    // the TURN, above `ai.agent-answer`, and this is the only place that ordering
    // can be seen.
    sendAgentTurn("selam", "All notes");
    settleAgentTurn({
      runId: "run-refused",
      summary: "Hepsini taşıdım.",
      edits: 1,
      newNotes: 0,
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      end: "finished",
      durationMillis: 500,
    });
    act(() => {
      beginRun(null);
      settleStep(
        {
          view: {
            runId: "run-refused",
            scopeTotal: 2,
            userGrants: 1,
            modelGrants: 0,
            cancelled: false,
          },
          proposal: {
            edits: [{ noteId: "n1", kind: "move", anchor: "", replacement: "Archive/" }],
            newNotes: [],
            summary: "Hepsini taşıdım.",
          },
          end: { kind: "finished" },
          iterations: 1,
          notesRead: 1,
          charsOffDevice: null,
          excludedCount: 0,
          memoryUpdated: 0,
        },
        currentRunEpoch(),
      );
      settleApply(
        {
          applied: 0,
          refused: [{ noteId: "n1", index: 0, reason: "moveIntoExcludedFolder" }],
          refusedNewNotes: [],
          notesWritten: [],
          notesCreated: [],
          restorePoints: [],
        },
        [],
        currentRunEpoch(),
      );
    });
    paneAt({ conversationId: "c-1" });

    const refusals = screen.getByTestId("agentReview.refusedBlock");
    const answer = screen.getByTestId("ai.agent-answer");
    expect(
      refusals.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And the card is still there, under the prose it belongs to.
    const card = screen.getByTestId("agentReview.screen");
    expect(
      answer.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("gives the settings and new-note clauses the same decision rule", () => {
    // **The two clauses the first version of this fix left behind** (myne-md/myne#894,
    // from review): `edits` learned the outcome verb and the settings and
    // new-note counts did not, so a rejected settings-only proposal still read
    // "1 setting changed." with nothing corrected beside it: a claim about a write
    // that never happened, on the line whose whole purpose is to say what did.
    // Injecting the pre-fix arm (`settingsChanged` unconditionally) left every
    // suite green, which is why this case exists.
    sendAgentTurn("selam", "All notes");
    settleAgentTurn({
      runId: "run-settings",
      summary: "ayarladım",
      edits: 0,
      newNotes: 1,
      settings: 1,
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      end: "finished",
      durationMillis: 500,
    });
    paneAt({ conversationId: "c-1" });
    const line = () => screen.getByTestId("ai.agent-summary").textContent ?? "";
    expect(line()).toContain("aiChat.agentTurn.newNotes");
    expect(line()).toContain("agent.review.settingsChanged");

    act(() => {
      markAgentTurnOutcome("run-settings", "rejected");
    });
    expect(line()).toContain("agent.review.rejectedNewNotes");
    expect(
      line(),
      "a rejected run must not report a setting as changed",
    ).toContain("agent.review.rejectedSettings");
    expect(line()).not.toContain("agent.review.settingsChanged");
  });

  it("says what the reader decided, not just what was proposed (myne-md/myne#894)", () => {
    // **The counts line's verb follows the decision.** "Proposed 3 changes." is
    // the approval stage's sentence; once the reader has acted, the same number
    // is a record of what happened, and the transcript has to say which, the
    // user's report on a turn whose card was long gone.
    //
    // Driven through the store rather than by rendering a hand-built summary,
    // because the WRITE is half the feature: the outcome lands on the turn that
    // names the run, wherever that turn is, and that is the arm under test.
    sendAgentTurn("selam", "All notes");
    settleAgentTurn({
      runId: "run-outcome",
      summary: "taşıdım",
      edits: 3,
      newNotes: 0,
      iterations: 1,
      notesRead: 2,
      charsOffDevice: null,
      end: "finished",
      durationMillis: 1_000,
    });
    paneAt({ conversationId: "c-1" });
    expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
      "editor.chrome.rightPanel.aiChat.agentTurn.proposed",
    );

    act(() => {
      markAgentTurnOutcome("run-outcome", "rejected");
    });
    expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
      "agent.review.rejectedCount",
    );

    // **A second decision is a no-op** (myne-md/myne#894, from review): the field
    // is monotone, which is what the specs say and what the merge's decided-wins
    // rule is commutative on. This asserted the opposite (last call wins) until a
    // review traced a partial apply plus the card's own Reject all to two devices
    // holding different decisions for one turn.
    act(() => {
      markAgentTurnOutcome("run-outcome", "applied");
    });
    expect(
      screen.getByTestId("ai.agent-summary").textContent,
      "the first decision stands",
    ).toContain("agent.review.rejectedCount");

    // A run the transcript does not know is left alone rather than crashing, and
    // the turn it does not name keeps the sentence it had.
    act(() => {
      markAgentTurnOutcome("run-elsewhere", "applied");
    });
    expect(screen.getByTestId("ai.agent-summary").textContent).toContain(
      "agent.review.rejectedCount",
    );
  });

  it("opens a note the conversation names, in a new tab (myne-md/myne#867)", () => {
    // **The wiring the agent tab never got.** `ChatMarkdown` renders a mention
    // as plain text unless its caller hands it candidates and somewhere to land,
    // and only the right panel's `AiChatTab` ever did: an answer naming a note
    // was unreadable-in-place in the surface whose whole output is the names of
    // notes. Read through the store, so this fails if the pane stops passing
    // either half, a target list with no callback renders plain text, which is
    // the exact state this test was written from.
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
    paneAt({ conversationId: "c-1" });

    const link = screen.getByTestId("ai.mention-link");
    expect(link.textContent).toBe("Personal/Things I have/Pixel 10 Graphene OS");
    fireEvent.click(link);
    // The decision's own call (`decisions/ai/0690`): a new tab, and the same one
    // the right panel makes, so a mention cannot mean two things.
    expect(mockOpenNewTabInFocused).toHaveBeenCalledWith("n-pixel");
  });

  it("leaves a name the vault does not hold as plain text", () => {
    // The other direction, so the assertion above cannot pass on any paragraph:
    // with no note set there is nothing to link.
    const token = sendChatMessage("q");
    appendChatToken(token, "Under Personal/Things I have/Pixel 10 Graphene OS.");
    finalizeChatTurn(token);
    paneAt({ conversationId: "c-1" });
    expect(screen.queryByTestId("ai.mention-link")).toBeNull();
  });

  it("pins the composer's scope when the view is anchored to a note", () => {
    // **The wiring, not the composer's own rule** (myne-md/myne#848): the pane's
    // view carries the conversation's anchor, and this is the assertion that the
    // anchor reaches the composer. A composer test can only prove the rule; a
    // pane that forgot to pass it would leave the picker on screen for exactly
    // the session the user asked it to disappear from.
    paneAt({ conversationId: "c-1", noteId: "n-9" });
    expect(screen.queryByTestId("ai.composer-scope")).toBeNull();
    cleanup();
    // And a vault-general view keeps it: there is a scope to choose.
    paneAt({ conversationId: "c-2" });
    expect(screen.getByTestId("ai.composer-scope")).toBeTruthy();
  });

  it("mounts the rail and the conversation together, both showing", () => {
    // `getByTestId` alone is not enough and an injection proved it: an element
    // that is `hidden`, or `display: none`, satisfies a presence query while
    // being exactly the one-column shape this screen replaced. What is asserted
    // is that neither column is suppressed — at wide widths the container query
    // does not fire, so anything hiding one is the component doing it.
    paneAt();
    for (const id of ["agent.rail", "agent.focus"]) {
      const el = screen.getByTestId(id);
      expect(el, `${id} is gone`).toBeTruthy();
      expect(el.hasAttribute("hidden"), `${id} is hidden`).toBe(false);
      expect(el.style.display, `${id} is display:none`).not.toBe("none");
    }
    // And the rail is the rail rather than an empty box: the class is what the
    // container query keys the narrow fallback off.
    expect(screen.getByTestId("agent.rail").className).toContain("myne-agent__rail");
  });

  it("does the same for a tab with nothing selected", () => {
    // A fresh conversation is a normal state, not an empty one: the old shape
    // refused to open Focus without a note, so "no selection" meant a list with
    // no way onward.
    paneAt();
    expect(screen.getByTestId("agent.pane").getAttribute("data-agent-conversation")).toBe("");
    expect(screen.getByTestId("agent.focus")).toBeTruthy();
  });

  it("carries the anchored note's link when the conversation has one", () => {
    paneAt({ noteId: "n-9" });
    expect(screen.getByTestId("agent.focus-open-note").getAttribute("data-note-id")).toBe("n-9");
  });

  it("exposes the open conversation to a scenario", () => {
    paneAt({ conversationId: "c-7" });
    expect(screen.getByTestId("agent.pane").getAttribute("data-agent-conversation")).toBe("c-7");
  });

  it("has no back control, because there is nowhere to go back to", () => {
    // The rail is beside the conversation. A back control here would return
    // the user to something already on screen.
    paneAt({ conversationId: "c-7" });
    expect(screen.queryByTestId("agent.focus-back")).toBeNull();
  });

  it("offers a rail toggle for the narrow arm, always mounted", () => {
    // The CSS decides whether it is VISIBLE — a container query on the pane,
    // not a viewport query, because a pane can be half a window. It is rendered
    // unconditionally so the header does not reflow when a pane is dragged
    // across the threshold.
    paneAt();
    const toggle = screen.getByTestId("agent.rail-toggle");
    expect(toggle.className).toContain("myne-agent__rail-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // `fireEvent`, not `.click()`: a bare DOM click outside React's event
    // system leaves the state update unbatched and this assertion reads the
    // pre-render attribute.
    fireEvent.click(toggle);
    expect(screen.getByTestId("agent.rail-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("agent.pane").getAttribute("data-rail")).toBe("open");
  });
});

describe("AgentPane: focus follows the conversation, not a view", () => {
  // Task 13 of myne-md/myne#771, re-aimed. Switching conversations replaces
  // the transcript subtree, so whatever the keyboard user was standing on is
  // unmounted and React hands focus back to `<body>` — outside the pane, with
  // the whole app behind them, their next Tab starting from the top of the
  // document. The same defect myne-md/myne#775 fixed on the ribbon's Escape
  // path; only the trigger changed when the two views became one screen.

  function paneAt(view?: { conversationId?: string; noteId?: string }) {
    return render(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          ...(view === undefined ? {} : { agentView: view }),
        }}
      />,
    );
  }

  it("does not take focus on first mount", () => {
    // Opening the tab must not steal the caret from whatever opened it — the
    // palette, the ribbon, a rail row. This is the half a naive "focus on
    // render" gets wrong, and the half a user would actually notice.
    paneAt();
    expect(document.activeElement).toBe(document.body);
  });

  it("takes focus when the open conversation changes under it", () => {
    const { rerender } = paneAt({ conversationId: "c-1" });
    rerender(
      <AgentPane
        paneId="p1"
        item={{ kind: "agent", id: AGENT_TAB_ID, agentView: { conversationId: "c-2" } }}
      />,
    );
    expect(document.activeElement, "the keyboard user was dropped on <body>").toBe(
      screen.getByTestId("agent.pane"),
    );
  });

  it("is focusable but not a Tab stop", () => {
    // A container in the tab order is a stop that does nothing, paid on every
    // pass through the pane.
    paneAt();
    expect(screen.getByTestId("agent.pane").getAttribute("tabindex")).toBe("-1");
  });

  it("names itself, since it is somewhere focus can land", () => {
    paneAt();
    expect(
      (screen.getByTestId("agent.pane").getAttribute("aria-label") ?? "").length,
    ).toBeGreaterThan(0);
  });
});

describe("AgentPane: New conversation clears the transcript, not just the state", () => {
  // The defect: it wrote the workspace state and nothing else. The tab forgot
  // which conversation it was showing while the CHAT STORE went on holding the
  // previous transcript — so the screen did not change and the button read as
  // broken, because it very nearly was.
  //
  // `tsc` is content, the state write happens, and a test that only checked
  // `setAgentViewState` would have passed against exactly this.

  it("clears the open transcript", async () => {
    sendChatMessage("an earlier question");
    expect(getChat().turns.length).toBeGreaterThan(0);

    render(
      <AgentPane paneId="p1" item={{ kind: "agent", id: AGENT_TAB_ID }} />,
    );
    // The rail loads its roster asynchronously, so the control is not there on
    // the first frame — it renders the loading line instead.
    fireEvent.click(await screen.findByTestId("agent.hub-new"));

    expect(getChat().turns, "the previous conversation is still on screen").toHaveLength(
      0,
    );
  });

  it("writes the workspace state too, so the tab forgets its selection", async () => {
    // Both halves. Clearing the store without dropping the selection would
    // leave the tab pointing at a conversation whose transcript is gone, and
    // the reopen effect would pull it straight back.
    render(
      <AgentPane
        paneId="p1"
        item={{ kind: "agent", id: AGENT_TAB_ID, agentView: { conversationId: "c-7" } }}
      />,
    );
    fireEvent.click(await screen.findByTestId("agent.hub-new"));
    expect(mockSetAgentViewState).toHaveBeenCalledWith("p1", {});
  });
});

describe("AgentPane: the pane's top row", () => {
  // The heading said "Agent" directly under a TAB that says "Agent", and the
  // band it sat in stayed there when it went — an empty flex row still takes
  // the parent's gap, so the rail would have started below a reserved strip of
  // blank pane that nothing on screen explains.

  function css(): string {
    return readFileSync(resolve(process.cwd(), "client-core/src/components.css"), "utf8");
  }

  it("names the region without printing the name", () => {
    render(<AgentPane paneId="p1" item={{ kind: "agent", id: AGENT_TAB_ID }} />);
    const pane = screen.getByTestId("agent.pane");
    // The accessible name is unchanged — it moved nowhere, it was always the
    // root's `aria-label`; what went is the visible restatement of it.
    expect(pane.getAttribute("aria-label")).toBe("agent.hub.title");
    const header = screen.getByTestId("agent.header");
    // The catalog is stubbed to echo keys, so the heading would be the literal
    // key here. Asserted on the header rather than the pane, because the key
    // is legitimately the root's `aria-label`.
    expect(header.textContent ?? "").not.toContain("agent.hub.title");
  });

  it("is hidden, because at wide widths it holds nothing", () => {
    // jsdom applies no stylesheet and resolves no container query, so this
    // reads the rule. The row holds only the narrow arm's rail toggle: the
    // heading went, and so did the run indicator. An empty flex item still
    // takes the parent's gap, so a row with nothing in it must not be a row.
    const text = css();
    expect(text, "the header has no resting display:none").toContain(
      ".myne-agent__header { display: none; }",
    );
    // The `data-agent-running` attribute stays, and nothing in CSS keys off
    // it: it is an E2E's observable, not a style hook. A rule that un-hid the
    // row for a live run is what made the whole pane shift down mid-run.
    expect(text, "a run un-hides the header again").not.toContain(
      "data-agent-running",
    );
    render(<AgentPane paneId="p1" item={{ kind: "agent", id: AGENT_TAB_ID }} />);
    const pane = screen.getByTestId("agent.pane");
    expect(pane.getAttribute("data-agent-running")).toBe(null);
    act(() => {
      beginRun(null);
    });
    expect(pane.getAttribute("data-agent-running")).toBe("true");
  });

  it("re-shows the row in the narrow arm, where the rail toggle is real", () => {
    // The toggle is the only way to the history below 560px. A header hidden
    // there would take the history with it, which is the one thing the narrow
    // fallback exists to avoid.
    const text = css();
    const narrow = text.indexOf("@container (max-width: 559px)");
    expect(narrow).toBeGreaterThan(-1);
    const arm = text.indexOf(".myne-agent__header {", narrow);
    expect(arm, "the narrow arm never un-hides the header").toBeGreaterThan(-1);
    const end = text.indexOf("\n}", arm);
    expect(text.slice(arm, end)).toContain("display: flex");
  });

  it("declares ONE inset, equal on all four sides", () => {
    // Three shapes have now shipped — `--space-4` against `--space-1`, then
    // `--space-1` all round, then `--space-3` against `0` — and the reason it
    // kept being got wrong is the test below this one, not this one.
    const text = css();
    const open = text.indexOf(".myne-agent {");
    const end = text.indexOf("\n}", open);
    const rule = text.slice(open, end);
    const padding = /padding:\s*([^;]+);/.exec(rule)?.[1]?.trim();
    expect(padding, "the pane declares no padding").toBeTruthy();
    // One value, and not zero: two values is the asymmetry, `0` is no inset.
    expect(padding!.split(/\s+/), padding).toHaveLength(1);
    expect(padding, padding).toMatch(/^var\(--space-[1-9]\)$/);
  });

  it("is the ONLY inset the pane gets, because PaneView adds no gutter", () => {
    // The finding two rounds of edits cost. `PaneView` wraps a tab body in
    // `0 24px` when its descriptor says `gutters: true` — the reading measure
    // a flowing note wants — and the agent tab took it. So the side inset on
    // screen was 24px whatever `.myne-agent` said, and editing that rule twice
    // changed nothing visible while both the code and its comment described a
    // value that was never reaching the screen.
    //
    // Nothing else in the tree compares the two: the descriptor typechecks,
    // the stylesheet is valid, and the pane renders. Read from the source
    // because the descriptor is a branch of a `useMemo` over a tab union that
    // a component test cannot reach a single arm of.
    const pane = readFileSync(
      resolve(process.cwd(), "src/notes/components/PaneView.tsx"),
      "utf8",
    );
    const at = pane.indexOf("<AgentPane");
    expect(at, "PaneView no longer mounts the agent pane").toBeGreaterThan(-1);
    // Back to the `return {` that owns it, then read that object's `gutters`.
    const open = pane.lastIndexOf("return {", at);
    expect(open, "the agent branch returns no descriptor").toBeGreaterThan(-1);
    const descriptor = pane.slice(open, at);
    const gutters = /gutters:\s*(true|false)/.exec(descriptor)?.[1];
    expect(gutters, descriptor).toBe("false");
  });
});
