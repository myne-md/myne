// @vitest-environment jsdom
//
// Frontmatter Properties widget (MYND-141): the block-replace decoration plus
// the editable widget's commit logic. Drives the rendered title / key / value
// inputs + "+ Add property" button against a live frontmatter doc and asserts
// the surgical, byte-stable CM changes each commit dispatches — the rename-key
// guards (empty / invalid / collision), value rewrite, title escape + add,
// add-property, and the no-frontmatter / malformed → no-decoration cases.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [frontmatterDecorations()],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) {
    m.view.destroy();
    m.host.remove();
  }
  m = null;
});

const widget = (mm: Mounted) =>
  mm.host.querySelector(".cm-fm-properties") as HTMLElement | null;
const titleInput = (mm: Mounted) =>
  mm.host.querySelector(".cm-fm-properties-name") as HTMLInputElement;
const keyInputs = (mm: Mounted) =>
  Array.from(
    mm.host.querySelectorAll<HTMLInputElement>(".cm-fm-properties-key"),
  );
const valueInputs = (mm: Mounted) =>
  Array.from(
    mm.host.querySelectorAll<HTMLInputElement>(".cm-fm-properties-value"),
  );

const fire = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("change"));
};

describe("frontmatter widget: presence", () => {
  it("renders the Properties widget for a frontmatter doc", () => {
    m = mount("---\ntitle: Hi\nstatus: draft\n---\nbody\n");
    expect(widget(m)).not.toBeNull();
    // `title` is promoted to the title field, not duplicated as a row.
    expect(keyInputs(m).map((i) => i.value)).toEqual(["status"]);
    expect(titleInput(m).value).toBe("Hi");
  });

  it("keeps the note title out of the key/value block", () => {
    // The frontmatter block was drawn as one bordered table for a round
    // (myne-md/myne#773) and the border is withdrawn: at the head of every
    // note with frontmatter it competed with the prose it introduces, which
    // is the thing a reader is there for.
    //
    // What the border was holding together is still true and still worth a
    // test, which is why this is narrowed rather than deleted: the note title
    // is the NOTE's, not a row of its frontmatter, so it must not be inside
    // the properties list however that list is drawn next.
    m = mount("---\ntitle: Hi\nstatus: draft\n---\nbody\n");
    const list = m.host.querySelector(".cm-fm-properties-list");
    expect(list, "no properties list").not.toBeNull();
    expect(
      list!.querySelector(".cm-fm-properties-name"),
      "the note title belongs to the note, not to its frontmatter rows",
    ).toBeNull();
    // And it is on screen — outside the list, not absent, which is the other
    // way this assertion can be satisfied by a defect.
    expect(titleInput(m).value).toBe("Hi");
  });

  it("a doc with no frontmatter renders no widget", () => {
    m = mount("just body text\nno yaml here\n");
    expect(widget(m)).toBeNull();
  });

  it("a `---` block NOT anchored at line 1 is not frontmatter (no widget)", () => {
    // Frontmatter is line-1-anchored; a delimiter after a blank line is a plain HR.
    m = mount("\n---\ntitle: x\n---\nbody\n");
    expect(widget(m)).toBeNull();
  });

  it("an unterminated frontmatter block (no closing ---) renders no widget", () => {
    m = mount("---\ntitle: x\nstatus: draft\n");
    expect(widget(m)).toBeNull();
  });
});

describe("frontmatter widget: value commit", () => {
  it("editing a value rewrites only the value bytes", () => {
    m = mount("---\ntitle: Hi\nstatus: draft\n---\nbody\n");
    const v = valueInputs(m)[0];
    expect(v.value).toBe("draft");
    fire(v, "published");
    expect(m.view.state.doc.toString()).toBe(
      "---\ntitle: Hi\nstatus: published\n---\nbody\n",
    );
  });

  it("a no-op value commit (unchanged) dispatches nothing", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const before = m.view.state.doc.toString();
    fire(valueInputs(m)[0], "draft");
    expect(m.view.state.doc.toString()).toBe(before);
  });
});

