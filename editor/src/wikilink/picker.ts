// `[[` note-picker CM6 ViewPlugin (`wikilink.md` §6.1). Opens a floating,
// fuzzy-searchable list of vault notes when the user types `[[` (or via the
// `/wiki` slash command / `Cmd+Shift+L`), and inserts the canonical §3 link via
// the shared `emitNoteWikilink` emitter (WL-4). Candidates come from the WL-5
// note-set facet (`readNoteSet`); ranking reuses the shared `fuzzyFilter` scorer
// — no new dependency. Modeled on `src/editor/template-tokens/plugin.ts`
// (closeBrackets-aware `[[`/`]]`, the same move/confirm/dismiss primitives).
//
// The in-progress `[[…]]` the picker is authoring is kept as RAW, editable text
// (no chip, not atomic) while the picker is open — see `pickerActiveFromField`,
// which the chip + atomic-range builders read to skip the active node. This
// avoids mutating the doc (no `]]` strip) or moving the cursor, so arrow keys /
// clicks behave normally; the menu is navigated with ↑/↓ + Enter.

import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  keymap,
  type Command,
  type KeyBinding,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { computePosition } from "../positioning";
import { ensureFloatingStyles } from "../floating-styles";
import { isSlashSuppressed } from "../slash/plugin";
import { readNoteSet } from "./note-set";
import { readVaultHeadings, vaultHeadingsExtension } from "./vault-headings";
import {
  readVaultBlockAnchors,
  vaultBlockAnchorsExtension,
} from "./vault-block-anchors";
import { rankNotes, type PickerRow } from "./picker-rank";
import {
  rankCurrentHeadings,
  rankVaultHeadings,
  rankVaultBlockAnchors,
  type CurrentHeadingRow,
  type VaultHeadingRow,
  type VaultBlockAnchorRow,
} from "./picker-heading-rank";
import { headingSections } from "@myne/dialect";
import {
  emitNoteWikilink,
  emitFolderWikilink,
  emitHeadingAnchorWikilink,
  emitVaultHeadingWikilink,
  emitVaultBlockAnchorWikilink,
} from "./emit";

// MYND-305: the picker has three modes, discriminated by the filter prefix after
// `[[`. `##query` → vault-wide headings; `#query` → current-note headings; else
// the default note picker. The union row type the render/move/confirm path
// agrees on.
type AnchorPickerRow = CurrentHeadingRow | VaultHeadingRow | VaultBlockAnchorRow;
type AnyPickerRow = PickerRow | AnchorPickerRow;

type PickerMode =
  | { kind: "note"; query: string }
  | { kind: "current-heading"; query: string }
  | { kind: "vault-heading"; query: string }
  | { kind: "vault-block-anchor"; query: string };

/** Classify the raw filter (the text after `[[`) into a picker mode + its query.
 *  `^^x` → vault-block-anchor "x" (MYND-382); `##x` → vault-heading "x";
 *  `#x` → current-heading "x"; otherwise note "x". */
export function classifyPickerFilter(filter: string): PickerMode {
  if (filter.startsWith("^^"))
    return { kind: "vault-block-anchor", query: filter.slice(2) };
  if (filter.startsWith("##")) return { kind: "vault-heading", query: filter.slice(2) };
  if (filter.startsWith("#")) return { kind: "current-heading", query: filter.slice(1) };
  return { kind: "note", query: filter };
}

// The picker AUTHORS wikilinks, so the cursor being inside a (new, empty)
// wikilink is the TRIGGER, not a suppressor — only code spans / URLs suppress
// it. (The shared `isSlashSuppressed` default includes "Wikilink", which would
// block the picker the moment closeBrackets formed `[[]]`.)
const PICKER_SUPPRESS_NODES: ReadonlySet<string> = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "URL",
]);

