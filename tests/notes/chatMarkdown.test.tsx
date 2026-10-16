// @vitest-environment jsdom
//
// Markdown in the AI transcript (myne-md/myne#771).
//
// A model's answer is written in markdown, always. The transcript rendered it
// as `white-space: pre-wrap` plain text, so a reader saw the asterisks around a
// heading, the backticks around an identifier and a numbered list as one
// run-on paragraph — on the surface whose own honesty note asks them to read
// the answer carefully.
//
// The security property is the half worth guarding hardest: the text is MODEL
// OUTPUT quoting NOTE CONTENT, two untrusted sources in one string, on a
// surface `threat-model.md` §7 treats as prompt-injection reachable. There is
// no path from a reply to markup in the DOM, by construction rather than by
// sanitisation — and "by construction" is a claim a test can hold.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatMarkdown } from "../../src/notes/ai/ChatMarkdown";
import { buildMentionTargets } from "../../src/notes/ai/noteMentions";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

afterEach(cleanup);

function md(text: string): HTMLElement {
  const { container } = render(<ChatMarkdown text={text} testId="md" />);
  return container.querySelector('[data-testid="md"]') as HTMLElement;
}

describe("the marks a model actually emits", () => {
  it("renders bold as an element, not as asterisks", () => {
    const el = md("**Development workflow orchestration** — a flowchart");
    expect(el.querySelector("strong")?.textContent).toBe(
      "Development workflow orchestration",
    );
    expect(el.textContent, "the markers are still on screen").not.toContain("**");
  });

  it("renders inline code, not backticks", () => {
    const el = md("It takes a `tf:drive` ticket");
    expect(el.querySelector("code")?.textContent).toBe("tf:drive");
    expect(el.textContent).not.toContain("`");
  });

  it("renders italics", () => {
    expect(md("a *scratch* note").querySelector("em")?.textContent).toBe("scratch");
  });

  it("renders a numbered list as a list", () => {
    // The reported case: a model's enumeration arrived as one paragraph with
    // "1." and "2." in the middle of it.
    const el = md("1. Self-hosting stack\n2. Development workflow");
    expect(el.querySelector("ol")).not.toBeNull();
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders a bulleted list as a list", () => {
    const el = md("- one\n- two\n- three");
    expect(el.querySelector("ul")).not.toBeNull();
    expect(el.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders a fenced block as preformatted text", () => {
    const el = md("```\ncargo test\n```");
    expect(el.querySelector("pre")?.textContent).toContain("cargo test");
  });

  it("wraps long lines inside a code block rather than scrolling sideways", () => {
    // A 280px panel is the narrowest surface in the app, and a horizontal
    // scrollbar inside a chat bubble is a thing nobody finds.
    const pre = md("```\nx\n```").querySelector("pre") as HTMLElement;
    expect(pre.style.whiteSpace).toBe("pre-wrap");
    expect(pre.style.overflowWrap).toBe("anywhere");
  });
});

describe("what it deliberately will not do", () => {
  it("renders no HTML from the model's text", () => {
    // The whole security argument. The parser has no HTML passthrough and this
    // renders a React token tree, so a reply carrying markup arrives as the
    // characters it was written as.
    const el = md('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(el.querySelector("img"), "a model injected an element").toBeNull();
    expect(el.querySelector("b"), "a model injected an element").toBeNull();
    expect(el.textContent).toContain("<img");
    expect(el.textContent).toContain("<b>bold</b>");
  });

  it("does not make a model's link clickable", () => {
    // A live link here is a model choosing where the user's browser goes, on a
    // surface a prompt injection can reach. The URL is shown as written.
    const el = md("see [the docs](https://example.test/x)");
    expect(el.querySelector("a"), "the model's link is navigable").toBeNull();
    expect(el.textContent).toContain("the docs");
  });

  it("does not turn a quoted wikilink into navigation", () => {
    // A model quoting `[[some note]]` is quoting. A bubble that moved the user
    // around their vault on a click would be the model doing the moving.
    const el = md("it references [[Project plan]]");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Project plan");
    expect(el.textContent).not.toContain("[[");
  });

  it("keeps a heading out of the document outline", () => {
    // A heading inside a chat bubble is not a document heading: joining the
    // page's outline would put a section a model invented between the panel's
    // own landmarks.
    const el = md("# Summary\n\nbody");
    expect(el.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(el.textContent).toContain("Summary");
  });
});

describe("it degrades rather than failing", () => {
  it("renders plain prose unchanged", () => {
    expect(md("just a sentence.").textContent).toBe("just a sentence.");
  });

  it("renders an empty string without throwing", () => {
    expect(md("").textContent).toBe("");
  });

  it("passes an unterminated mark through as text", () => {
    // A streamed answer is rendered mid-token on every frame, so half a bold
    // marker is not an edge case — it is every second frame of every reply.
    expect(md("**unterminated").textContent).toContain("**unterminated");
  });
});


// myne-md/myne#867. A model that says "your note is under X" is naming a note,
// and until this the name was exactly as clickable as the word "your". The
// boundary rules (what may NOT link) live in `noteMentions.test.ts`, where they
// need no DOM; what is here is the wiring between the matcher and the rendered
// bubble, in the two shapes the model actually writes.
describe("note mentions", () => {
  const NOTES: ResolverNote[] = [
    {
      noteUuid: "n-pixel",
      title: "Pixel 10 Graphene OS",
      folder: "Personal/Things I have/",
    },
  ];
  const targets = buildMentionTargets(NOTES);

  function withMentions(text: string) {
    const onOpenNote = vi.fn();
    const { container } = render(
      <ChatMarkdown
        text={text}
        testId="md"
        mentionTargets={targets}
        onOpenNote={onOpenNote}
      />,
    );
    return {
      el: container.querySelector('[data-testid="md"]') as HTMLElement,
      onOpenNote,
    };
  }

  it("links a mention the model wrote in BOLD, which is how it writes one", () => {
    const { el, onOpenNote } = withMentions(
      "Notunuz **Personal/Things I have/Pixel 10 Graphene OS** başlığı altında duruyor.",
    );
    const link = el.querySelector('[data-testid="ai.mention-link"]') as HTMLElement;
    expect(link.textContent).toBe("Personal/Things I have/Pixel 10 Graphene OS");
    fireEvent.click(link);
    expect(onOpenNote).toHaveBeenCalledWith("n-pixel");
  });

  it("links a wikilink whose target the vault holds", () => {
    const { el, onOpenNote } = withMentions("see [[Pixel 10 Graphene OS]]");
    const link = el.querySelector('[data-testid="ai.mention-link"]') as HTMLElement;
    expect(link.textContent).toBe("Pixel 10 Graphene OS");
    fireEvent.click(link);
    expect(onOpenNote).toHaveBeenCalledWith("n-pixel");
  });

  it("leaves an aliased wikilink plain, so a link never shows one name and opens another", () => {
    // myne-md/myne#867 review, D3: model output reachable by prompt injection
    // could otherwise write `[[Private/Bank|Summary of your trip]]`.
    const { el, onOpenNote } = withMentions("see [[Pixel 10 Graphene OS|that note]]");
    expect(el.querySelector('[data-testid="ai.mention-link"]')).toBeNull();
    expect(el.textContent).toContain("that note");
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it("leaves a wikilink the vault does not hold as its plain label", () => {
    const { el } = withMentions("see [[Some Other Note]]");
    expect(el.querySelector('[data-testid="ai.mention-link"]')).toBeNull();
    expect(el.textContent).toContain("Some Other Note");
  });

  it("with no note set, renders the sentence exactly as it did before", () => {
    // The pre-change contract, and the one every other caller still gets: no
    // note set means no link, not a broken one.
    const el = md("Under Personal/Things I have/Pixel 10 Graphene OS.");
    expect(el.querySelector('[data-testid="ai.mention-link"]')).toBeNull();
    expect(el.textContent).toBe("Under Personal/Things I have/Pixel 10 Graphene OS.");
  });
});
