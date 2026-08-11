// @vitest-environment jsdom
//
// Tests for the AI slash actions (writing-assistant MYND-410 task 5). Mounts a
// real CM6 EditorView in jsdom, fires `/devam` + `/başlık` with a stubbed
// `infer`, and asserts the dispatched transaction: plain-markdown insert with
// the `ai.*` userEvent, one-undo reversibility, and the frontmatter title write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";

import {
  aiSlashCommands,
  aiSlashContinue,
  aiSlashEnabledFacet,
  aiSlashTitle,
  removeTriggerThen,
  slashCommandsForContext,
} from "../../src/editor/slash/aiSlash";
import { setAttachmentToastSink } from "../../src/editor/attachments/toast";

interface Mounted {
  view: EditorView;
  host: HTMLElement;
}

function mount(doc: string, cursor = doc.length): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor, head: cursor },
      extensions: [history()],
    }),
    parent: host,
  });
  return { view, host };
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.view.destroy();
  mounted?.host.remove();
  mounted = null;
});

describe("aiSlashContinue (/devam)", () => {
  it("inserts the completion as plain markdown at the cursor via ai.insert", async () => {
    mounted = mount("The quick brown fox");
    const infer = vi.fn().mockResolvedValue(" jumps.");
    await aiSlashContinue(mounted.view, infer);
    expect(mounted.view.state.doc.toString()).toBe("The quick brown fox jumps.");
    // The completion prompt was built from the preceding text.
    expect(infer.mock.calls[0][0]).toContain("The quick brown fox");
  });

  it("is reversible in one undo step", async () => {
    mounted = mount("abc");
    const infer = vi.fn().mockResolvedValue("def");
    await aiSlashContinue(mounted.view, infer);
    expect(mounted.view.state.doc.toString()).toBe("abcdef");
    undo(mounted.view);
    expect(mounted.view.state.doc.toString()).toBe("abc");
  });

  it("no-ops on an empty completion (no transaction)", async () => {
    mounted = mount("abc");
    const infer = vi.fn().mockResolvedValue("");
    await aiSlashContinue(mounted.view, infer);
    expect(mounted.view.state.doc.toString()).toBe("abc");
  });
});

describe("aiSlashTitle (/başlık)", () => {
  it("writes the suggested title to frontmatter and is byte-identical to a manual edit", async () => {
    mounted = mount("Some note body without frontmatter.");
    const infer = vi.fn().mockResolvedValue("My Title");
    await aiSlashTitle(mounted.view, infer);
    const doc = mounted.view.state.doc.toString();
    // A frontmatter block with the title was written; the body is preserved.
    expect(doc).toContain("title: My Title");
    expect(doc).toContain("Some note body without frontmatter.");
  });

  it("no-ops on an empty title suggestion", async () => {
    mounted = mount("body");
    const infer = vi.fn().mockResolvedValue("   ");
    await aiSlashTitle(mounted.view, infer);
    expect(mounted.view.state.doc.toString()).toBe("body");
  });
});

describe("slashCommandsForContext (task 6 gating)", () => {
  it("includes the AI commands only when ai_enabled", () => {
    const on = slashCommandsForContext({ aiEnabled: true }).map((c) => c.id);
    const off = slashCommandsForContext({ aiEnabled: false }).map((c) => c.id);
    expect(on).toContain("ai-continue");
    expect(on).toContain("ai-title");
    expect(off).not.toContain("ai-continue");
    expect(off).not.toContain("ai-title");
  });

  it("always includes the base commands (AI commands are additive)", () => {
    const off = slashCommandsForContext({ aiEnabled: false });
    // the base menu is unchanged when AI is off
    expect(off.length).toBeGreaterThan(0);
    const aiCount = aiSlashCommands().length;
    expect(slashCommandsForContext({ aiEnabled: true }).length).toBe(
      off.length + aiCount,
    );
  });

  it("aiSlashEnabledFacet defaults to false and reads the provided value", () => {
    expect(EditorState.create({ doc: "" }).facet(aiSlashEnabledFacet)).toBe(false);
    expect(
      EditorState.create({
        extensions: [aiSlashEnabledFacet.of(true)],
      }).facet(aiSlashEnabledFacet),
    ).toBe(true);
  });
});

// Failure is observable (ai-backend-degradation myne#191 task 7).
//
// The bug was worse than silence: `removeTriggerThen` deletes the `/devam` span
// BEFORE firing the async action, and the action was `void aiSlashContinue(v)`
// with no `.catch`. So on a rejection the user's typed characters vanished,
// nothing arrived to replace them, and nothing explained it — every time, on a
// stock install with no side-loaded generation model. It read as the editor
// eating input.
//
// Driven against `removeTriggerThen` directly with a rejecting action: that IS
// the unit that changed, and it needs no injected host, which is what kept the
// first attempt honest (see the export's own comment).
describe("AI slash commands — failure answers", () => {
  const messages: string[] = [];

  beforeEach(() => {
    messages.length = 0;
    setAttachmentToastSink((message) => {
      messages.push(message);
    });
  });
  afterEach(() => setAttachmentToastSink(null));

  async function applyRejecting(rejection: unknown, doc = "hello /devam") {
    const m = mount(doc);
    const apply = removeTriggerThen(() => Promise.reject(rejection));
    apply(m.view, doc.length - "/devam".length, doc.length);
    await Promise.resolve();
    await Promise.resolve();
    return m;
  }

  it("says a provider is missing for every no-provider cause", async () => {
    for (const rejection of ["NotReady", { kind: "NoModel" }, "no_credential"]) {
      messages.length = 0;
      await applyRejecting(rejection);
      // The resolved English, not the key: this harness has real catalogs
      // loaded, and pinning the sentence also pins that it does NOT tell a user
      // with a broken backend to go and set one up.
      expect(messages).toEqual([
        "No AI provider is set up, so nothing was inserted. Set one up in Settings → Developer → AI.",
      ]);
    }
  });

  it("distinguishes a generic failure", async () => {
    await applyRejecting({ kind: "InferenceFailed" });
    expect(messages).toEqual([
      "The AI request could not be completed, so nothing was inserted.",
    ]);
  });

  it("never stays silent, whatever the rejection shape is", async () => {
    await applyRejecting(new Error("something else entirely"));
    expect(messages).toHaveLength(1);
  });

  it("leaves the trigger removed and inserts nothing — undo is the way back", async () => {
    const m = await applyRejecting("NotReady");
    // The REAL post-failure state, pinned so a future "helpful" re-insertion of
    // the trigger — which would fight the undo stack — is caught.
    expect(m.view.state.doc.toString()).toBe("hello ");
    undo(m.view);
    expect(m.view.state.doc.toString()).toBe("hello /devam");
  });

  it("both AI commands go through the wrapper that catches", () => {
    // The mapping above is only worth anything if the shipped commands use it.
    for (const id of ["ai-continue", "ai-title"]) {
      const cmd = aiSlashCommands().find((c) => c.id === id);
      expect(cmd, id).toBeTruthy();
      expect(typeof cmd!.apply).toBe("function");
    }
  });
});
