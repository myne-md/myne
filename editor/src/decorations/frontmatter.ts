// Frontmatter Properties widget — Obsidian-style key/value rendering.
//
// Per the v1 dogfood addendum (post-grill α+R1 revisit): the raw YAML
// styled-block was replaced with a Properties widget that renders each
// `^([key]):[ \t]*(value)$` line as an editable row (icon + key label +
// text input). The Properties widget is ALWAYS shown when frontmatter
// exists — there is no cursor-aware reveal escape hatch in v1; users
// edit via the inputs + the "+ Add property" button. A top-level key whose
// value is a YAML SEQUENCE (block `key:\n  - a` or flow `key: [a, b]`) is
// rendered as removable chips + an add-item field (`renderSequenceRow`), so an
// AI-accepted `tags:` block is no longer shown as an empty text input. Deeper
// nested YAML (mappings, block scalars, anchors) still survives byte-stably in
// the source without a widget affordance.
//
// Block-level decoration: CodeMirror 6 requires `Decoration.replace`
// with `block: true` to be provided through a `StateField`, not a
// `ViewPlugin`. The state field re-derives its decoration set on every
// transaction; cheap because `cachedLocateFrontmatter` is `WeakMap`-keyed
// on the `Text` ref and skips on non-doc transactions.

import {
  EditorSelection,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { formatYamlScalar } from "@myne/dialect";
import { foldSegment } from "@myne/dialect/folderPath";
import { formatYamlStringScalar } from "@myne/dialect/surgery";
import {
  planSequenceItemInsert,
  planSequenceItemRemove,
} from "@myne/dialect/frontmatterSequence";
import { cachedLocateFrontmatter } from "../frontmatter-cache";
import {
  parseProperties,
  parseSimpleProperties,
  type PropertyRow,
  type SequenceProperty,
  type SimpleProperty,
} from "../frontmatter-properties";
import i18n from "@myne/editor/i18n";

/**
 * Render a raw YAML scalar (as captured by `parseSimpleProperties`, i.e.
 * the literal bytes after `key:`) as a plain display string. Inverts
 * `formatYamlScalar`'s double-quote escaping and handles single-quoted
 * scalars; plain scalars pass through. Keeps the title field showing the
 * human title rather than its quoted on-disk form.
 */
function displayYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

class PropertiesWidget extends WidgetType {
  constructor(private readonly properties: readonly PropertyRow[]) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    if (other.properties.length !== this.properties.length) return false;
    for (let i = 0; i < this.properties.length; i++) {
      const a = this.properties[i]!;
      const b = other.properties[i]!;
      if (a.kind !== b.kind || a.key !== b.key) return false;
      if (a.kind === "scalar") {
        if (b.kind !== "scalar" || a.value !== b.value) return false;
      } else {
        if (b.kind !== "sequence" || a.items.length !== b.items.length) {
          return false;
        }
        for (let j = 0; j < a.items.length; j++) {
          if (a.items[j] !== b.items[j]) return false;
        }
      }
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-fm-properties";

    // Note title — promoted above the "Properties" label as a prominent,
    // inline-editable field (MYND-141). The value mirrors the FM `title:`
    // key; edits dispatch a CM change to that line, so persistence rides
    // the editor's single autosave writer (no separate write path that
    // could race — see decisions.md 2026-05-15 save-handler discipline).
    container.appendChild(this.renderTitleField(view));

    const title = document.createElement("div");
    title.className = "cm-fm-properties-title";
    title.textContent = i18n.t("editor.frontmatter.propertiesLabel");
    container.appendChild(title);

    const list = document.createElement("div");
    list.className = "cm-fm-properties-list";
    container.appendChild(list);

    for (const prop of this.properties) {
      // `title` is surfaced by the promoted field above — don't repeat it
      // as a generic key/value row.
      if (prop.key === "title") continue;
      list.appendChild(
        prop.kind === "sequence"
          ? this.renderSequenceRow(view, prop)
          : this.renderRow(view, prop),
      );
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cm-fm-properties-add";
    addBtn.textContent = i18n.t("editor.frontmatter.addProperty");
    addBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.addProperty(view);
    });
    container.appendChild(addBtn);

    return container;
  }

  /** CM6 contract: returning `true` tells the view "this event belongs to
   * the widget — leave it alone." Returning `false` would route the event
   * back into the editor (cursor moves to the widget's source range, no
   * input focus, no typing). For an editable Properties UI we want the
   * widget's own DOM (inputs, button) to receive clicks + keystrokes,
   * not CM6's content layer. */
  ignoreEvent(): boolean {
    return true;
  }

  private renderTitleField(view: EditorView): HTMLElement {
    const titleProp = this.properties.find(
      (p): p is Extract<PropertyRow, { kind: "scalar" }> =>
        p.kind === "scalar" && p.key === "title",
    );
    const displayValue =
      titleProp === undefined ? "" : displayYamlScalar(titleProp.value);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-fm-properties-name";
    input.value = displayValue;
    input.placeholder = i18n.t("editor.frontmatter.titlePlaceholder");
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", i18n.t("editor.frontmatter.titleAriaLabel"));

    input.addEventListener("change", () => {
      this.commitTitle(view, input, displayValue);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = displayValue;
        input.blur();
      }
    });
    return input;
  }

  /** The drag-handle glyph shared by every row (visual only). */
  private makeIcon(): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "cm-fm-properties-icon";
    icon.textContent = "≡";
    return icon;
  }

  /** The editable key input, shared by scalar and sequence rows. Commit /
   *  Enter / Escape behaviour is identical — the value cell is what differs. */
  private makeKeyInput(view: EditorView, key: string): HTMLInputElement {
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "cm-fm-properties-key";
    keyInput.value = key;
    keyInput.spellcheck = false;
    keyInput.autocomplete = "off";
    keyInput.addEventListener("change", () => {
      this.commitKey(view, key, keyInput.value);
    });
    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        keyInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        keyInput.value = key;
        keyInput.blur();
      }
    });
    return keyInput;
  }

  private renderRow(view: EditorView, prop: SimpleProperty): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-fm-properties-row";
    row.appendChild(this.makeIcon());
    row.appendChild(this.makeKeyInput(view, prop.key));

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "cm-fm-properties-value";
    valueInput.value = prop.value;
    valueInput.spellcheck = false;
    valueInput.autocomplete = "off";
    valueInput.addEventListener("change", () => {
      this.commitValue(view, prop.key, valueInput.value);
    });
    valueInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        valueInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        valueInput.value = prop.value;
        valueInput.blur();
      }
    });
    row.appendChild(valueInput);

    return row;
  }

  /** A sequence-valued key: editable key + a chip list (each item removable)
   *  plus an add-item field. The value cell is one flex container, so — like the
   *  scalar row — it contributes exactly the third grid column. */
  private renderSequenceRow(
    view: EditorView,
    prop: SequenceProperty,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-fm-properties-row";
    row.appendChild(this.makeIcon());
    row.appendChild(this.makeKeyInput(view, prop.key));

    const cell = document.createElement("div");
    cell.className = "cm-fm-properties-tags";

    for (const item of prop.items) {
      cell.appendChild(this.renderChip(view, prop.key, item));
    }

    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.className = "cm-fm-properties-tag-input";
    addInput.dataset.key = prop.key;
    addInput.setAttribute("data-testid", "editor.frontmatter-tag-input");
    addInput.spellcheck = false;
    addInput.autocomplete = "off";
    addInput.placeholder = i18n.t("editor.frontmatter.addListItem");
    addInput.setAttribute(
      "aria-label",
      i18n.t("editor.frontmatter.addListItemAriaLabel", { key: prop.key }),
    );
    const commitAdd = () =>
      this.commitAddItem(view, prop.key, prop.items, addInput);
    addInput.addEventListener("change", commitAdd);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitAdd();
      } else if (e.key === "Escape") {
        e.preventDefault();
        addInput.value = "";
        addInput.blur();
      }
    });
    cell.appendChild(addInput);

    row.appendChild(cell);
    return row;
  }

  /** One removable chip for a sequence item. Uses `mousedown` + preventDefault
   *  (like "+ Add property") so the click never blurs a sibling field or moves
   *  the editor selection before the remove edit dispatches. */
  private renderChip(
    view: EditorView,
    key: string,
    item: string,
  ): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-fm-properties-tag";
    chip.setAttribute("data-testid", "editor.frontmatter-tag");

    const label = document.createElement("span");
    label.className = "cm-fm-properties-tag-label";
    label.textContent = item;
    chip.appendChild(label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cm-fm-properties-tag-remove";
    remove.setAttribute("data-testid", "editor.frontmatter-tag-remove");
    remove.setAttribute(
      "aria-label",
      i18n.t("editor.frontmatter.removeListItemAriaLabel", { item }),
    );
    remove.textContent = "×";
    remove.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.commitRemoveItem(view, key, item);
    });
    chip.appendChild(remove);
    return chip;
  }

  /**
   * Append the typed item to `key`'s sequence. De-duplicates within the list
   * under the case-fold identity (so `Rust` + `rust` don't both appear), strips
   * a single leading `#` (a user may type `#tag`), and formats the item so it
   * reads back as the exact string it was typed as. No-op on empty / duplicate /
   * a frontmatter shape the writer refuses.
   */
  private commitAddItem(
    view: EditorView,
    key: string,
    items: readonly string[],
    input: HTMLInputElement,
  ): void {
    const raw = input.value.trim();
    if (raw === "") return;
    const cleaned = (raw.startsWith("#") ? raw.slice(1) : raw).trim();
    if (cleaned === "") {
      input.value = "";
      return;
    }
    const existing = new Set(items.map((i) => foldSegment(i)));
    if (existing.has(foldSegment(cleaned))) {
      input.value = ""; // already present under the fold — no duplicate
      return;
    }
    const plan = planSequenceItemInsert(view.state.doc.toString(), key);
    if (plan === null) {
      input.value = "";
      return;
    }
    const edit = plan(formatYamlStringScalar(cleaned));
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      userEvent: "frontmatter.add-list-item",
    });
    this.refocusAddInput(view, key);
  }

  /** Remove the chip whose folded value matches `item` from `key`'s sequence. */
  private commitRemoveItem(
    view: EditorView,
    key: string,
    item: string,
  ): void {
    const edit = planSequenceItemRemove(
      view.state.doc.toString(),
      key,
      foldSegment(item),
    );
    if (edit === null) return;
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      userEvent: "frontmatter.remove-list-item",
    });
  }

  /** After an add, the widget DOM is rebuilt (item count changed → `eq()` is
   *  false) and the add-input is destroyed; land focus on the fresh one for the
   *  same key so several items can be typed in a row. Same requestAnimationFrame
   *  deferral as `addProperty`. */
  private refocusAddInput(view: EditorView, key: string): void {
    requestAnimationFrame(() => {
      const inputs = view.dom.querySelectorAll<HTMLInputElement>(
        ".cm-fm-properties-tag-input",
      );
      for (const input of inputs) {
        if (input.dataset.key === key) {
          input.focus();
          break;
        }
      }
    });
  }

  private commitKey(view: EditorView, oldKey: string, nextKeyRaw: string): void {
    const nextKey = nextKeyRaw.trim();
    if (nextKey === oldKey) return;
    // Reject empty / whitespace / non-simple keys — the
    // `parseSimpleProperties` regex (`^[a-zA-Z0-9_-]+$`) anchors what's
    // considered a valid simple-property key. Anything else stays on
    // disk byte-for-byte in the YAML body, but can't be re-typed in
    // the widget (would shadow the key parse + break the next render).
    if (nextKey === "" || !/^[a-zA-Z0-9_-]+$/.test(nextKey)) return;
    const range = cachedLocateFrontmatter(view.state.doc);
    if (range === null) return;
    const doc = view.state.doc.toString();
    const props = parseSimpleProperties(doc, range);
    const live = props.find((p) => p.key === oldKey);
    if (live === undefined) return;
    // Reject collision with another existing key — would produce
    // duplicate YAML keys, undefined parse behavior.
    if (props.some((p) => p !== live && p.key === nextKey)) return;
    view.dispatch({
      changes: {
        from: live.lineFrom,
        to: live.lineFrom + oldKey.length,
        insert: nextKey,
      },
      userEvent: "frontmatter.rename-key",
    });
  }

  private commitValue(view: EditorView, key: string, next: string): void {
    // Resolve the live value range against the current doc — the
    // captured property snapshot may be stale if other edits ran since
    // the widget was rendered. Re-parse from the cached frontmatter
    // range, find the matching key, replace just the value bytes.
    const range = cachedLocateFrontmatter(view.state.doc);
    if (range === null) return;
    const doc = view.state.doc.toString();
    const live = parseSimpleProperties(doc, range).find((p) => p.key === key);
    if (live === undefined) return;
    if (live.value === next) return;
    view.dispatch({
      changes: { from: live.valueFrom, to: live.valueTo, insert: next },
      userEvent: "frontmatter.set-value",
    });
  }

  /**
   * Commit the promoted title field. Writes to the FM `title:` value
   * range when the key exists, else inserts a `title:` line at the top of
   * the frontmatter body. The value is YAML-escaped via `formatYamlScalar`
   * (titles routinely contain `:`/`#`/leading `-`, which would otherwise
   * break the next parse — and the sidebar's js-yaml title read).
   *
   * Empty commit reverts (no write) — same convention as the sidebar
   * rename (MYND-140); a note keeps its previous title rather than gaining
   * an empty one.
   */
  private commitTitle(
    view: EditorView,
    input: HTMLInputElement,
    prevDisplay: string,
  ): void {
    const next = input.value.replace(/[\r\n]+/g, " ").trim();
    if (next === "") {
      input.value = prevDisplay; // revert visual state; no spurious save
      return;
    }
    if (next === prevDisplay) return;

    const range = cachedLocateFrontmatter(view.state.doc);
    if (range === null) return;
    const doc = view.state.doc.toString();
    const formatted = formatYamlScalar(next);
    const live = parseSimpleProperties(doc, range).find(
      (p) => p.key === "title",
    );
    if (live !== undefined) {
      if (doc.slice(live.valueFrom, live.valueTo) === formatted) return;
      view.dispatch({
        changes: { from: live.valueFrom, to: live.valueTo, insert: formatted },
        userEvent: "frontmatter.set-title",
      });
    } else {
      view.dispatch({
        changes: { from: range.bodyStart, insert: `title: ${formatted}\n` },
        userEvent: "frontmatter.add-title",
      });
    }
  }

  private addProperty(view: EditorView): void {
    const range = cachedLocateFrontmatter(view.state.doc);
    if (range === null) return;
    const doc = view.state.doc.toString();
    const existing = new Set(
      parseSimpleProperties(doc, range).map((p) => p.key),
    );
    let key = "property";
    let n = 1;
    while (existing.has(key)) {
      key = `property${n++}`;
    }
    const insertion = `${key}: \n`;
    view.dispatch({
      changes: { from: range.bodyEnd, insert: insertion },
      userEvent: "frontmatter.add-property",
    });
    // Land focus on the new property's key input so the user can name it
    // immediately. Without this, the widget DOM is rebuilt (eq() is false —
    // the property count changed) and the focused button is destroyed; WKWebView
    // then falls focus back to the first focusable element in the container —
    // the title field — lighting up its :focus background. Defer to the next
    // frame so CM6 has finished writing the rebuilt widget DOM.
    requestAnimationFrame(() => {
      const keyInputs = view.dom.querySelectorAll<HTMLInputElement>(
        ".cm-fm-properties-key",
      );
      for (const input of keyInputs) {
        if (input.value === key) {
          input.focus();
          input.select();
          break;
        }
      }
    });
  }
}

