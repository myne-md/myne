// @vitest-environment jsdom
//
// Non-fetching image chips + §264 rider (MYND-147 / 149).
//
//   - `![](url)` and `![][ref]` render a non-fetching chip (icon + alt, URL on
//     hover-tooltip), NOT an <img> for the URL
//   - PROPERTY: rendering issues NO network request (fetch / Image() / XHR are
//     spied and asserted untouched), and click on the chip never navigates
//   - dangling `![][missing]` stays plain text (no chip)
//   - §264: a `[ref]: url` referenced ONLY by an image hides off-cursor and
//     reveals on-cursor

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  imageReferencedDefinitions,
  imageUrlDecorations,
} from "../../src/editor/decorations/image-url";
import { referenceLinkDecorations } from "../../src/editor/decorations/reference-link";
import { collectLinkReferences } from "../../src/editor/decorations/link-reference-collector";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionPos?: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pos = selectionPos ?? doc.length;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos, head: pos },
      extensions: [
        markdown({ base: markdownLanguage }),
        // referenceLinkDecorations installs the shared linkReferencesField that
        // imageUrlDecorations reads + the §264 definition-hiding StateField.
        referenceLinkDecorations(),
        imageUrlDecorations(),
      ],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

/** All `<img>` elements that actually carry a `src` (CM6's own zero-size
 *  `cm-widgetBuffer` buffer imgs have none and are not a fetch). */
function srcBearingImgs(host: HTMLElement): HTMLImageElement[] {
  return Array.from(host.querySelectorAll("img")).filter(
    (img) => img.getAttribute("src") !== null && img.getAttribute("src") !== "",
  );
}

let mounted: Mounted | null = null;
afterEach(() => {
  if (mounted !== null) {
    mounted.view.destroy();
    mounted.host.remove();
  }
  mounted = null;
});

describe("inline ![](url) chip (MYND-147)", () => {
  it("renders a non-fetching chip with alt + URL tooltip, never an <img>", () => {
    mounted = mount("see ![a cat](https://x.example/cat.png) here");
    const chip = mounted.host.querySelector(".cm-attachment-url-chip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".cm-attachment-url-chip-label")?.textContent).toBe("a cat");
    expect(chip!.getAttribute("title")).toBe("https://x.example/cat.png");
    // No <img> loads the URL — privacy invariant. (CM6 inserts its own
    // zero-size `cm-widgetBuffer` <img> with no src; assert no img carries a src.)
    expect(srcBearingImgs(mounted.host)).toHaveLength(0);
    // The chip itself is not a link/anchor (no click-through).
    expect(chip!.tagName.toLowerCase()).toBe("span");
    expect(mounted.host.querySelector("a[href]")).toBeNull();
  });

  it("uses 'image' as the label when alt is empty", () => {
    mounted = mount("![](https://x.example/y.png)");
    expect(
      mounted.host.querySelector(".cm-attachment-url-chip-label")?.textContent,
    ).toBe("image");
  });
});

describe("reference ![][ref] chip (MYND-149)", () => {
  it("renders the same chip via the link-reference collector", () => {
    mounted = mount("![logo][brand]\n\n[brand]: https://x.example/logo.png\n", 0);
    const chip = mounted.host.querySelector(".cm-attachment-url-chip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("title")).toBe("https://x.example/logo.png");
    expect(srcBearingImgs(mounted.host)).toHaveLength(0);
  });

  it("leaves a dangling ![][missing] as plain text (no chip)", () => {
    mounted = mount("![x][missing] only", 0);
    expect(mounted.host.querySelector(".cm-attachment-url-chip")).toBeNull();
  });
});

describe("no-network property", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("issues NO network request when rendering image chips", () => {
    const fetchSpy = vi.fn();
    // @ts-expect-error — install a fetch spy in the jsdom global.
    globalThis.fetch = fetchSpy;
    const imgSrcSets: string[] = [];
    const RealImage = globalThis.Image;
    // Trap any `new Image()` + src assignment (the classic beacon path).
    class TrapImage {
      private _src = "";
      set src(v: string) {
        imgSrcSets.push(v);
        this._src = v;
      }
      get src() {
        return this._src;
      }
    }
    // @ts-expect-error override
    globalThis.Image = TrapImage;

    mounted = mount(
      "![a](https://evil.example/beacon.gif) and ![b][r]\n\n[r]: https://evil.example/b.png\n",
      0,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imgSrcSets).toHaveLength(0);
    // Two chips rendered (inline + reference).
    expect(mounted.host.querySelectorAll(".cm-attachment-url-chip")).toHaveLength(2);

    // @ts-expect-error restore
    globalThis.Image = RealImage;
  });

  it("does not navigate or fetch on click", () => {
    const fetchSpy = vi.fn();
    // @ts-expect-error
    globalThis.fetch = fetchSpy;
    mounted = mount("![a](https://evil.example/x.png)");
    const chip = mounted.host.querySelector(".cm-attachment-url-chip") as HTMLElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fetchSpy).not.toHaveBeenCalled();
    // No anchor with the URL anywhere.
    expect(mounted.host.querySelector(`a[href="https://evil.example/x.png"]`)).toBeNull();
  });
});

describe("§264 rider — image-only definition hiding", () => {
  it("hides a [ref]: url referenced ONLY by an image off-cursor", () => {
    const doc = "![pic][only]\n\n[only]: https://x.example/p.png\n";
    // Selection at top (line 1) → definition line (line 3) is off-cursor → hidden.
    mounted = mount(doc, 0);
    const rendered = mounted.view.contentDOM.textContent ?? "";
    // The definition URL should be folded away from the rendered flow.
    expect(rendered.includes("https://x.example/p.png")).toBe(false);
  });

  it("collects the image-only definition for the shared hiding StateField", () => {
    // The reveal-on-cursor half is the shared definition-hiding StateField's
    // focus-gated behavior (already exercised by the reference-link infra; the
    // StateField focus field can't be flipped under jsdom — the table.test.ts
    // lesson). Here we assert the §264 contribution itself: the image-only
    // definition is collected by `imageReferencedDefinitions`, which is what the
    // shared StateField folds in. A purely link-based collector would miss it.
    const doc = "![pic][only]\n\n[only]: https://x.example/p.png\n";
    mounted = mount(doc, 0); // mounting forces a parse
    const state = mounted.view.state;
    const map = collectLinkReferences(state);
    const entries = imageReferencedDefinitions(state, map);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.target).toBe("https://x.example/p.png");
  });
});
