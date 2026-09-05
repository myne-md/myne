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
  EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { formatYamlScalar } from "@myne/dialect";
import { writableMember } from "../host";
import { readNoteId } from "../note-identity";
import { catalogChanged, catalogField } from "../attachments/catalog";
import { coverIsOnScreen } from "./cover-banner";
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

/** Testid for the promoted note-title field (myne#653). Exported so the desktop
 *  E2E helper and the pane's focus-on-create effect name it once. */
export const TITLE_FIELD_TESTID = "editor.frontmatter-title";

/** Testid for the "Add cover" control on the promoted title row. */
export const ADD_COVER_TESTID = "editor.cover-add";

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
  constructor(
    private readonly properties: readonly PropertyRow[],
    /** Whether the cover banner above this widget is showing the note's cover.
     *  Drives both the `cover:` row skip and the "Add cover" control, so the
     *  two never disagree about whether a cover is on screen. */
    private readonly coverShown: boolean,
  ) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    // Load-bearing: without this the widget compares equal across a catalog
    // resolve, so the `cover:` row would keep whatever visibility it had when
    // the note opened and never settle.
    if (other.coverShown !== this.coverShown) return false;
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
      // Same rule for `cover`, whose promoted surface is the banner above this
      // widget (myne-md/myne#410). The CONDITION is the whole point and an
      // unconditional skip would be a bug: a line that exists in the file and
      // appears nowhere in the interface contradicts the plain-markdown
      // portability commitment.
      //
      // The condition is "the banner is showing it", NOT "the value is valid",
      // and the difference is load-bearing. A cover whose attachment has been
      // deleted is perfectly valid and draws no banner, so a validity-only
      // check would hide the row for exactly the case where nothing else shows
      // it. Both a rejected value and a dangling one therefore fall through to
      // the ordinary text row, where the user can see and fix them.
      if (prop.key === "cover" && this.coverShown) continue;
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
    // myne#653: this is now where a note gets its name, since creating one no
    // longer opens the sidebar's inline rename. It had no testid, so the E2E
    // suite had nothing to type into (`src/CLAUDE.md`: "A screen without
    // testids is invisible to E2E").
    input.setAttribute("data-testid", TITLE_FIELD_TESTID);

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

    // "Add cover" (myne-md/myne#410) — Notion's position, mapped onto where
    // Myne's title actually lives. Rendered only when the note has NO valid
    // cover: once it has one, the banner's own controls take over, and two
    // surfaces offering the same thing is what the `title` promotion rule
    // exists to avoid. Hidden until hover by CSS, and visible unconditionally
    // on a coarse pointer, where there is no hover at all.
    // Withdrawn only when a cover is actually ON SCREEN, matching the row skip.
    // A dangling cover keeps this control, because the user has no usable cover
    // and must still be able to set one.
    // Read-only refuses, the same as the banner's controls one file away and for
    // the same reason (myne-md/myne#564 applied in myne-md/myne#520's review):
    // this control does not go through the document, so `EditorState.readOnly`
    // does not stop it, and the host it calls re-encrypts the note on disk. A
    // reading mirror offering "Add cover" is a write affordance on a surface
    // documented as never writing. `writableMember` holds that rule for both
    // controls; what it does NOT reach is stated at `HOST_WRITE_MEMBERS` rather
    // than promised here, because the roster covers top-level members and the
    // attachments write members are not among them.
    const cover = writableMember(view.state, "cover");
    if (cover === undefined || this.coverShown) return input;

    const row = document.createElement("div");
    row.className = "cm-fm-properties-name-row";
    row.appendChild(input);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "cm-fm-add-cover";
    add.textContent = i18n.t("editor.cover.add");
    add.setAttribute("data-testid", ADD_COVER_TESTID);
    // `mousedown` + preventDefault, matching the banner's controls: the title
    // input would otherwise take focus before the handler runs.
    add.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Read live from the view, never captured (myne-md/myne#520): this widget
      // outlives a note swap whenever its properties compare equal, and the
      // `preventDefault` above is exactly what stops the host from working the
      // target out from focus.
      cover.openPicker(false, readNoteId(view.state));
    });
    row.appendChild(add);
    return row;
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

/**
 * The FIRST offset a caret or selection is allowed to reach: the start of the
 * first body line. `null` when the doc has no frontmatter.
 *
 * The selection guard clamps to this, and it is the only authority on where the
 * caret may go. What the block-replace decoration COVERS is a different number
 * and lives in `renderEnd` below. The two used to be one, and collapsing them
 * is what made a blank first body line unrenderable (myne-md/myne#595).
 *
 * That includes the frontmatter-only note (`---\n…\n---\n`), whose body is the
 * single empty line at the very end: the floor is that line's offset, which is
 * the document's length, and `renderEnd` leaves the line itself alive to hold
 * the caret. (The no-trailing-newline variant `---\n…\n---` has no such line;
 * `emptyBodyClickHandler` creates one on demand.)
 */