function buildFrontmatterDecorations(
  state: { doc: Parameters<typeof cachedLocateFrontmatter>[0] },
): DecorationSet {
  const doc = state.doc;
  const range = cachedLocateFrontmatter(doc);
  if (range === null) return Decoration.none;
  const props = parseProperties(doc.toString(), range);
  // A note that is ONLY frontmatter (the block reaches the end of the doc)
  // would otherwise have its closing `---\n` line break consumed by the
  // block-replace decoration — that swallows the empty body line below it, so
  // there is NO editable line and the user can't click to start writing (the
  // frontmatter-only-note bug). Stop the decoration one char short of that
  // trailing newline, leaving the final empty line as a live caret target.
  // (The no-trailing-newline variant `---\n…\n---` has no line to expose; the
  // emptyBodyClickHandler below creates one on demand.)
  let blockEnd = range.blockEnd;
  if (
    blockEnd === doc.length &&
    doc.length > 0 &&
    doc.sliceString(doc.length - 1, doc.length) === "\n"
  ) {
    blockEnd -= 1;
  }
  const decorations: Array<Range<Decoration>> = [
    Decoration.replace({
      widget: new PropertiesWidget(props),
      block: true,
    }).range(range.blockStart, blockEnd),
  ];
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

/**
 * Mirror the block-replace range into a PLAIN-replace range set for
 * `EditorView.atomicRanges` (MYND-608). The frontmatter field already re-tracks
 * the range on every doc change, so we derive from it rather than re-walking the
 * document; it holds at most one range, so no syntax-tree cache is needed (unlike
 * the table/attachment widgets). Re-emitted as a plain `Decoration.replace({})`
 * because the `block: true` layout role is irrelevant to atomicity — the three
 * sibling widgets register the same plain shape.
 */
function frontmatterAtomicRanges(set: DecorationSet): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const iter = set.iter();
  while (iter.value !== null) {
    builder.add(iter.from, iter.to, Decoration.replace({}));
    iter.next();
  }
  return builder.finish();
}