/** The `[[` start of the wikilink the picker is actively authoring, or null.
 *  The chip + atomic-range builders (`chip-widget.ts`) skip the node at this
 *  position so the in-progress `[[filter]]` stays raw/editable (no chip,
 *  backspace-safe) until the picker closes. Position is mapped through edits. */
export const setPickerActiveFrom = StateEffect.define<number | null>();
export const pickerActiveFromField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPickerActiveFrom)) value = e.value;
    }
    if (value !== null && tr.docChanged) value = tr.changes.mapPos(value, -1);
    return value;
  },
});

type MenuState = {
  triggerFrom: number; // position of the first `[` of `[[`
  triggerTo: number; // cursor head (end of the typed filter)
  selectedIndex: number;
};

class WikilinkPickerView implements PluginValue {
  private container: HTMLDivElement | null = null;
  private state: MenuState | null = null;
  private rafHandle: number | null = null;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    ensureFloatingStyles();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      const head = update.view.state.selection.main.head;
      if (this.state === null) {
        const before = update.view.state.doc.sliceString(Math.max(0, head - 2), head);
        if (
          before === "[[" &&
          !isSlashSuppressed(update.view.state, head - 1, PICKER_SUPPRESS_NODES)
        ) {
          this.open(head - 2, head);
        }
      } else {
        this.state = { ...this.state, triggerTo: head, selectedIndex: 0 };
        this.scheduleRender();
      }
    }
    if (update.selectionSet && this.state !== null) {
      const head = update.view.state.selection.main.head;
      if (head < this.state.triggerFrom + 2 || head > this.state.triggerTo + 1) {
        this.close();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.clearMenu();
  }

  private currentFilter(): string {
    if (this.state === null) return "";
    return this.view.state.doc.sliceString(this.state.triggerFrom + 2, this.state.triggerTo);
  }

  /** The ranked rows for the current filter — the one source render/move/confirm
   *  agree on. Mode (note / current-heading / vault-heading) is the filter
   *  prefix (MYND-305). */
  private currentRows(): AnyPickerRow[] {
    const mode = classifyPickerFilter(this.currentFilter());
    if (mode.kind === "current-heading") {
      return rankCurrentHeadings(
        mode.query,
        headingSections(this.view.state.doc.toString()),
      );
    }
    if (mode.kind === "vault-heading") {
      return rankVaultHeadings(mode.query, readVaultHeadings(this.view.state));
    }
    if (mode.kind === "vault-block-anchor") {
      // MYND-382: `[[^^` — vault-wide imported block anchors (enumerate-only).
      return rankVaultBlockAnchors(
        mode.query,
        readVaultBlockAnchors(this.view.state),
      );
    }
    return rankNotes(mode.query, readNoteSet(this.view.state));
  }

  private open(triggerFrom: number, triggerTo: number): void {
    this.state = { triggerFrom, triggerTo, selectedIndex: 0 };
    // Mark this `[[…]]` as the active picker node so the chip + atomicity skip
    // it — the in-progress text stays raw/editable (no doc mutation, no cursor
    // move). The `]]` is left intact; `applyRow` replaces the whole span.
    this.setActiveFrom(triggerFrom);
    this.scheduleRender();
  }

  /** Publish the active `[[` start (or null) to `pickerActiveFromField`. Deferred
   *  via microtask because open()/close() can run during an update, where
   *  `dispatch` throws. */
  private setActiveFrom(from: number | null): void {
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (this.view.state.field(pickerActiveFromField, false) === from) return;
      this.view.dispatch({ effects: setPickerActiveFrom.of(from) });
    });
  }

  /** DOM + state teardown only (no field dispatch) — used by `applyRow`, which
   *  clears the field synchronously in its own insert transaction. */
  private clearMenu(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.container !== null) {
      this.container.remove();
      this.container = null;
    }
    this.state = null;
  }

  private close(): void {
    this.clearMenu();
    this.setActiveFrom(null);
  }

  private scheduleRender(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  private render(): void {
    if (this.state === null) return;
    const filter = this.currentFilter();
    // A `]`/`[`/newline in the filter means the user left the link → close
    // (note titles/paths legitimately contain spaces, `-`, `/`, digits — those
    // do NOT close).
    if (/[[\]\n]/.test(filter)) {
      this.close();
      return;
    }
    const rows = this.currentRows();
    if (rows.length === 0) {
      // No matches → close (never create a note, §6.1/§9).
      this.close();
      return;
    }
    if (this.state.selectedIndex >= rows.length) {
      this.state.selectedIndex = rows.length - 1;
    }

    if (this.container === null) {
      this.container = document.createElement("div");
      this.container.className = "cm-slash-menu cm-wiki-picker";
      this.container.setAttribute("role", "menu");
      document.body.appendChild(this.container);
    }
    this.container.replaceChildren();
    let selectedRow: HTMLDivElement | null = null;
    rows.forEach((row, i) => {
      const el = document.createElement("div");
      el.className = "cm-slash-menu-row cm-wiki-picker-row";
      if (i === this.state!.selectedIndex) {
        el.classList.add("cm-slash-menu-row-selected");
        selectedRow = el;
      }
      el.setAttribute("role", "menuitem");
      // `mousemove`, NOT `mouseenter`: keyboard nav rebuilds the rows on every
      // press, so a synthetic enter under a stationary pointer would yank the
      // highlight back to the mouse and fight the arrow keys. See the slash
      // menu (`editor/slash/plugin.ts`) for the full rationale.
      el.addEventListener("mousemove", () => {
        if (this.state === null || this.state.selectedIndex === i) return;
        this.state.selectedIndex = i;
        this.container
          ?.querySelectorAll(".cm-slash-menu-row")
          .forEach((r, idx) => r.classList.toggle("cm-slash-menu-row-selected", idx === i));
      });
      this.renderRowBody(el, row);
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.applyRow(row);
      });
      this.container!.appendChild(el);
    });

    const surfaceWidth = 320;
    const surfaceHeight = Math.min(12 + rows.length * 40, 320);
    const coords = this.view.coordsAtPos(this.state.triggerTo);
    let anchorRect;
    if (coords !== null) {
      anchorRect = { left: coords.left, top: coords.top, right: coords.right, bottom: coords.bottom };
    } else {
      const editorRect = this.view.contentDOM.getBoundingClientRect();
      anchorRect = {
        left: editorRect.left + 16,
        top: editorRect.top + 16,
        right: editorRect.left + 32,
        bottom: editorRect.top + 32,
      };
    }
    const pos = computePosition({
      anchor: anchorRect,
      surfaceWidth,
      surfaceHeight,
      preferredPlacement: "below",
    });
    this.container.style.position = "fixed";
    this.container.style.left = `${pos.left}px`;
    this.container.style.top = `${pos.top}px`;
    this.container.style.width = `${surfaceWidth}px`;
    this.container.style.zIndex = "1000";

    if (selectedRow !== null) {
      (selectedRow as HTMLDivElement).scrollIntoView({ block: "nearest" });
    }
  }

  /** Paint one row's body by kind (Task 4, the `[design]` subtask). The note +
   *  folder rows keep their existing look; the two heading kinds (MYND-305) reuse
   *  the same row chrome + design tokens but carry distinct testids and a context
   *  line: `[[#` rows show a `#` glyph + the heading text (no note context — it's
   *  the current note); `[[##` rows show the heading over a smaller note-context
   *  line (title), matching the note row's title-over-path stack so the two pick
   *  surfaces read consistently. */
  private renderRowBody(el: HTMLDivElement, row: AnyPickerRow): void {
    if (row.kind === "folder") {
      // Folder-target row (MYND-370): a folder glyph + the trailing-slash path,
      // visually distinct from a note's title-over-path stack.
      el.classList.add("cm-wiki-picker-folder-row");
      el.setAttribute("data-testid", "picker.folder-row");
      const glyph = document.createElement("span");
      glyph.className = "cm-slash-menu-icon cm-wiki-picker-folder-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "▸";
      const label = document.createElement("span");
      label.className = "cm-slash-menu-label cm-wiki-picker-title";
      label.textContent = row.path;
      el.append(glyph, label);
      return;
    }
    if (row.kind === "current-heading") {
      // `[[#` — a CURRENT-NOTE heading. A `#` glyph (its repeat hints the level)
      // + the heading text. No note context: it's this note.
      el.classList.add("cm-wiki-picker-heading-row");
      el.setAttribute("data-testid", "picker.heading-row");
      el.setAttribute("data-heading-scope", "current");
      const glyph = document.createElement("span");
      glyph.className = "cm-slash-menu-icon cm-wiki-picker-heading-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "#".repeat(Math.min(row.level, 6));
      const label = document.createElement("span");
      label.className = "cm-slash-menu-label cm-wiki-picker-title";
      label.textContent = row.heading;
      el.append(glyph, label);
      return;
    }
    if (row.kind === "vault-heading") {
      // `[[##` — a VAULT-WIDE heading. The heading text over a smaller context
      // line naming its note, so two notes' `## Setup` are distinguishable.
      el.classList.add("cm-wiki-picker-heading-row", "cm-wiki-picker-vault-heading-row");
      el.setAttribute("data-testid", "picker.vault-heading-row");
      el.setAttribute("data-heading-scope", "vault");
      const heading = document.createElement("span");
      heading.className = "cm-slash-menu-label cm-wiki-picker-title";
      heading.textContent = row.entry.heading;
      const context = document.createElement("span");
      context.className = "cm-wiki-picker-path";
      context.textContent = row.entry.title ?? "";
      el.append(heading, context);
      return;
    }
    if (row.kind === "vault-block-anchor") {
      // `[[^^` (MYND-382) — a VAULT-WIDE imported block anchor. The block's
      // preview text (a `^` glyph prefix hints it's a block) over a smaller
      // context line naming the owning note + block id.
      el.classList.add(
        "cm-wiki-picker-heading-row",
        "cm-wiki-picker-vault-heading-row",
      );
      el.setAttribute("data-testid", "picker.vault-block-anchor-row");
      el.setAttribute("data-heading-scope", "vault");
      const glyph = document.createElement("span");
      glyph.className = "cm-slash-menu-icon cm-wiki-picker-heading-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "^";
      const label = document.createElement("span");
      label.className = "cm-slash-menu-label cm-wiki-picker-title";
      label.textContent =
        row.entry.preview !== "" ? row.entry.preview : `^${row.entry.blockId}`;
      const context = document.createElement("span");
      context.className = "cm-wiki-picker-path";
      const noteName = row.entry.title ?? "";
      context.textContent =
        noteName !== "" ? `${noteName} · ^${row.entry.blockId}` : `^${row.entry.blockId}`;
      el.append(glyph, label, context);
      return;
    }
    // Default: a note row — title over a smaller vault-path line.
    el.setAttribute("data-testid", "picker.note-row");
    const title = document.createElement("span");
    title.className = "cm-slash-menu-label cm-wiki-picker-title";
    title.textContent = row.note.title ?? "";
    const path = document.createElement("span");
    path.className = "cm-wiki-picker-path";
    path.textContent = row.path;
    el.append(title, path);
  }

  private emitForRow(row: AnyPickerRow): string {
    switch (row.kind) {
      case "folder":
        return emitFolderWikilink(row.path);
      case "current-heading":
        return emitHeadingAnchorWikilink(row.heading);
      case "vault-heading":
        return emitVaultHeadingWikilink(
          row.entry.folder,
          row.entry.title ?? "",
          row.entry.heading,
        );
      case "vault-block-anchor":
        return emitVaultBlockAnchorWikilink(
          row.entry.folder,
          row.entry.title ?? "",
          row.entry.blockId,
        );
      default:
        return emitNoteWikilink(row.note.folder, row.note.title ?? "");
    }
  }

  private applyRow(row: AnyPickerRow): void {
    if (this.state === null) return;
    const { triggerFrom, triggerTo } = this.state;
    this.clearMenu();
    // Consume a trailing auto-closed `]]` / `]` (closeBrackets) so we don't
    // leave a dangling `]]` after the emitted link's own `]]`.
    let end = triggerTo;
    if (this.view.state.doc.sliceString(triggerTo, triggerTo + 2) === "]]") {
      end = triggerTo + 2;
    } else if (this.view.state.doc.sliceString(triggerTo, triggerTo + 1) === "]") {
      end = triggerTo + 1;
    }
    const insert = this.emitForRow(row);
    this.view.dispatch({
      changes: { from: triggerFrom, to: end, insert },
      selection: { anchor: triggerFrom + insert.length },
      // Clear the active node IN THIS transaction so the freshly-inserted link
      // chips immediately (not skipped as "still being authored").
      effects: setPickerActiveFrom.of(null),
    });
    this.view.focus();
  }

  move(delta: number): boolean {
    if (this.state === null) return false;
    const n = this.currentRows().length;
    if (n === 0) return false;
    this.state = {
      ...this.state,
      selectedIndex: (this.state.selectedIndex + delta + n) % n,
    };
    this.scheduleRender();
    return true;
  }

  confirm(): boolean {
    if (this.state === null) return false;
    const row = this.currentRows()[this.state.selectedIndex];
    if (row !== undefined) {
      this.applyRow(row);
    } else {
      this.close();
    }
    return true;
  }

  dismiss(): boolean {
    if (this.state === null) return false;
    this.close();
    return true;
  }

  isOpen(): boolean {
    return this.state !== null;
  }
}

