// Stories for the AI panels (myne-md/myne#832, task 14).
//
// These mount `AiChatTab`, which lives under `src/notes/components` rather than
// under the coverage guard's surface roots. The screenshot harness
// (`scripts/shot-ai-panels.mjs`) shoots `ai-panel/chat/default` from here, so the
// catalogue is the one fake-IPC host the desktop AI-panel shot uses.

import type { Fixture, StoryDescriptor } from "../types";
import { AiChatTab } from "@app/notes/components/AiChatTab";

const AI_FIXTURE: Fixture = {
  description: "AI enabled, one conversation with a user turn",
  handlers: {
    "plugin:prefs|prefs_read": () => ({ ai_enabled: true, ai_provider: null }),
    "plugin:chats|chats_list": () => [
      { id: "c1", created_at: 100, title: "Chat", updated_at: 100, version: 1 },
    ],
    "plugin:chats|chats_read": () => ({
      turns: [
        {
          id: "h1",
          kind: "text",
          role: "user",
          text: "can you translate this note?",
        },
      ],
    }),
  },
};

export const AI_STORIES: StoryDescriptor[] = [
  {
    id: "ai-panel/chat/default",
    group: "components",
    surface: "AiChatTab",
    state: "default",
    fixture: AI_FIXTURE,
    render: () => (
      <div style={{ width: 320, height: 800, display: "flex", background: "var(--bg-1)" }}>
        <AiChatTab openNoteId="n1" folders={[]} />
      </div>
    ),
  },
];