const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return buildFrontmatterDecorations(state);
  },
  update(decorations, tr) {
    if (!tr.docChanged) return decorations;
    return buildFrontmatterDecorations(tr.state);
  },
  provide(field) {
    return [
      EditorView.decorations.from(field),
      // The block-replace alone still lets cursor motion / selection / Backspace
      // enter the hidden frontmatter source (`folder:`/`updated:` — two silent-
      // corruption paths). Registering the SAME span with atomicRanges makes CM6
      // treat the Properties block as one indivisible unit, exactly like the
      // attachment/wikilink/table widgets. Editing rides only through the
      // widget's own inputs (`ignoreEvent()` returns true).
      EditorView.atomicRanges.of((view) =>
        frontmatterAtomicRanges(view.state.field(field)),
      ),
    ];
  },
});

/**
 * Click-to-write affordance for a note that is ONLY frontmatter AND has no
 * trailing newline after the closing `---` (the `---\n…\n---` shape). There,
 * the block widget consumes the entire document and there is no body line for
 * the decoration-shrink in `buildFrontmatterDecorations` to expose — clicking
 * the empty area below the Properties widget would otherwise do nothing. On
 * such a click, insert a single newline at the document end (creating the body
 * line) and drop the caret onto it, so the user can immediately start typing.
 *
 * Scoped tightly: it only fires when the frontmatter block runs to the very end
 * of a doc that does NOT end in a newline, and only for clicks below the widget
 * — never on the widget's own inputs / "+ Add property" button, and never in a
 * note that already has a body.
 */
function emptyBodyClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false;
      const doc = view.state.doc;
      const range = cachedLocateFrontmatter(doc);
      if (range === null) return false;
      if (range.blockEnd !== doc.length) return false;
      if (
        doc.length === 0 ||
        doc.sliceString(doc.length - 1, doc.length) === "\n"
      ) {
        return false;
      }
      const widget = view.dom.querySelector(".cm-fm-properties");
      if (!(widget instanceof HTMLElement)) return false;
      if (event.clientY <= widget.getBoundingClientRect().bottom) return false;
      event.preventDefault();
      view.dispatch({
        changes: { from: doc.length, insert: "\n" },
        selection: EditorSelection.cursor(doc.length + 1),
        userEvent: "input",
      });
      view.focus();
      return true;
    },
  });
}

export function frontmatterDecorations(): Extension {
  return [frontmatterField, emptyBodyClickHandler()];
}