export function frontmatterBoundary(doc: Text): number | null {
  const range = cachedLocateFrontmatter(doc);
  return range === null ? null : range.blockEnd;
}

/**
 * Where the block-replace decoration STOPS, which is one character short of the
 * caret floor whenever the block ends in a newline (myne-md/myne#595).
 *
 * Those are two different jobs and they need two different numbers. The floor
 * (`frontmatterBoundary`) is the first offset a caret may occupy: the start of
 * the first body line. The replace has to stop before the newline that ENDS the
 * closing `---`, because a block decoration that runs all the way to the next
 * line's start swallows that line when it is EMPTY: it is not rendered at all,
 * there is no `.cm-line` for it in the DOM, and `coordsAtPos` therefore has
 * nothing on that line to measure. `drawSelection` falls back to the nearest box
 * that exists, the Properties block itself, and paints the caret as a full-height
 * bar at its edge. That is the reported symptom, and it is why forcing the
 * forward association did not settle it: forward from a line that was never
 * rendered is still nothing.
 *
 * Measured, on `---\ntitle: x\n---\n\n# Heading\n`:
 *
 *   replace [0,17) -> 2 lines: "# Heading", ""      (the blank line is gone)
 *   replace [0,16) -> 3 lines: "", "# Heading", ""  (it is there)
 *
 * and on the same note WITHOUT the blank line both ranges render identically, so
 * the shorter range costs nothing where it is not needed.
 *
 * The newline test is load-bearing: a block with no trailing newline (`---\n…\n---`
 * at the very end of a note) would otherwise have its last `-` left outside the
 * widget and painted as a stray line of source.
 */
function renderEnd(doc: Text, blockEnd: number): number {
  return doc.sliceString(blockEnd - 1, blockEnd) === "\n"
    ? blockEnd - 1
    : blockEnd;
}

/**
 * Where the Properties block STOPS on screen: the offset anything that has to
 * sit immediately after the panel anchors to (the suggested-tags band, myne#287).
 *
 * Not the caret floor: that is one character further on, and anchoring a block
 * widget there puts it after the note's first body line instead of against the
 * panel. In a brand-new note, whose only body line is empty, that difference is
 * the whole of what #287 reported. `null` when the doc has no frontmatter.
 */
export function frontmatterRenderEnd(doc: Text): number | null {
  const range = cachedLocateFrontmatter(doc);
  return range === null ? null : renderEnd(doc, range.blockEnd);
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const range = cachedLocateFrontmatter(doc);
  if (range === null) return Decoration.none;
  const props = parseProperties(doc.toString(), range);
  const coverShown = coverIsOnScreen(doc, state.field(catalogField, false) ?? null);
  const decorations: Array<Range<Decoration>> = [
    Decoration.replace({
      widget: new PropertiesWidget(props, coverShown),
      block: true,
    }).range(range.blockStart, renderEnd(doc, range.blockEnd)),
  ];
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

/**
 * The frontmatter span registered with `EditorView.atomicRanges` (MYND-608).
 *
 * It runs to the caret FLOOR, not to where the block-replace decoration stops.
 * The two differ by the newline that ends the closing `---` (see `renderEnd`),
 * and atomicity belongs with the floor: they are the same contract, "the caret
 * may not go here", stated to CM's motion commands and to the selection guard
 * respectively. Deriving it from the decoration instead would leave that newline
 * outside the atomic span, so an ArrowLeft could aim at it and be bounced back
 * by the guard, so a keypress does nothing rather than stepping out.
 *
 * Emitted as a plain `Decoration.replace({})`: the `block: true` layout role is
 * irrelevant to atomicity, and the three sibling widgets register the same shape.
 */
function frontmatterAtomicRanges(state: EditorState): DecorationSet {
  const range = cachedLocateFrontmatter(state.doc);
  const builder = new RangeSetBuilder<Decoration>();
  if (range !== null) {
    builder.add(range.blockStart, range.blockEnd, Decoration.replace({}));
  }
  return builder.finish();
}

const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return buildFrontmatterDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged) return buildFrontmatterDecorations(tr.state);
    // The catalog matters here too, but only for ONE boolean: whether the
    // `cover:` row is skipped depends on whether the banner resolved the
    // attachment, and a warm changes that without touching a byte of the doc.
    // A full rebuild would re-run `doc.toString()` + `parseProperties` (O(n) in
    // the note) to recompute it, and for the overwhelmingly common note with no
    // `cover:` at all the answer is the same both times. Comparing the boolean
    // is O(frontmatter body).
    if (!catalogChanged(tr)) return decorations;
    const before = coverIsOnScreen(tr.state.doc, tr.startState.field(catalogField, false) ?? null);
    const after = coverIsOnScreen(tr.state.doc, tr.state.field(catalogField, false) ?? null);
    if (before === after) return decorations;
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
      EditorView.atomicRanges.of((view) => frontmatterAtomicRanges(view.state)),
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