const wikilinkPickerPlugin = ViewPlugin.fromClass(WikilinkPickerView);

/** Programmatically open the picker at the cursor (for `/wiki` + `Cmd+Shift+L`).
 *  Inserts a BARE `[[` (no closeBrackets auto-close on a programmatic dispatch),
 *  which the plugin's `update` then opens on. */
export const openWikilinkPicker: Command = (view) => {
  const head = view.state.selection.main.head;
  if (isSlashSuppressed(view.state, head, PICKER_SUPPRESS_NODES)) return false;
  view.dispatch({
    changes: { from: head, insert: "[[" },
    selection: { anchor: head + 2 },
  });
  view.focus();
  return true;
};

function wikilinkPickerKeymap(): readonly KeyBinding[] {
  const whenOpen =
    (fn: (v: WikilinkPickerView) => boolean): Command =>
    (view) => {
      const inst = view.plugin(wikilinkPickerPlugin);
      if (inst === null || !inst.isOpen()) return false;
      return fn(inst);
    };
  return [
    { key: "ArrowDown", run: whenOpen((v) => v.move(1)) },
    { key: "ArrowUp", run: whenOpen((v) => v.move(-1)) },
    { key: "Enter", run: whenOpen((v) => v.confirm()) },
    { key: "Escape", run: whenOpen((v) => v.dismiss()) },
  ];
}

export function wikilinkPickerExtension(): Extension {
  return [
    pickerActiveFromField,
    // MYND-305: the vault-wide heading facet the `[[##` mode reads (seeded empty;
    // the host reconfigures it). Composed here so the picker plugin can read it.
    vaultHeadingsExtension(),
    // MYND-382: the vault-wide imported-block-anchor facet the `[[^^` mode reads
    // (seeded empty; the host reconfigures it), same injection mechanism.
    vaultBlockAnchorsExtension(),
    wikilinkPickerPlugin,
    Prec.highest(keymap.of(wikilinkPickerKeymap())),
  ];
}
