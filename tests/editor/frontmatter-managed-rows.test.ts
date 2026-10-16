// @vitest-environment jsdom
//
// A Properties-widget row whose own line is app state renders READ-ONLY
// (myne-md/myne#872).
//
// The defect this pins: a note carrying `folder_index: true` drew the field as
// a checkbox (rows are typed by `coerceSourceScalar`, myne-md/myne#777), and
// one click dispatched `commitValue(view, "folder_index", "false")` into the
// document. That is body autosave, which `markdown-dialect.md` §3.6.1 says
// never writes `folder_index:` at all, and `false` is a value Myne's own
// undesignate path never produces: it DELETES the field. Reading is
// value-strict, so the note still behaved; what shipped was a second writer for
// app-owned state and a non-canonical line the panel could not remove again.
//
// BOTH directions are asserted, because each one alone passes on a broken tree:
//
//   owned-is-read-only alone    -> a rule making every managed key read-only
//                                  also passes, and that strands a malformed
//                                  value: the frontmatter block is replaced by
//                                  this widget, so such a row would be a byte
//                                  the user can see and never fix.
//   unrecognised-is-editable alone -> no rule at all also passes, which is the
//                                  defect.
//
// The predicate is asked per ROW, so the duplicate-key cases below are not
// decoration: a body-wide answer renders the junk line read-only when it comes
// first and the canonical line's row writable when it does not, and the first
// of those has to be caught here rather than in a user's vault.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  catalogField,
  type CatalogRow,
} from "../../src/editor/attachments/catalog";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(lines: readonly string[]): Mounted {
  return mountWith(lines, []);
}

