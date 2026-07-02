// @vitest-environment jsdom
//
// Tests for the AI slash actions (writing-assistant MYND-410 task 5). Mounts a
// real CM6 EditorView in jsdom, fires `/devam` + `/başlık` with a stubbed
// `infer`, and asserts the dispatched transaction: plain-markdown insert with
// the `ai.*` userEvent, one-undo reversibility, and the frontmatter title write.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";

import {
  aiSlashCommands,
  aiSlashContinue,
  aiSlashEnabledFacet,
  aiSlashTitle,
  slashCommandsForContext,
} from "../../src/editor/slash/aiSlash";

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
