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
// ONE row class is not editable: a ROW whose own line is app state, which is a
// Myne-managed canonical field (§3.6.1) carrying a value its reader recognises
// (myne-md/myne#872). Such a row is still RENDERED (the line is in the file, and
// the frontmatter block is replaced wholesale by this widget, so a hidden field
// would be a byte the user can neither see nor reach) and it just carries no
// input. A managed key whose value no reader recognises is the user's line, so
// it stays an ordinary editable row, exactly like a dangling `cover:`. `title`
// is promoted to the note-title field and `cover` keeps its own
// banner-conditional rule; both are handled before this one. The predicate is
// asked per row rather than per key, and why that is load-bearing is written at
// `MANAGED_FIELD_READERS`.
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
import { formatYamlScalar, TASK_KIND_VALUE } from "@myne/dialect";
import { load as loadYaml } from "js-yaml";
// The SINGLE type authority (markdown-dialect.md 3.6.4). Consumed, never
// re-derived: its own header states siblings consume this typing and never
// redefine it, and a second opinion here would be a second answer the query
// engine and this widget could disagree on (myne-md/myne#777).
import {
  coerceSourceScalar,
  type PropertyType,
} from "../host/notes/propertyTyping";
import { writableMember } from "../host";
import { readNoteId } from "../note-identity";
import { catalogChanged, catalogField } from "../attachments/catalog";
import { coverIsOnScreen } from "./cover-banner";
import { foldSegment } from "@myne/dialect/folderPath";
// The per-field value-strict READERS, consumed rather than re-derived: they are
// the authority on whether a managed field's value is Myne's own state or a
// user's line that happens to carry the key (myne-md/myne#872).
import {
  formatYamlStringScalar,
  readArchivedFromFmBody,
  readConflictFromFmBody,
  readDeletedFromFmBody,
  readDoneFromFmBody,
  readFolderFromFmBody,
  readFolderIndexFromFmBody,
  readKindFromFmBody,
  readTemplateFromFmBody,
  readTrashedFromFmBody,
  readUpdatedFromFmBody,
} from "@myne/dialect/surgery";
import type { ManagedFrontmatterField } from "@myne/dialect/managedFields";
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

/**
 * Whether `raw` is a date the platform's own date input will accept: a real
 * calendar date, ranges and all, in the `YYYY-MM-DD` form that control takes.
 *
 * Deliberately stricter than the type authority's recogniser and deliberately
 * NOT a replacement for it — the two answer different questions. The authority
 * asks what kind of value this is, for the index and the query engine, and
 * answers on shape because that is what the published vectors pin. This asks
 * whether a `<input type="date">` can hold it without discarding it.
 */