function mountWith(
  lines: readonly string[],
  extra: readonly Extension[],
): Mounted {
  const doc = ["---", ...lines, "---", "", "body", ""].join("\n");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [...extra, frontmatterDecorations()],
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

/** Every row the widget drew READ-ONLY, as `[key, value]` display pairs. */
function managedRows(mm: Mounted): string[][] {
  return Array.from(
    mm.host.querySelectorAll<HTMLElement>('[data-managed="true"]'),
    (row) => [
      row.querySelector(".cm-fm-properties-key-static")?.textContent ?? "",
      row.querySelector(".cm-fm-properties-value-static")?.textContent ?? "",
    ],
  );
}

/** Every row the widget drew as an ordinary editable value row. */
function editableValues(mm: Mounted): string[] {
  return Array.from(
    mm.host.querySelectorAll<HTMLInputElement>(".cm-fm-properties-value"),
    (el) => el.value,
  );
}

/** The checkbox rows' current state, which only an editable boolean row has. */
function checkboxes(mm: Mounted): boolean[] {
  return Array.from(
    mm.host.querySelectorAll<HTMLInputElement>(".cm-fm-properties-checkbox"),
    (el) => el.checked,
  );
}

/** Every control inside a read-only row. The claim is that this is empty. */
function controlsInManagedRows(mm: Mounted): number {
  let n = 0;
  for (const row of mm.host.querySelectorAll<HTMLElement>(
    '[data-managed="true"]',
  )) {
    n += row.querySelectorAll("input, button, textarea, select").length;
  }
  return n;
}

describe("a row the app owns is read-only", () => {
  it("renders `folder_index: true` as visible text with no control at all", () => {
    // The regression itself. The row must still be on screen (the line is in
    // the file) and must contain nothing that can write it.
    m = mount([
      "title: 02 - AREAS",
      "folder: 02 - AREAS/",
      "folder_index: true",
    ]);
    expect(managedRows(m)).toEqual([
      ["folder", "02 - AREAS/"],
      ["folder_index", "true"],
    ]);
    expect(controlsInManagedRows(m)).toBe(0);
  });

  it("leaves no boolean checkbox anywhere on the note", () => {
    // The precise writer that shipped: a checked box whose `change` handler
    // committed `false`.
    m = mount(["folder_index: true"]);
    expect(checkboxes(m)).toEqual([]);
  });

  it("prints the row's own value bytes, quotes included", () => {
    // This row is the only representation of that line in the app, so it may
    // not show a display-normalised value that matches neither the file nor
    // what the reader saw. A quoted date is still recognised as app state
    // (§3.6.4: quoting demotes checkbox and number, never dates).
    m = mount(['trashed: "2026-08-01T10:00:00Z"']);
    expect(managedRows(m)).toEqual([
      ["trashed", '"2026-08-01T10:00:00Z"'],
    ]);
  });

  it("keeps a user's own boolean property editable, so the rule is the field and not the type", () => {
    // Control: the same `true` value on a key Myne does not own still gets the
    // checkbox (myne-md/myne#777's typing is untouched by this rule).
    m = mount(["reviewed: true", "folder_index: true"]);
    expect(checkboxes(m)).toEqual([true]);
    expect(managedRows(m)).toEqual([["folder_index", "true"]]);
  });

  it("covers the other flag and date shaped managed fields", () => {
    m = mount([
      "template: true",
      "trashed: 2026-08-01T10:00:00Z",
      "archived: 2026-08-02T10:00:00Z",
      "deleted: 2026-08-03T10:00:00Z",
      "updated: 2026-08-05T10:00:00Z",
      "folder: Projects/",
      "conflict: true",
    ]);
    expect(managedRows(m).map(([k]) => k)).toEqual([
      "template",
      "trashed",
      "archived",
      "deleted",
      "updated",
      "folder",
      "conflict",
    ]);
    expect(editableValues(m)).toEqual([]);
  });

  it("makes `done:` read-only only on a task note, which is where it can be cleared", () => {
    // `patchNoteCompletion` refuses a non-task note before it touches the field
    // and `uncompleteNote` is the only path that deletes `done:`, so on a note
    // with no `kind: task` a read-only row would strand a stamp nothing can
    // remove. The other half is the real task note, whose un-complete action
    // deletes the field.
    m = mount(["done: 2026-08-04T10:00:00Z"]);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual(["2026-08-04T10:00:00Z"]);
    m.view.destroy();
    m.host.remove();

    m = mount(["kind: task", "done: 2026-08-04T10:00:00Z"]);
    expect(managedRows(m)).toEqual([["done", "2026-08-04T10:00:00Z"]]);
  });

  it("reads the class marker the way the completion action does, first line first", () => {
    // `readKindFromFmBody` is first-line-wins, so this note is NOT a task to the
    // completion action and its `done:` has no clear path. A "any row says task"
    // gate would draw it read-only and strand the stamp.
    m = mount([
      "kind: chore",
      "kind: task",
      "done: 2026-08-04T10:00:00Z",
    ]);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual(["chore", "task", "2026-08-04T10:00:00Z"]);
  });

  it("exempts `kind`, which no action can clear", () => {
    // `patchKindField`'s only production caller sets `drawing`, nothing writes
    // `kind: task`, and no action passes `null`, so a read-only row would strand
    // a marker the panel and the app alike could not remove.
    m = mount(["kind: task", "kind: drawing"]);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual(["task", "drawing"]);
  });

  it("treats a `folder:` value the app cannot read as a user's line", () => {
    // `loadNoteBatch` keeps `folder:` only when js-yaml hands back a string, so
    // the predicate asks that parser. A bare number, a bare date and `~` all
    // resolve to something else, while a QUOTED one resolves to a string and
    // stays app state.
    m = mount([
      "folder: 123",
      "folder: 2026-10-15",
      "folder: ~",
      "folder: Projects/",
      'folder: "123"',
    ]);
    expect(managedRows(m)).toEqual([
      ["folder", "Projects/"],
      ["folder", '"123"'],
    ]);
    expect(editableValues(m)).toEqual(["123", "2026-10-15", "~"]);
  });

  it("exempts `conflict_of`, whose reader is not value-strict", () => {
    // `readConflictOfFromFmBody` accepts any non-empty scalar, so treating it
    // as app state would make a hand-written value un-editable and
    // un-removable. The pairing flag is the half that is read-only.
    m = mount([
      "conflict: true",
      "conflict_of: note three",
      `conflict_of_hex_unused: ${"a".repeat(32)}`,
    ]);
    expect(managedRows(m)).toEqual([["conflict", "true"]]);
    expect(editableValues(m)).toEqual([
      "note three",
      `${"a".repeat(32)}`,
    ]);
  });

  it("keeps a non-canonical `conflict:` fixable", () => {
    // The flag's reader returns a boolean, so a mutation to `!== null` would
    // make EVERY `conflict:` value read-only and strand the user's own line.
    // This case is what tells the two apart.
    m = mount(["conflict: 1", "conflict: true"]);
    expect(managedRows(m)).toEqual([["conflict", "true"]]);
    expect(editableValues(m)).toEqual(["1"]);
  });

  it("does not answer for `Object.prototype` keys a user may legitimately carry", () => {
    // The reader record is an object literal, so a bare index lookup answers
    // for `constructor`, `toString`, `__proto__` and friends. Those are legal
    // frontmatter keys, and the failure is not cosmetic in either direction:
    // the truthy-function ones drew a user's row read-only under a note
    // claiming Myne writes it, and the non-callable ones threw from `toDOM`,
    // taking the whole Properties widget with them.
    m = mount([
      "constructor: whatever",
      "toString: 2026-01-02",
      "valueOf: mixed",
      "__proto__: note",
      "hasOwnProperty: x",
    ]);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual([
      "whatever",
      "2026-01-02",
      "mixed",
      "note",
      "x",
    ]);
  });

  it("does not treat a differently-cased spelling as app state", () => {
    // Every reader in `surgery.ts` is anchored and case-SENSITIVE, so
    // `Folder_Index:` is the user's line. (`isManagedFrontmatterField` is
    // case-insensitive because the IMPORTERS need that; this rule is not the
    // importers' question.)
    m = mount(["Folder_Index: true"]);
    expect(managedRows(m)).toEqual([]);
    expect(checkboxes(m)).toEqual([true]);
  });
});

describe("the answer is asked per ROW, not per key", () => {
  it("leaves the junk line editable when the canonical line comes first", () => {
    // A body-wide answer marks BOTH rows read-only and strands the second.
    m = mount(["folder_index: true", "folder_index: yes"]);
    expect(managedRows(m)).toEqual([["folder_index", "true"]]);
    expect(editableValues(m)).toEqual(["yes"]);
  });

  it("keeps the canonical line's row read-only when the junk line comes first", () => {
    // The other line order, and the one that matters most: a body-wide answer
    // resolves on the FIRST line, so this order used to leave the canonical
    // value's row as an editable checkbox, which is the defect itself.
    m = mount(["folder_index: yes", "folder_index: true"]);
    expect(managedRows(m)).toEqual([["folder_index", "true"]]);
    expect(editableValues(m)).toEqual(["yes"]);
    expect(checkboxes(m)).toEqual([]);
  });

  it("writes the row the user typed into, never a neighbouring line of the same key", () => {
    // The WRITE half of the per-row rule, and the reason it is not enough to
    // render per row: the commit used to resolve its target by key, so with the
    // canonical line first, editing the junk row rewrote the app-owned line
    // (destroying the designation and typing a value no action produces). The
    // widget is not a writer for the row the rule protects.
    m = mount(["folder_index: true", "folder_index: yes"]);
    const input = m.host.querySelector<HTMLInputElement>(
      ".cm-fm-properties-value",
    )!;
    input.value = "maybe";
    input.dispatchEvent(new Event("change"));
    expect(m.view.state.doc.toString()).toBe(
      ["---", "folder_index: true", "folder_index: maybe", "---", "", "body", ""].join("\n"),
    );
  });

  it("renames the row the user typed into, too", () => {
    m = mount(["status: one", "status: two"]);
    const keyInputs = Array.from(
      m.host.querySelectorAll<HTMLInputElement>(".cm-fm-properties-key"),
    );
    expect(keyInputs).toHaveLength(2);
    keyInputs[1]!.value = "renamed";
    keyInputs[1]!.dispatchEvent(new Event("change"));
    expect(m.view.state.doc.toString()).toBe(
      ["---", "status: one", "renamed: two", "---", "", "body", ""].join("\n"),
    );
  });
});

describe("a managed row the app does NOT own stays editable", () => {
  it("keeps a non-canonical flag fixable", () => {
    // Value-strict: only the canonical unquoted `true` designates anything, so
    // these are the user's lines and the only place they can be repaired.
    m = mount(["folder_index: yes", 'template: "true"']);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual(["yes", '"true"']);
  });

  it("keeps an unparseable date fixable", () => {
    m = mount(["trashed: soon", "done: yes"]);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual(["soon", "yes"]);
  });

  it("keeps a non-canonical class marker fixable", () => {
    m = mount(["kind: chore"]);
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual(["chore"]);
  });

  it("keeps a hand-written SEQUENCE value fixable", () => {
    // A managed key carrying a list is junk by definition (no managed field has
    // a sequence value), so only a scalar row can be app state.
    m = mount(["folder_index:", "  - true"]);
    expect(managedRows(m)).toEqual([]);
    expect(
      m.host.querySelector(".cm-fm-properties-tags"),
      "the sequence row should be the editable one",
    ).not.toBeNull();
  });

  it("keeps a dangling `cover:` editable, which is the precedent this rule copies", () => {
    // myne-md/myne#410: with the catalog loaded and the attachment absent, no
    // banner draws it and the row stays an ordinary editable row so the user
    // can see and fix the line. The rule added here must not swallow that
    // carve-out.
    const id = "a".repeat(64);
    m = mountWith(
      [`cover: ![[att:${id}|hero.png]]`],
      [catalogField.init(() => new Map<string, CatalogRow>())],
    );
    expect(managedRows(m)).toEqual([]);
    expect(editableValues(m)).toEqual([`![[att:${id}|hero.png]]`]);
  });

  it("still promotes `title:` out of the row list entirely", () => {
    m = mount(["title: Hello", "folder_index: true"]);
    expect(
      m.host.querySelector<HTMLInputElement>(".cm-fm-properties-name")!.value,
    ).toBe("Hello");
    expect(managedRows(m).map(([k]) => k)).toEqual(["folder_index"]);
  });
});
