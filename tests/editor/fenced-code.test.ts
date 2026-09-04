// @vitest-environment jsdom
//
// Fenced code-block card (MYND-154 task 4).
//   1. Pure-builder tests over `buildCodeBlockDecorations(state, focused)` —
//      the away vs editing vs unclosed decoration plan, deterministic without
//      driving real DOM focus.
//   2. jsdom mount smoke: the card renders (and the block decorations don't
//      throw at layout time), the badge shows the language, an unclosed fence
//      shows no card.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import {
  buildCodeBlockDecorations,
  fencedCodeDecorations,
} from "../../src/editor/decorations/fenced-code";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, anchor: number = doc.length): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head: anchor },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
        fencedCodeDecorations(),
      ],
    }),
    parent: host,
  });
  assertParsed(view);
  view.requestMeasure();
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

interface Classified {
  widgets: number;
  replaces: number;
  lineClasses: string[];
}

function classify(view: EditorView, focused: boolean): Classified {
  const set = buildCodeBlockDecorations(view.state, focused);
  const out: Classified = { widgets: 0, replaces: 0, lineClasses: [] };
  set.between(0, view.state.doc.length, (from, to, deco) => {
    const spec = deco.spec as { widget?: unknown; class?: string };
    if (spec.widget) out.widgets++;
    else if (from < to) out.replaces++;
    else out.lineClasses.push(spec.class ?? "");
  });
  return out;
}

const CLOSED = "```rust\nlet x = 1;\nlet y = 2;\n```";
const UNCLOSED = "```rust\nlet x = 1;\nstill open, must not become a card";

describe("buildCodeBlockDecorations — plan", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("away (unfocused): bar replaces the opening fence, body carded, closing fence hidden", () => {
    m = mount(CLOSED);
    const c = classify(m.view, false);
    expect(c.widgets).toBe(1); // card-top bar (carries the badge)
    expect(c.replaces).toBe(1); // closing fence hidden
    expect(c.lineClasses.length).toBe(2); // two body lines carded
    expect(c.lineClasses.some((cl) => cl.includes("cm-code-card-bottom"))).toBe(true);
  });

  it("editing (focused + cursor in block): no badge, no hidden fence, cards every line", () => {
    m = mount(CLOSED, 10); // anchor inside the body
    const c = classify(m.view, true);
    expect(c.replaces).toBe(0); // raw fence shown
    expect(c.widgets).toBe(0); // badge hidden
    expect(c.lineClasses.length).toBe(4); // open + 2 body + close, all carded
  });

  it("single body line (the common case, e.g. `pnpm install`): bar + one carded line + hidden close", () => {
    m = mount("```bash\npnpm install\n```");
    const c = classify(m.view, false);
    expect(c.widgets).toBe(1); // card-top bar
    expect(c.replaces).toBe(1); // closing fence hidden
    expect(c.lineClasses.length).toBe(1); // the single body line, carded
    expect(c.lineClasses[0]).toContain("cm-code-card-body");
  });

  it("unclosed fence: no card at all (no bleed)", () => {
    m = mount(UNCLOSED);
    const c = classify(m.view, false);
    expect(c.replaces).toBe(0);
    expect(c.widgets).toBe(0);
    expect(c.lineClasses.length).toBe(0);
  });
});

describe("fenced code card (jsdom mount)", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  // NOTE: jsdom has no layout, so CM's viewport is degenerate and interior
  // `.cm-line` rendering is unreliable here. These assert only the reliably-
  // rendered block-widget bar + badge and that mounting doesn't throw; body-
  // card structure is covered deterministically by the plan tests above.
  it("mounts a closed block without throwing and shows the card-top bar + badge", () => {
    m = mount(CLOSED);
    expect(m.host.querySelector(".cm-code-card-bar")).not.toBeNull();
    expect(m.host.querySelector(".cm-code-badge")!.textContent).toBe("rust");
  });

  it("shows the badge for a single-body-line block (the common case)", () => {
    m = mount("```bash\npnpm install\n```");
    expect(m.host.querySelector(".cm-code-badge")!.textContent).toBe("bash");
  });

  it("never mutates the document — card + badge are decorations, so source stays byte-stable", () => {
    m = mount(CLOSED);
    // The badge label ("rust") lives in a widget, never the buffer; the fence
    // markers are hidden by decoration, not deleted. Copy yields raw source.
    expect(m.view.state.doc.toString()).toBe(CLOSED);
  });

  it("renders no card for an unclosed fence", () => {
    m = mount(UNCLOSED);
    expect(m.host.querySelector(".cm-code-card-body")).toBeNull();
    expect(m.host.querySelector(".cm-code-badge")).toBeNull();
  });

  it("shows the raw info-string on the badge for an unknown language", () => {
    m = mount("```foober\nx\n```");
    const badge = m.host.querySelector(".cm-code-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("foober");
  });
});

describe("copy control (task 6, jsdom)", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("clicking Copy writes the INNER code only — no fence markers, no language tag, no badge", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    m = mount(CLOSED);
    const btn = m.host.querySelector(".cm-code-copy") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).not.toMatch(/```/); // no fence markers
    expect(copied).not.toContain("rust"); // no language tag
    expect(copied).toContain("let x = 1;");
    expect(copied).toContain("let y = 2;");
  });

  it("copies the inner code for a single-body-line block", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    m = mount("```bash\npnpm install\n```");
    (m.host.querySelector(".cm-code-copy") as HTMLButtonElement).click();
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).not.toMatch(/```/);
    expect(copied.trim()).toBe("pnpm install");
  });

  // The two below pin the button's FEEDBACK rather than its payload, and they
  // exist because myne-md/myne#390 moved this call off `navigator.clipboard` and
  // onto the host seam. Nothing was asserting the icon, so the transport could
  // have been rerouted into something that never resolves, or that swallows a
  // rejection differently, and every existing test here would still have passed:
  // they all read the write spy, which is upstream of the part the user sees.
  //
  // The code block is also one of the two surfaces this feature deliberately
  // does NOT convert to a toast. Its confirmation sits on the control that was
  // pressed, and its silence on refusal is intentional. Both are easy to "tidy
  // up" later by someone who does not know they were decided, so they are held
  // by a test rather than only by a comment.

  it("flips the icon to a check when the write lands", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    m = mount("```bash\npnpm install\n```");
    const btn = m.host.querySelector(".cm-code-copy") as HTMLButtonElement;

    expect(btn.classList.contains("cm-code-copy-done")).toBe(false);
    btn.click();
    await vi.waitFor(() => {
      expect(btn.classList.contains("cm-code-copy-done")).toBe(true);
    });
  });

  it("leaves the icon untouched when the write is refused", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    m = mount("```bash\npnpm install\n```");
    const btn = m.host.querySelector(".cm-code-copy") as HTMLButtonElement;

    btn.click();
    // Let the rejected promise settle before asserting, otherwise this passes
    // for the wrong reason: the icon has not flipped YET either way.
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(btn.classList.contains("cm-code-copy-done")).toBe(false);
  });
});