export function isCalendarDate(raw: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Round-trip through Date to reject 31 April and a non-leap 29 February,
  // which the range check above lets through.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

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

/** Testid for a read-only row the app owns (myne-md/myne#872). */
export const MANAGED_ROW_TESTID = "editor.frontmatter-managed-row";

/**
 * Whether YAML resolves this raw scalar to a STRING, which is exactly the
 * question the app's own frontmatter read asks: `src/notes/loadNoteBatch.ts`
 * parses the body with js-yaml's default schema and keeps `folder:` only when
 * `typeof parsed["folder"] === "string"`.
 *
 * The parser is called on the row's value portion rather than on the whole body,
 * which is the one difference and it matters only for a value YAML would read as
 * something other than a scalar at all (a mapping, a sequence); those answer
 * "not a string" either way, which is what the app's own `typeof` check does.
 * A value the parser refuses is not a string the app can read, so it answers
 * false and the row stays the user's.
 *
 * This exists because the Myne type authority is deliberately NOT this reader:
 * it resolves under CORE_SCHEMA so a date stays a string for the index
 * (`propertyTyping.ts`), while `folder:`'s owner is the default-schema read.
 * `js-yaml` is already a dependency of this package.
 */
function resolvesToYamlString(rawValue: string): boolean {
  try {
    return typeof loadYaml(rawValue) === "string";
  } catch {
    return false;
  }
}

/**
 * The managed field whose value its own value-strict reader recognises is APP
 * STATE, so its row is read-only (myne-md/myne#872).
 *
 * Keyed by the canonical field name and typed as a total record over
 * `MANAGED_FRONTMATTER_FIELDS` minus the two this widget already treats
 * specially, so adding a fourteenth managed field is a COMPILE error here
 * rather than a row that silently stays editable. The readers are consumed, not
 * re-derived: each one answers "is this value the app's" for its own field.
 *
 * The question is asked per ROW, over that row's own line, and never over the
 * whole frontmatter body. The readers stop at the FIRST matching line while
 * `parseSimpleProperties` emits one row per line, so a body-wide answer would
 * make every row of a duplicated key agree: it would render a hand-written junk
 * line read-only (stranding it behind a block-replace widget), and with the junk
 * line FIRST it would leave the canonical line's row as an editable checkbox,
 * which is the very writer this rule exists to remove.
 *
 * A reader that does not recognise the value means the value is not app state at
 * all: a hand-edited or imported line, which the user must be able to see and
 * fix, the same rule a dangling `cover:` already followed. The key must also be
 * spelled canonically, since every reader is anchored and case-sensitive while
 * `isManagedFrontmatterField` is deliberately case-insensitive for the
 * IMPORTERS' question, so `Folder_Index:` is a user's line and stays editable.
 * `title` is promoted to the note-title field and `cover` keeps its own
 * conditional rule, which is why neither appears below.
 */
const MANAGED_FIELD_READERS: Record<
  Exclude<ManagedFrontmatterField, "title" | "cover">,
  (line: string, rawValue: string) => boolean
> = {
  updated: (line) => readUpdatedFromFmBody(line) !== null,
  // `readFolderFromFmBody` answers for any non-empty scalar, but the APP's read
  // is narrower: `loadNoteBatch` keeps `folder:` only when js-yaml hands back a
  // string. The question is therefore asked of that same parser, on the raw
  // scalar, rather than of the Myne type authority: the authority resolves under
  // CORE_SCHEMA by design (§3.6.4, so dates stay strings), while the app reads
  // with js-yaml's default schema, where a bare date or `~` is not a string. The
  // two answers agree with the app instead of approximating it.
  folder: (line, rawValue) =>
    readFolderFromFmBody(line) !== null && resolvesToYamlString(rawValue),
  trashed: (line) => readTrashedFromFmBody(line) !== null,
  template: (line) => readTemplateFromFmBody(line),
  folder_index: (line) => readFolderIndexFromFmBody(line),
  archived: (line) => readArchivedFromFmBody(line) !== null,
  done: (line) => readDoneFromFmBody(line) !== null,
  deleted: (line) => readDeletedFromFmBody(line) !== null,
  conflict: (line) => readConflictFromFmBody(line),
  // Deliberately NOT read-only, and this is the one field where the answer is a
  // judgement rather than a reader: `readConflictOfFromFmBody` accepts ANY
  // non-empty scalar (it is not value-strict), so a reader-based `true` here
  // would make a hand-written `conflict_of: note three` un-editable and
  // un-removable, which the rule above forbids. The field is meaningful only
  // alongside `conflict: true`, and that row IS read-only, so the pair is still
  // guarded on the flag side. Making this read-only owes a value-strict reader
  // in `dialect/src/surgery.ts` first, which is a wider change than this one.
  conflict_of: () => false,
  // Deliberately NOT read-only either, for a different reason: this is the one
  // managed field with no action that CLEARS it. `patchKindField` has a single
  // production caller (`drawingNote.ts`, which passes `drawing`), nothing writes
  // `kind: task` at all, and no action anywhere passes `null`. A read-only row
  // would therefore strand a `kind:` marker the user cannot remove from the
  // panel and no action can remove either. It joins the rule the day a task
  // marker action (write and clear) exists.
  kind: () => false,
};

/**
 * Whether the app OWNS the value this row shows, which decides whether the row
 * is writable (myne-md/myne#872).
 *
 * Only a scalar row can be app state: no managed field's canonical value is a
 * YAML sequence (§3.6.1), so a sequence-valued one is junk by shape and stays
 * editable. Everything else is the reader's answer about the row's own line,
 * with one co-check, `done:`, which the app only writes and only clears on a
 * task note (see below).
 */
function managedFieldOwnsValue(
  prop: PropertyRow,
  rows: readonly PropertyRow[],
): boolean {
  if (prop.kind !== "scalar") return false;
  // `done:` is read-only only on a note whose class marker makes it clearable.
  // `patchNoteCompletion` refuses with `NotATaskNoteError` before it touches the
  // field and `uncompleteNote` is the only path that deletes it, so a `done:`
  // arrived at by hand (or from another build) on a note with no `kind: task`
  // has no action that could ever remove it, and the block-replace widget leaves
  // no other route to the line. Same reasoning as the `kind:` exemption below,
  // one field over.
  if (prop.key === "done" && !hasTaskClassMarker(rows)) return false;
  // OWN-property only. The record is an object literal, so a plain index lookup
  // answers for `Object.prototype` members too: a user's own frontmatter key
  // named `constructor:` or `toString:` would find a real function that returns
  // truthy, and their row would be drawn read-only under a note claiming Myne
  // writes it, while `__proto__:` or `valueOf:` hands back a non-callable and
  // the whole widget throws. Every one of those names is a legal frontmatter key
  // (`PROPERTY_LINE_RE`), so this is reachable from an ordinary note. The
  // importer's `isManagedFrontmatterField` cannot be the gate here: it is
  // case-insensitive, which this rule deliberately is not.
  // `Object.hasOwn` would read better and needs a lib this package does not
  // target (ES2022), so the prototype method is called explicitly.
  if (
    !Object.prototype.hasOwnProperty.call(MANAGED_FIELD_READERS, prop.key)
  ) {
    return false;
  }
  const reader =
    MANAGED_FIELD_READERS[
      prop.key as keyof typeof MANAGED_FIELD_READERS
    ];
  // The row's own line, in the column-zero shape every reader is anchored on.
  // `prop.value` keeps any trailing comment, which the readers strip themselves.
  // It is also handed over raw, because js-yaml sees the raw scalar: a quoted
  // `"123"` is a string to both readers while the decoded one is not.
  return reader(`${prop.key}: ${prop.value}\n`, prop.value);
}

/**
 * Whether these rows declare the note a note-task (`kind: task`), which is the
 * gate the completion action itself uses (`src/notes/completeNoteCore.ts`).
 *
 * Read through the field's own value-strict reader, so a quoted or differently
 * spelled marker answers as it does everywhere else.
 */
function hasTaskClassMarker(rows: readonly PropertyRow[]): boolean {
  // The FIRST `kind:` row, not any of them: `readKindFromFmBody` is
  // first-line-wins (its own doc says so), so `kind: chore` followed by
  // `kind: task` is NOT a task note to the completion action, and a `.some`
  // here would draw `done:` read-only on a note whose stamp nothing can clear.
  const first = rows.find((row) => row.kind === "scalar" && row.key === "kind");
  if (first === undefined || first.kind !== "scalar") return false;
  return readKindFromFmBody(`kind: ${first.value}\n`) === TASK_KIND_VALUE;
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
      // A Myne-managed field the app owns renders read-only (myne-md/myne#872).
      // Placed before the kind dispatch, so a managed key carrying a
      // hand-written sequence value never reaches the reader table.
      if (managedFieldOwnsValue(prop, this.properties) && prop.kind === "scalar") {
        list.appendChild(this.renderManagedRow(prop));
        continue;
      }
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

    // A `<textarea>`, not an `<input>`, because a title does not fit on one line
    // and an input CANNOT wrap: myne-md/myne#945 item 01 showed a real title
    // ("Software Testing HW - Nature-Inspired Algorithms - For Wee…") cut off
    // at the pane edge with the rest unreachable, so the field scrolled instead of
    // growing. A one-row textarea that grows to its own `scrollHeight` flows
    // onto two and then three lines and only then scrolls, which is the
    // behaviour the surface always implied.
    //
    // The single-line SEMANTICS are kept by hand: Enter never inserts a newline
    // (it blurs, which is what commits), and `white-space: pre-wrap` in the
    // stylesheet keeps a pasted line break from being silently swallowed.
    const input = document.createElement("textarea");
    input.rows = 1;
    input.className = "cm-fm-properties-name";
    input.value = displayValue;
    input.placeholder = i18n.t("common.untitled");
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", i18n.t("editor.frontmatter.titleAriaLabel"));
    // myne#653: this is now where a note gets its name, since creating one no
    // longer opens the sidebar's inline rename. It had no testid, so the E2E
    // suite had nothing to type into (`src/AGENTS.md`: "A screen without
    // testids is invisible to E2E").
    input.setAttribute("data-testid", TITLE_FIELD_TESTID);

    // Grow to fit the wrapped title. `height: auto` first, because `scrollHeight`
    // of a box that already has a height is that height, so shrinking back after
    // a deletion would otherwise never happen.
    const autosize = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    input.addEventListener("input", autosize);
    // `toDOM` has not been inserted yet, and `scrollHeight` of a detached element
    // is 0, which would collapse the field to its padding.
    queueMicrotask(autosize);

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
  /**
   * The row's leading glyph, which now NAMES the property's type rather than
   * repeating the same `≡` down the whole list (myne-md/myne#777).
   *
   * Text glyphs rather than the `Icon` component on purpose: this is a
   * CodeMirror widget built from raw DOM, with no React in reach, and pulling
   * the icon set in here would mean shipping a second renderer for it.
   */
  private makeIcon(type?: PropertyType): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "cm-fm-properties-icon";
    icon.dataset.propertyType = type ?? "unknown";
    icon.textContent =
      type === "date"
        ? "◫"
        : type === "number"
          ? "#"
          : type === "checkbox"
            ? "☑"
            : type === "list"
              ? "⋮"
              : "≡";
    // Decorative: the key is right beside it and is the accessible name.
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  /** The editable key input, shared by scalar and sequence rows. The commit
   *  and the Enter / Escape behaviour are identical; the value cell is what
   *  differs.
   *
   *  The commit is addressed by the row's OWN line offset, not by its key
   *  (myne-md/myne#872): a body may carry the same key twice, and a key lookup
   *  renames the first line no matter which row was edited. */
  private makeKeyInput(
    view: EditorView,
    key: string,
    lineFrom: number,
  ): HTMLInputElement {
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "cm-fm-properties-key";
    keyInput.value = key;
    keyInput.spellcheck = false;
    keyInput.autocomplete = "off";
    keyInput.addEventListener("change", () => {
      this.commitKey(view, { key, lineFrom }, keyInput.value);
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

    // The property's TYPE, from the one authority that owns the question
    // (`propertyTyping.ts`, markdown-dialect.md 3.6.4, pinned by the
    // `property-coercion` golden vectors). It was already computed for Saved
    // Views and ignored here, so every scalar rendered as a plain text input:
    // a date was a text field, a checkbox was a text field, and a number was a
    // text field that accepted "banana" (myne-md/myne#777).
    //
    // Consuming it rather than re-deriving is not a preference — the file's own
    // header states that siblings consume this typing and never redefine it,
    // and a second opinion about what `2026-01-02` is would be a second answer
    // the query engine and the widget could disagree on.
    const typed = coerceSourceScalar(prop.value);

    row.appendChild(this.makeIcon(typed.type));
    row.appendChild(this.makeKeyInput(view, prop.key, prop.lineFrom));

    const valueInput = document.createElement("input");
    // A NATIVE date input silently refuses a value it cannot parse: the field
    // renders empty and the user's text looks lost. The type authority's date
    // recogniser is shape-only (`\d{4}-\d{2}-\d{2}` and friends), so
    // `2026-13-45` types as `date` — correct for the index, which is answering
    // "what kind of thing is this", and dangerous here, which is answering
    // "what control can hold it".
    //
    // That recogniser is pinned by the published `property-coercion` vectors
    // and is not this widget's to change. The widget's job is to refuse the
    // native control for a value the native control would eat.
    const nativeDateOk = typed.type === "date" && isCalendarDate(prop.value);
    // `date` and `number` get the native control for their type: a date picker
    // and a numeric field with the platform's own affordances, rather than a
    // text box the user has to know the format of. `checkbox` is handled
    // separately below because its VALUE lives in `.checked`, not `.value`.
    valueInput.type = nativeDateOk
      ? "date"
      : typed.type === "number"
        ? "number"
        : "text";
    valueInput.className = "cm-fm-properties-value";
    valueInput.dataset.propertyType = typed.type;
    valueInput.value = prop.value;
    valueInput.spellcheck = false;
    valueInput.autocomplete = "off";
    valueInput.addEventListener("change", () => {
      this.commitValue(view, prop, valueInput.value);
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
    if (typed.type === "checkbox") {
      // A boolean rendered as a text field is the clearest case of the widget
      // ignoring what it already knew: the user had to type the word `true`.
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "cm-fm-properties-checkbox";
      box.dataset.propertyType = "checkbox";
      box.checked = typed.value === "true";
      box.setAttribute("aria-label", prop.key);
      box.addEventListener("change", () => {
        this.commitValue(view, prop, box.checked ? "true" : "false");
      });
      row.appendChild(box);
      return row;
    }

    row.appendChild(valueInput);

    return row;
  }

  /**
   * A row for a Myne-managed field whose value the app OWNS
   * ({@link managedFieldOwnsValue}). Scalar only: a sequence-valued managed key
   * is junk by shape and never gets here.
   *
   * Visible but not writable, and the two halves are separately load-bearing.
   * Visible, because the line is in the file: hiding a managed field would put
   * a byte in the note that appears nowhere in the interface, which is the
   * plain-markdown portability commitment the `cover:` skip is careful about.
   * Not writable, because the value this row shows is app state, and this panel
   * writes through body autosave while the app's own action is what owns it
   * (markdown-dialect.md §3.6.1 names a writer per field). One click on the
   * checkbox this row used to be turned `folder_index: true` into
   * `folder_index: false`, a value no Myne action produces and the undesignate
   * path never writes, because it DELETES the field (myne-md/myne#872).
   *
   * The value is printed VERBATIM from the row's own value bytes, quotes and
   * trailing comment included, because this row is the only representation of
   * that line anywhere in the app. A display-normalised value would show
   * something that matches neither the file nor what the reader saw.
   *
   * Static text rather than a `disabled` input: a disabled control still reads
   * as "this is where you edit this, later", and the user has no way to learn
   * where. The `role`/`aria-label` pair carries the same reason the `title`
   * does, for the pointer-free case (touch and keyboard), since a tooltip needs
   * hover.
   */
  private renderManagedRow(
    prop: Extract<PropertyRow, { kind: "scalar" }>,
  ): HTMLElement {
    const managedNote = i18n.t("editor.frontmatter.managedField");
    const row = document.createElement("div");
    row.className = "cm-fm-properties-row";
    row.dataset.managed = "true";
    // Key-scoped, because a note carries several managed rows at once
    // (`folder:` and `updated:` at least) and a caller that means "the
    // folder_index row" has to be able to say so.
    row.dataset.managedKey = prop.key;
    row.setAttribute("data-testid", MANAGED_ROW_TESTID);
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `${prop.key}: ${prop.value}. ${managedNote}`);
    row.title = managedNote;

    row.appendChild(this.makeIcon(coerceSourceScalar(prop.value).type));

    const key = document.createElement("span");
    key.className = "cm-fm-properties-key-static";
    key.textContent = prop.key;
    row.appendChild(key);

    const value = document.createElement("span");
    value.className = "cm-fm-properties-value-static";
    value.textContent = prop.value;
    row.appendChild(value);

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
    // A sequence row's key rename is row-scoped too (`prop.lineFrom`); its
    // ITEM add/remove helpers stay key-addressed, which is stated at
    // `commitAddItem`, because a document carrying the same key twice is
    // ambiguous YAML for them either way.
    row.appendChild(this.makeKeyInput(view, prop.key, prop.lineFrom));

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
   *
   * Key-addressed, unlike {@link commitKey} and {@link commitValue}: the
   * sequence planner resolves the key's own line, and a document carrying the
   * same sequence key twice is ambiguous YAML for it either way. The managed
   * fields this file draws read-only are all scalars, so the guarantee that
   * change owes (`myne-md/myne#872`) is not reached through here.
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

  /**
   * Rename one row's key, addressed by the row's OWN line offset.
   *
   * `row` is the captured identity of the row that drew the input: its key and
   * the offset its line started at. A key lookup cannot stand in for it, because
   * a body may carry the same key twice and the lookup would rename the FIRST
   * line whichever row the user typed in (myne-md/myne#872). The captured pair
   * is re-checked against a fresh parse, so a widget whose document moved under
   * it refuses the write instead of renaming a line it was never looking at.
   */
  private commitKey(
    view: EditorView,
    row: { key: string; lineFrom: number },
    nextKeyRaw: string,
  ): void {
    const nextKey = nextKeyRaw.trim();
    if (nextKey === row.key) return;
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
    const live = props.find((p) => p.lineFrom === row.lineFrom);
    if (live === undefined || live.key !== row.key) return;
    // Reject collision with another existing key — would produce
    // duplicate YAML keys, undefined parse behavior.
    if (props.some((p) => p !== live && p.key === nextKey)) return;
    view.dispatch({
      changes: {
        from: live.lineFrom,
        to: live.lineFrom + row.key.length,
        insert: nextKey,
      },
      userEvent: "frontmatter.rename-key",
    });
  }

  /**
   * Write one row's value, addressed by the row's OWN byte range.
   *
   * Same reasoning as {@link commitKey}: the captured range is re-checked
   * against a fresh parse by position, and the row's key and previous value must
   * still be the ones that drew the control, so a stale widget refuses rather
   * than writing a neighbouring line of the same key. That matters most for the
   * rows this file now draws read-only: without it, the editable row of a
   * duplicated managed key wrote the canonical line the rule exists to protect,
   * which is the defect one layer down (myne-md/myne#872).
   */
  private commitValue(view: EditorView, prop: SimpleProperty, next: string): void {
    const range = cachedLocateFrontmatter(view.state.doc);
    if (range === null) return;
    const doc = view.state.doc.toString();
    const live = parseSimpleProperties(doc, range).find(
      (p) => p.valueFrom === prop.valueFrom,
    );
    if (live === undefined || live.key !== prop.key || live.value !== prop.value) {
      return;
    }
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
    input: HTMLTextAreaElement,
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