/**
 * Keep the caret and every selection endpoint at or after the first body offset,
 * so the frontmatter Properties block is wholly unreachable (MYND-608 / #209).
 *
 * `atomicRanges` (registered by `frontmatterField`) stops cursor MOTION and
 * Backspace from stepping THROUGH the block, but CM still permits two things it
 * does not: a caret parked at the block's outer boundary — offset 0, which
 * renders visually at the TOP of the Properties panel, so ArrowUp from the body
 * lands the caret "in" the panel — and a selection (or select-all) that spans
 * the whole block, which `drawSelection` then paints as a band up across the
 * panel. Both were still reproducible on the desktop build. Clamping the
 * document selection to `>= boundary` closes both: the frontmatter can no longer
 * hold the caret, and a body selection stops cleanly at the top of the body
 * instead of swallowing the block.
 *
 * This constrains the CM DOCUMENT selection only. The widget's own `<input>`
 * fields keep their independent text cursor (they are form controls, unaffected
 * by the editor selection), so editing frontmatter through the widget is
 * untouched. Transactions that carry no explicit selection (e.g. a value edit
 * dispatched by the widget) are left alone.
 */
function frontmatterSelectionGuard(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.selection === undefined) return tr;
    // The floor is the first BODY offset, and nothing further.
    //
    // It used to advance past every blank line following the closing `---`, to
    // work around MYND-608 / #209: a caret on a blank first body line had no
    // element for `coordsAtPos` to measure on either side, fell back to the
    // block's own rect, and `drawSelection` painted a full-height caret at the
    // panel's edge. The skipped lines were called harmless because they stayed
    // in the document.
    //
    // They were not harmless once the user CREATED one (myne#285). Pressing
    // Enter at the start of the first body line leaves a blank line above the
    // text, and this filter clamps EVERY selection endpoint — keyboard, mouse
    // and Backspace alike. So the line could not be reached by ArrowUp, could
    // not be clicked, and could not be deleted from the editor at all, because
    // Backspace targets `floor - 1`. Pressing Enter repeatedly at the top of a
    // note accumulated dead lines that only an external editor could remove. A
    // region of the document the user can create and then never touch again is
    // worse than the rendering artefact it was avoiding.
    //
    // The rendering half is handled below where it belongs, by forcing
    // `assoc = 1` on the clamped cursor.
    const boundary = frontmatterBoundary(tr.newDoc);
    if (boundary === null || boundary === 0) return tr;
    let changed = false;
    const ranges = tr.selection.ranges.map((r) => {
      const anchor = r.anchor < boundary ? boundary : r.anchor;
      const head = r.head < boundary ? boundary : r.head;
      // The boundary sits immediately AFTER the block widget. A caret there must
      // associate FORWARD (assoc = 1) so CM renders it at the start of the body
      // line. With a backward association `coordsAtPos` resolves the position to
      // the block's trailing edge, drawing a full-height caret at the block's
      // right side, which reads as "the caret is in the Properties panel" even
      // though the offset is already the first body offset.
      //
      // This runs for EVERY caret that ends up on the boundary, not only for one
      // the clamp above moved (myne-md/myne#595). A caret can arrive there in
      // bounds and with `assoc = -1`, so one ArrowRight or ArrowDown out of the
      // block does exactly that, and so does Backspace back to the start of the
      // first body line, and inside the `changed` branch the repair never saw
      // any of them. The offset was right and the paint was wrong, which is why
      // it survived a suite that asserts on `head`.
      const next =
        anchor === head
          ? EditorSelection.cursor(head, head === boundary ? 1 : r.assoc)
          : EditorSelection.range(anchor, head);
      if (
        next.anchor === r.anchor &&
        next.head === r.head &&
        next.assoc === r.assoc
      ) {
        return r;
      }
      changed = true;
      return next;
    });
    if (!changed) return tr;
    return [
      tr,
      {
        selection: EditorSelection.create(ranges, tr.selection.mainIndex),
        sequential: true,
      },
    ];
  });
}

export function frontmatterDecorations(): Extension {
  return [
    frontmatterField,
    frontmatterSelectionGuard(),
    emptyBodyClickHandler(),
  ];
}
