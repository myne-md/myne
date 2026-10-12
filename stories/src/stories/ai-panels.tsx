// Stories for the AI panels (myne-md/myne#832, task 14).
//
// These mount `AiChatTab`, which lives under `src/notes/components` rather than
// under the coverage guard's surface roots. The screenshot harness
// (`scripts/shot-ai-panels.mjs`) shoots `ai-panel/chat/default` from here, so the
// catalogue is the one fake-IPC host the desktop AI-panel shot uses.

import { useEffect, useState } from "react";
import type { Fixture, StoryDescriptor } from "../types";
import { DEFAULT_PREFS } from "../../fixtures";
import { action } from "../actions";
import { AiChatTab } from "@app/notes/components/AiChatTab";
import { AgentHubList } from "@app/notes/agent/AgentHubList";
import { AgentPane } from "@app/notes/agent/AgentPane";
import { AgentConversationView } from "@app/notes/agent/AgentConversationView";
import { AgentFootprint } from "@app/notes/agent/components/AgentFootprint";
import { AgentProgress } from "@app/notes/agent/components/AgentProgress";
import { AgentReviewTakeover } from "@app/notes/agent/components/AgentReviewTakeover";
import { RunCostLine } from "@app/notes/agent/components/RunCostLine";
import { ScopeExpansionDialog } from "@app/notes/agent/components/ScopeExpansionDialog";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";
import { AGENT_TAB_ID } from "@app/notes/workspaceState";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  markConversationUnread,
  openRun,
  settleStep,
} from "@app/notes/agent/agentStore";

const AI_FIXTURE: Fixture = {
  description: "AI enabled, one conversation with a user turn",
  handlers: {
    // **`DEFAULT_PREFS` first, then the two this fixture is about** (review
    // finding): a hand-rolled partial answers every OTHER pref as `undefined`, so
    // a component reading one of them throws where the real host would not. It
    // cost this catalogue two stories when the hub started reading
    // `ai_excluded_folders` (an `undefined.length` inside `isNoteAiExcluded`).
    "plugin:prefs|prefs_read": () => ({
      ...DEFAULT_PREFS,
      ai_enabled: true,
      ai_provider: null,
    }),
    // Without this the fake host answers `{}` (its benign default for an
    // unhandled command), `aiCapabilityReport` reads that as `compiled: false`,
    // and the story rendered the "compiled without local AI" empty state
    // instead of the chat it exists to show, including for the user-guide
    // screenshot taken from this same story (myne-md/myne#843).
    "plugin:local-inference|ai_capability_report": () => ({
      compiled: true,
      backendId: "in-process",
      backendClass: "in_process_local",
      generation: { available: true, cause: null },
      embedding: { available: true, cause: null },
      transcription: { available: true, cause: null },
      autoTag: { available: true, cause: null },
      indexReady: true,
    }),
    "plugin:chats|chats_list": () => [
      { id: "c1", created_at: 100, title: "Chat", updated_at: 100, version: 1 },
    ],
    // **A JSON STRING, which is what the command returns** (myne-md/myne#848).
    // This answered with the decoded object, and `parseTranscript` hands its
    // argument to `JSON.parse`, so the coercion threw, the hydrate read the
    // transcript as unreadable, and the story rendered an EMPTY chat while its
    // own description claimed a conversation. The two turns below are what the
    // transcript looks like: the speaker, the words, and the copy control on
    // each turn.
    "plugin:chats|chats_read": () =>
      JSON.stringify({
        turns: [
          {
            id: "h1",
            kind: "text",
            role: "user",
            text: "can you translate this note?",
          },
          {
            id: "h2",
            kind: "text",
            role: "assistant",
            text: "Here it is: \"the mitochondria is the powerhouse of the cell\".",
            answeredBy: { kind: "local" },
          },
        ],
      }),
  },
};

/** A vault with three conversations, for the rail: a note-anchored one, a
 *  vault-general one, and one whose run finished while nobody was looking. */
const HUB_FIXTURE: Fixture = {
  ...AI_FIXTURE,
  description: "three conversations, one of them with an unread result",
  handlers: {
    ...AI_FIXTURE.handlers,
    "plugin:chats|chats_list": () => [
      {
        id: "c1",
        created_at: 300,
        updated_at: 300,
        title: "bu yazıyı bana özetler misin",
        version: 1,
        note_id: "n1",
      },
      {
        id: "c2",
        created_at: 200,
        updated_at: 200,
        title: "inbox'ımdaki notları organize et",
        version: 1,
      },
      {
        id: "c3",
        created_at: 100,
        updated_at: 100,
        title: "selam",
        version: 1,
      },
    ],
    "plugin:notes|note_list": () => ["n1"],
  },
};

