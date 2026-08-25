// @vitest-environment jsdom
//
// The Properties widget's conditional `cover:` skip (myne-md/myne#410).
//
// BOTH directions live in this file on purpose. Either assertion alone passes
// while the feature is broken:
//
//   valid-is-hidden alone   → an unconditional skip also passes, and that ships
//                             a line that exists in the file and appears nowhere
//                             in the interface
//   invalid-is-shown alone  → no skip at all also passes, and that shows the raw
//                             `![[att:…]]` string under the banner that already
//                             draws it
//
// The pair is the test. The `title` row is asserted alongside as the control:
// it is the precedent this rule copies, and if it ever stops being skipped the
// two rules have drifted.

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { noteIdExtension } from "@myne/editor/note-identity";
import { describe, expect, it, vi } from "vitest";
import { setEditorHost, getHost } from "@myne/editor/host";
import { catalogField, type CatalogRow } from "../../src/editor/attachments/catalog";
import {
  ADD_COVER_TESTID,
  frontmatterDecorations,
} from "../../src/editor/decorations/frontmatter";

const ID = "a".repeat(64);

/** Render a document through the real Properties widget and return the KEYS of
 *  the generic key/value rows it drew. The key is the value of each row's key
 *  input, which is the widget's own representation of it. */
function renderedPropertyKeys(
  source: string,
  extra: readonly Extension[] = [],
): string[] {
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [...extra, frontmatterDecorations()],
    }),
  });
  try {
    const inputs = view.dom.querySelectorAll<HTMLInputElement>(
      ".cm-fm-properties-list .cm-fm-properties-key",
    );
    return Array.from(inputs, (el) => el.value);
  } finally {
    view.destroy();
  }
}

function fm(...lines: readonly string[]): string {
  return ["---", ...lines, "---", "", "body", ""].join("\n");
}

describe("the cover row in the Properties widget", () => {
  it("is hidden while the value is a valid cover", () => {
    const keys = renderedPropertyKeys(
      fm("title: Roadmap", "folder: Projects/", `cover: "![[att:${ID}|photo.png]]"`),
    );
    expect(keys).not.toContain("cover");
    // The control: `title` is promoted too, and its skip is the precedent.
    expect(keys).not.toContain("title");
    // And an ordinary property is untouched by any of this.
    expect(keys).toContain("folder");
  });

  it("is shown as an ordinary row when the value is not a valid cover", () => {
    const keys = renderedPropertyKeys(fm("title: Roadmap", "cover: true"));
    expect(keys).toContain("cover");
  });

  it("is shown for a bare attachment id, which the grammar rejects", () => {
    const keys = renderedPropertyKeys(fm(`cover: ${ID}`));
    expect(keys).toContain("cover");
  });

  it("is shown for two embeds, which the grammar rejects", () => {
    const keys = renderedPropertyKeys(
      fm(`cover: "![[att:${ID}|a.png]] ![[att:${"b".repeat(64)}|b.png]]"`),
    );
    expect(keys).toContain("cover");
  });

  it("stays hidden when the valid value carries a trailing comment", () => {
    const keys = renderedPropertyKeys(
      fm(`cover: "![[att:${ID}|photo.png]]" # chosen 2026-08`),
    );
    expect(keys).not.toContain("cover");
  });

  it("is SHOWN for a valid cover whose attachment has been deleted", () => {
    // The bug this guards against: the skip used to key on "the value is
    // valid", and a dangling cover is perfectly valid. The row was hidden AND
    // the banner drew nothing, so the line existed in the file and appeared
    // nowhere in the interface — exactly what the conditional skip exists to
    // prevent. The rule is "hide it iff something else is showing it".
    const loadedWithoutIt = catalogField.init(
      () => new Map<string, CatalogRow>(),
    );
    const keys = renderedPropertyKeys(
      fm("title: Roadmap", `cover: "![[att:${ID}|photo.png]]"`),
      [loadedWithoutIt],
    );
    expect(keys).toContain("cover");
  });

  it("is hidden again once the catalog carries the attachment", () => {
    // The other half of the same pair: same document, same grammar, different
    // catalog, opposite answer.
    const loadedWithIt = catalogField.init(
      () =>
        new Map<string, CatalogRow>([
          [
            ID,
            { id: ID, filename: "photo.png", contentType: "image/png", size: 1 } as CatalogRow,
          ],
        ]),
    );
    const keys = renderedPropertyKeys(
      fm("title: Roadmap", `cover: "![[att:${ID}|photo.png]]"`),
      [loadedWithIt],
    );
    expect(keys).not.toContain("cover");
  });
});

/** Render a document and return the "Add cover" control, if the widget drew one. */
function addCoverControl(source: string, readOnly = false): HTMLElement | null {
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [EditorState.readOnly.of(readOnly), frontmatterDecorations()],
    }),
  });
  try {
    return view.dom.querySelector(`[data-testid="${ADD_COVER_TESTID}"]`);
  } finally {
    view.destroy();
  }
}

describe("the Add cover control on the promoted title row", () => {
  it("is offered for a note with no cover", () => {
    expect(addCoverControl(fm("title: Roadmap"))).not.toBeNull();
  });

  it("is offered for a note whose cover value is invalid", () => {
    // The note has no usable cover, so the way to give it one must still be
    // there. Hiding it here would strand the user with a broken line and no
    // affordance.
    expect(addCoverControl(fm("title: Roadmap", "cover: true"))).not.toBeNull();
  });

  it("is withdrawn once the note has a valid cover", () => {
    // The banner's own Change control takes over. Two surfaces offering the
    // same thing is what the `title` promotion rule exists to avoid.
    expect(
      addCoverControl(fm("title: Roadmap", `cover: "![[att:${ID}|photo.png]]"`)),
    ).toBeNull();
  });

  it("asks the host for a picker that knows the note has no cover yet, and which note", () => {
    const openPicker = vi.fn();
    const host = getHost();
    setEditorHost({ ...host, cover: { openPicker, remove: vi.fn() } });
    try {
      const view = new EditorView({
        state: EditorState.create({
          doc: fm("title: Roadmap"),
          extensions: [noteIdExtension("note-a"), frontmatterDecorations()],
        }),
      });
      view.dom
        .querySelector(`[data-testid="${ADD_COVER_TESTID}"]`)
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      view.destroy();
    } finally {
      setEditorHost(host);
    }
    // `false`, so the picker does not offer Remove for a cover that is not there.
    // The id is myne-md/myne#520: this control `preventDefault`s on `mousedown`
    // for the same reason the banner's do, so the host cannot infer a target
    // from focus here either.
    expect(openPicker).toHaveBeenCalledWith(false, "note-a");
  });

  it("is absent on a read-only surface", () => {
    // Same contract as the banner's controls one file away (myne-md/myne#564,
    // applied in myne-md/myne#520's review): this control does not go through
    // the document, so `EditorState.readOnly` does not stop it by itself, and
    // the host it calls re-encrypts the note on disk. A reading mirror offering
    // "Add cover" is a write affordance on a surface documented as never
    // writing.
    expect(addCoverControl(fm("title: Roadmap"), true)).toBeNull();
  });

  it("is absent entirely when the host has no cover seam", () => {
    const host = getHost();
    setEditorHost({ ...host, cover: undefined });
    try {
      expect(addCoverControl(fm("title: Roadmap"))).toBeNull();
    } finally {
      setEditorHost(host);
    }
  });
});