describe("frontmatter widget: key rename guards", () => {
  it("renames a key in place", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    fire(keyInputs(m)[0], "state");
    expect(m.view.state.doc.toString()).toBe("---\nstate: draft\n---\nbody\n");
  });

  it("rejects an empty key (reverts, no write)", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const before = m.view.state.doc.toString();
    fire(keyInputs(m)[0], "   ");
    expect(m.view.state.doc.toString()).toBe(before);
  });

  it("rejects a non-simple key (spaces / punctuation)", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const before = m.view.state.doc.toString();
    fire(keyInputs(m)[0], "not valid!");
    expect(m.view.state.doc.toString()).toBe(before);
  });

  it("rejects a rename that collides with another existing key", () => {
    m = mount("---\nstatus: draft\npriority: high\n---\nbody\n");
    const before = m.view.state.doc.toString();
    // Rename `status` → `priority` would duplicate the key.
    fire(keyInputs(m)[0], "priority");
    expect(m.view.state.doc.toString()).toBe(before);
  });
});

describe("frontmatter widget: add property", () => {
  it("'+ Add property' inserts a fresh empty property into the YAML body", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const addBtn = m.host.querySelector(
      ".cm-fm-properties-add",
    ) as HTMLButtonElement;
    addBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(m.view.state.doc.toString()).toBe(
      "---\nstatus: draft\nproperty: \n---\nbody\n",
    );
  });

  it("'+ Add property' avoids a name collision by numbering", () => {
    m = mount("---\nproperty: a\n---\nbody\n");
    const addBtn = m.host.querySelector(
      ".cm-fm-properties-add",
    ) as HTMLButtonElement;
    addBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(m.view.state.doc.toString()).toContain("property1: ");
  });
});

describe("frontmatter widget: title commit", () => {
  it("editing the title rewrites the FM `title:` value (YAML-escaped)", () => {
    m = mount("---\ntitle: Old\n---\nbody\n");
    // A title containing a colon must be quoted by formatYamlScalar.
    fire(titleInput(m), "New: subtitle");
    const doc = m.view.state.doc.toString();
    expect(doc).toContain('title: "New: subtitle"');
  });

  it("inserts a `title:` line when the frontmatter has none", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    fire(titleInput(m), "Fresh Title");
    const doc = m.view.state.doc.toString();
    expect(doc).toContain("title: Fresh Title");
    expect(doc.startsWith("---\ntitle: Fresh Title\nstatus: draft\n---")).toBe(true);
  });

  it("an empty title commit reverts visually and writes nothing", () => {
    m = mount("---\ntitle: Keep\n---\nbody\n");
    const before = m.view.state.doc.toString();
    const t = titleInput(m);
    fire(t, "   ");
    expect(m.view.state.doc.toString()).toBe(before);
    expect(t.value).toBe("Keep"); // reverted to the previous display
  });

  it("the title field decodes a quoted on-disk scalar for display", () => {
    m = mount('---\ntitle: "Quoted: value"\n---\nbody\n');
    expect(titleInput(m).value).toBe("Quoted: value");
  });
});

describe("frontmatter widget: input keyboard behaviour", () => {
  const keydown = (el: HTMLInputElement, key: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  it("Enter on a value input preventDefaults and blurs (commit rides change-on-blur)", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const v = valueInputs(m)[0];
    v.focus();
    expect(document.activeElement).toBe(v);
    v.value = "shipped";
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    v.dispatchEvent(ev);
    // The handler swallows Enter (no newline inserted into the field) and blurs
    // it; the value commit itself is the browser's native change-on-blur, which
    // jsdom does not synthesize — so we assert the handler's own effects.
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(v);
  });

  it("Escape on a value input reverts the field and writes nothing", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const before = m.view.state.doc.toString();
    const v = valueInputs(m)[0];
    v.value = "garbage";
    keydown(v, "Escape"); // resets v.value to the original, then blurs
    expect(v.value).toBe("draft");
    expect(m.view.state.doc.toString()).toBe(before);
  });

  it("Escape on a key input reverts the field and writes nothing", () => {
    m = mount("---\nstatus: draft\n---\nbody\n");
    const before = m.view.state.doc.toString();
    const k = keyInputs(m)[0];
    k.value = "mangled";
    keydown(k, "Escape");
    expect(k.value).toBe("status");
    expect(m.view.state.doc.toString()).toBe(before);
  });

  it("Escape on the title input reverts to the on-disk title", () => {
    m = mount("---\ntitle: Real\n---\nbody\n");
    const before = m.view.state.doc.toString();
    const t = titleInput(m);
    t.value = "typed but cancelled";
    keydown(t, "Escape");
    expect(t.value).toBe("Real");
    expect(m.view.state.doc.toString()).toBe(before);
  });
});