/** The hub, with one conversation marked unread.
 *
 *  Seeded on mount and cleared on unmount, the same rule `SeededReview` states:
 *  a module-scope mark left behind would put a dot on the next story's cards. */
function SeededHub() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    markConversationUnread("c3");
    setReady(true);
    return () => clearAgentForLock();
  }, []);
  if (!ready) return null;
  return (
    <div style={{ width: 300, height: 420, background: "var(--bg-1)" }}>
      <AgentHubList
        activeConversationId="c1"
        onOpenFocus={action("onOpenFocus")}
        onNewConversation={action("onNewConversation")}
        onOpenNote={action("onOpenNote")}
      />
    </div>
  );
}

/** The live-run strip, with a run parked on a scope question.
 *
 *  The strip is derived from the run store, so it does not exist without a run
 *  to describe, see the wrapper's own note on seeding. */
function SeededProgress() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    beginRun(null);
    openRun(
      { runId: "story-run", scopeTotal: 12, userGrants: 1, modelGrants: 0, cancelled: false },
      currentRunEpoch(),
    );
    settleStep(
      {
        view: {
          runId: "story-run",
          scopeTotal: 12,
          userGrants: 1,
          modelGrants: 0,
          cancelled: false,
        },
        proposal: { edits: [], newNotes: [], summary: "" },
        end: { kind: "awaitingScope", folder: "Projects", reason: "to find the notes" },
        iterations: 2,
        notesRead: 3,
        charsOffDevice: null,
        excludedCount: 0,
        memoryUpdated: 0,
      },
      currentRunEpoch(),
    );
    setReady(true);
    return () => clearAgentForLock();
  }, []);
  if (!ready) return null;
  return (
    <div style={{ width: 320, background: "var(--bg-1)" }}>
      <AgentProgress />
    </div>
  );
}

/** The review screen as it mounts in the app: a portal over everything. */
function SeededTakeover() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    beginRun(null);
    settleStep(
      {
        view: {
          runId: "story-run",
          scopeTotal: 431,
          userGrants: 1,
          modelGrants: 0,
          cancelled: false,
        },
        proposal: {
          edits: [
            {
              noteId: "n1",
              kind: "move",
              anchor: "",
              replacement: "02 - AREAS/Self Improvement/",
            },
          ],
          newNotes: [],
          summary:
            "Analyzed all 23 notes in 00 - INBOX/ and rehomed each according to your PARA structure.",
        },
        end: { kind: "finished" },
        iterations: 2,
        notesRead: 23,
        charsOffDevice: null,
        excludedCount: 0,
        memoryUpdated: 0,
      },
      currentRunEpoch(),
    );
    setReady(true);
    return () => clearAgentForLock();
  }, []);
  if (!ready) return null;
  return (
    <AgentReviewTakeover
      titleOf={() => "00 - INBOX"}
      folderOf={() => "00 - INBOX/"}
      onNotesWritten={action("onNotesWritten")}
    />
  );
}

