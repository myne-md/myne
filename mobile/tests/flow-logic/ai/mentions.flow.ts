// Flow-logic: a note mention in a phone chat answer opens that note
// (myne-md/myne#867), through the REAL EditorFlow boundary.
//
// Headless Chromium + mock IPC. NOT end-to-end: the agent never runs on this
// tier (the mock's `plugin:agent|agent_start` records the task and refuses with
// "FeatureOff"), so there is no live answer that could mention anything. The
// mention therefore arrives through a SEEDED transcript turn, read back by
// `chats_read` on mount.
//
// ── Why this file has to exist ─────────────────────────────────────────────
// `EditorFlow` builds the mention table from its own `resolverNotes` memo and
// passes it down beside an `onOpenNote` callback that routes to the screen's
// own `openNote`. Nothing else on this tier reaches either half at that screen
// boundary: `mobile/tests/components/AiChatFlow.test.tsx` hands the flow a
// `mentionTargets` array and an `onOpenNote` spy as PROPS, so removing either
// one at the call site leaves the whole mobile suite green while the phone
// renders the model's answer as flat text that opens nothing.
//
// So the assertions below go through the real wiring end to end: the target
// table is built by the screen from seeded notes, the link is rendered by the
// flow, and the press is the screen's own open-note path. What is asserted
// about the press is what the SCREEN does (the editor replaces the chat tab and
// shows the named note's body), not that an element with a testid appeared.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** The note the assistant turn names. Its title is deliberately long enough to
 *  have a prefix that reads like a name of its own. */
const NAMED = {
  id: "n1",
  text: "---\ntitle: Pixel 10 Graphene OS\n---\n\nHardened Android build notes.\n",
};

/** A second resident note the answer never names. It is seeded so the mention
 *  table the screen builds genuinely has more than one row to choose from. */
const UNNAMED = {
  id: "n2",
  text: "---\ntitle: Unrelated Note\n---\n\nNever named in any answer.\n",
};

const CONVERSATION = {
  id: "c1",
  created_at: 100,
  title: "Graphene",
  updated_at: 100,
  version: 1,
};

/** The answer names the first note, and it also carries the bare prefix
 *  `Pixel 10` on its own. That decoy is the point: the lookup is an exact-match
 *  one, so a string that is only a prefix of a real title stays plain text. A
 *  prefix turned into a link would put a note the model did not name one press
 *  away, which is the failure this whole surface exists to avoid. */
const ANSWER =
  "You filed it under Pixel 10 Graphene OS. The Pixel 10 lineup has its own note.";

const PAYLOAD = JSON.stringify({
  turns: [
    { id: "t1", kind: "text", role: "user", text: "Where is the phone note?" },
    { id: "t2", kind: "text", role: "assistant", text: ANSWER },
  ],
});

test.describe("phone note mentions", () => {
  test("links the named note only, and the press opens it in the editor", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      notes: [NAMED, UNNAMED],
      chats: { rows: [CONVERSATION], payloads: { c1: PAYLOAD } },
    });
    await page.goto("/");
    // Both notes are resident before the chat tab is opened, so the mention
    // table the screen builds has two titles to choose from and "exactly one of
    // them became a link" is a real discrimination rather than a truth about a
    // one-note vault.
    await expect(page.getByTestId("notes.row")).toHaveCount(2);
    await page.getByTestId("workspace.tab-chat").click();

    // Turns render oldest first, so the assistant turn is the second one.
    const assistant = page.getByTestId("ai.history-turn").nth(1);
    await expect(assistant).toContainText("Pixel 10 Graphene OS");
    // Non-vacuity for the prefix assertion below: the bare `Pixel 10` really is
    // in the answer, so "it stayed plain text" is a statement about the matcher
    // rather than about a fixture that never carried it.
    await expect(assistant).toContainText("The Pixel 10 lineup");

    const links = assistant.getByTestId("ai.mention-link");
    await expect(links).toHaveCount(1);
    // An exact list rather than a presence check, because "the prefix is not a
    // link" is a claim about what is ABSENT here. One element whose text is the
    // whole title proves both halves: the full name linked, and no shorter
    // candidate did.
    expect(await links.allTextContents()).toEqual(["Pixel 10 Graphene OS"]);
    // Stated for the second note as well, so a turn that later mentions it
    // fails with a message naming the note rather than as a list mismatch.
    await expect(links.filter({ hasText: "Unrelated Note" })).toHaveCount(0);

    // The press runs through `EditorFlow`'s own `openNote`, which binds the
    // screen's editing note and switches the compact view to the editor. On the
    // phone the editor REPLACES the chat tab, so all of these are one
    // behaviour: the top bar appears, the named note's body is in it, and the
    // chat surface is gone.
    await links.first().click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("Hardened Android build notes.");
    // Not the other resident note. A link that carried the wrong id, or a
    // handler that opened nothing at all, would fail one of the two lines here.
    await expect(page.locator(".cm-content")).not.toContainText("Never named in any answer.");
    await expect(page.getByTestId("ai.chat")).toHaveCount(0);
  });
});