describe("frontmatter widget: sequence (tags) chips", () => {
  const chips = (mm: Mounted) =>
    Array.from(mm.host.querySelectorAll<HTMLElement>(".cm-fm-properties-tag"));
  const chipLabels = (mm: Mounted) =>
    chips(mm).map(
      (c) => c.querySelector(".cm-fm-properties-tag-label")!.textContent,
    );
  const removeButtons = (mm: Mounted) =>
    Array.from(
      mm.host.querySelectorAll<HTMLButtonElement>(".cm-fm-properties-tag-remove"),
    );
  const addTagInput = (mm: Mounted) =>
    mm.host.querySelector<HTMLInputElement>(".cm-fm-properties-tag-input")!;
  const mousedown = (el: HTMLElement) =>
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );

  it("renders a block sequence as chips, not an empty text input", () => {
    m = mount("---\ntags:\n  - work\n  - ops\n---\nbody\n");
    expect(chipLabels(m)).toEqual(["work", "ops"]);
    // the regression: a sequence key must NOT render a scalar value input
    expect(valueInputs(m)).toHaveLength(0);
  });

  it("renders a flow sequence as chips too", () => {
    m = mount("---\ntags: [work, ops]\n---\nbody\n");
    expect(chipLabels(m)).toEqual(["work", "ops"]);
  });

  it("adds a tag via the add-item field (byte-stable block append)", () => {
    m = mount("---\ntags:\n  - work\n---\nbody\n");
    fire(addTagInput(m), "rust");
    expect(m.view.state.doc.toString()).toBe(
      "---\ntags:\n  - work\n  - rust\n---\nbody\n",
    );
  });

  it("appends to a flow sequence in its own style", () => {
    m = mount("---\ntags: [work]\n---\nbody\n");
    fire(addTagInput(m), "rust");
    expect(m.view.state.doc.toString()).toBe(
      "---\ntags: [work, rust]\n---\nbody\n",
    );
  });

  it("ignores a duplicate under the case-fold identity (no write)", () => {
    m = mount("---\ntags:\n  - Work\n---\nbody\n");
    const before = m.view.state.doc.toString();
    fire(addTagInput(m), "work");
    expect(m.view.state.doc.toString()).toBe(before);
  });

  it("strips a leading `#` from a typed tag", () => {
    m = mount("---\ntags:\n  - work\n---\nbody\n");
    fire(addTagInput(m), "#rust");
    expect(m.view.state.doc.toString()).toBe(
      "---\ntags:\n  - work\n  - rust\n---\nbody\n",
    );
  });

  it("removes a tag chip via its × button", () => {
    m = mount("---\ntags:\n  - work\n  - ops\n---\nbody\n");
    mousedown(removeButtons(m)[0]!); // remove "work"
    expect(m.view.state.doc.toString()).toBe(
      "---\ntags:\n  - ops\n---\nbody\n",
    );
  });

  it("collapses the key line when the last chip is removed", () => {
    m = mount("---\ntags:\n  - only\ntitle: N\n---\nbody\n");
    mousedown(removeButtons(m)[0]!);
    expect(m.view.state.doc.toString()).toBe("---\ntitle: N\n---\nbody\n");
  });
});