export const AI_STORIES: StoryDescriptor[] = [
  {
    id: "ai-panel/chat/default",
    group: "components",
    surface: "AiChatTab",
    state: "default",
    description: "Ai Chat Tab, a default state.",
    tags: ["components", "aichattab", "default"],
    fixture: AI_FIXTURE,
    render: () => (
      <div style={{ width: 320, height: 800, display: "flex", background: "var(--bg-1)" }}>
        <AiChatTab openNoteId="n1" folders={[]} />
      </div>
    ),
  },
  {
    id: "ai-panel/agenthublist/cards",
    group: "components",
    surface: "AgentHubList",
    state: "cards",
    description:
      "The rail: a note-anchored conversation (its chip names the NOTE rather than saying \"On a note\"), a vault-general one, the open card marked with an inset accent ring, a separator between rows rather than a box around each, and an unread dot on the conversation whose run finished while nobody was looking.",
    tags: ["notes", "ai", "agent", "hub", "rail", "unread", "card"],
    fixture: HUB_FIXTURE,
    render: () => (
      <SidebarStateProvider>
        <WorkspaceProvider>
          <SeededHub />
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "ai-panel/agentfootprint/working",
    group: "components",
    surface: "AgentFootprint",
    state: "working",
    description:
      "A run in flight, ON ITS OWN TURN: the robot and \"Working\" breathe as one wave, the elapsed figure ticks, and the figures behind it are one press away rather than a strip pinned to the panel.",
    tags: ["notes", "ai", "agent", "footprint", "working", "motion"],
    render: () => (
      <div style={{ width: 420, background: "var(--bg-1)", padding: "var(--space-3)" }}>
        <AgentFootprint
          settledLabel={null}
          durationMillis={null}
          startedAtMillis={Date.now() - 13_000}
          figures={{ iterations: 2, notesRead: 6, charsOffDevice: 107_458, memoryUpdated: 0 }}
          scopeTotal={431}
          userGrants={1}
          modelGrants={1}
        />
      </div>
    ),
  },
  {
    id: "ai-panel/agentfootprint/settled",
    group: "components",
    surface: "AgentFootprint",
    state: "settled",
    description:
      "The same line once the run has stopped: what ended, how long it took, and the figures a reader can open. The stop reason comes from the run's own end tag, so a run that stalled reads differently from one that finished.",
    tags: ["notes", "ai", "agent", "footprint", "settled", "summary"],
    render: () => (
      <div style={{ width: 420, background: "var(--bg-1)", padding: "var(--space-3)" }}>
        <AgentFootprint
          settledLabel="Finished"
          durationMillis={14_000}
          figures={{ iterations: 4, notesRead: 23, charsOffDevice: null, memoryUpdated: 1 }}
        />
      </div>
    ),
  },
  {
    id: "ai-panel/runcostline/default",
    group: "components",
    surface: "RunCostLine",
    state: "default",
    description:
      "What a run cost, in one line: model round-trips, notes read, and the characters of note text that left the device, the figure the remote arm's disclosure rests on, and \"stayed on this device\" when none did.",
    tags: ["notes", "ai", "agent", "cost", "disclosure", "summary"],
    render: () => (
      <div style={{ padding: "var(--space-3)", color: "var(--fg-2)" }}>
        <RunCostLine iterations={4} notesRead={23} charsOffDevice={107_458} testId="story.run-cost" />
      </div>
    ),
  },
  {
    id: "ai-panel/scopexpansiondialog/asking",
    group: "components",
    surface: "ScopeExpansionDialog",
    state: "asking",
    description:
      "The model asked to widen its scope, and this is the whole of what stands between it and the wider scope: the folder, how many notes it adds, what the clamp already removed, and where the text goes if the user allows it.",
    tags: ["notes", "ai", "agent", "scope", "consent", "dialog"],
    render: () => (
      <div style={{ background: "var(--bg-1)", padding: "var(--space-4)" }}>
        <ScopeExpansionDialog
          folder="Projects"
          noteCount={12}
          excludedCount={2}
          newTotal={431}
          reason="to find the notes you described"
          arm="none"
          onApprove={action("onApprove")}
          onDecline={action("onDecline")}
        />
      </div>
    ),
  },
  {
    id: "ai-panel/agentprogress/parked-on-scope",
    group: "components",
    surface: "AgentProgress",
    state: "parked-on-scope",
    description:
      "The live run's strip, outside the transcript: the running scope total, the Stop control, and the scope question it is parked on. A run in flight is the state, so it is seeded rather than passed in.",
    tags: ["notes", "ai", "agent", "progress", "running", "scope"],
    fixture: HUB_FIXTURE,
    render: () => <SeededProgress />,
  },
  {
    id: "ai-panel/agentreviewtakeover/over-everything",
    group: "components",
    surface: "AgentReviewTakeover",
    state: "over-everything",
    description:
      "The review screen as the app mounts it: a portal into the body, so it paints over the whole window and nothing behind it can take a click or the wheel.",
    tags: ["notes", "ai", "agent", "review", "takeover", "portal"],
    render: () => <SeededTakeover />,
  },
  {
    id: "ai-panel/agentconversationview/focus",
    group: "components",
    surface: "AgentConversationView",
    state: "focus",
    description:
      "One conversation, with the rail beside it: the anchor chip that opens the note the conversation is about, the transcript, and the composer under it.",
    tags: ["notes", "ai", "agent", "conversation", "transcript", "composer"],
    fixture: HUB_FIXTURE,
    render: () => (
      <SidebarStateProvider>
        <WorkspaceProvider>
          <div style={{ width: 460, height: 560, background: "var(--bg-1)" }}>
            <AgentConversationView
              noteId="n1"
              conversationId="c1"
              folders={["Projects/"]}
              onNotesWritten={action("onNotesWritten")}
            />
          </div>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "ai-panel/agentpane/screen",
    group: "components",
    surface: "AgentPane",
    state: "screen",
    description:
      "The agent tab: the rail and the conversation on one screen, both mounted at every width, with the view chosen by the workspace item rather than by a second switch.",
    tags: ["notes", "ai", "agent", "pane", "rail", "screen"],
    fixture: HUB_FIXTURE,
    render: () => (
      <SidebarStateProvider>
        <WorkspaceProvider>
          <div style={{ width: 900, height: 620, background: "var(--bg-1)" }}>
            <AgentPane
              paneId="p1"
              item={{ kind: "agent", id: AGENT_TAB_ID }}
              folders={["Projects/"]}
            />
          </div>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
];
