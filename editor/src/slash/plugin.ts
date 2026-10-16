// Slash menu CM6 ViewPlugin — intercepts `/` typing, opens a floating
// fuzzy-match menu of insertable commands.
//
// PRD `editor-mvp-baseline` stories 29-34. Trigger-context check suppresses
// the menu when the user types `/` inside a fenced code block range, an
// inline link URL portion, or a wikilink range — `/` is content there.
//
// Implementation: vanilla DOM floating menu (no React); shared positioning
// helper from `src/editor/positioning.ts` places the menu below the cursor
// (or above if no room below).

import { syntaxTree } from "@codemirror/language";
import { Prec, type Extension } from "@codemirror/state";
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
import { floatingSurfacePresentation } from "../host";
import { createDockedPicker, type DockedPicker } from "../floating/docked-sheet";
import { filterCommands, type SlashCommand } from "./commands";
import { makeSlashIcon } from "./icons";
import { aiSlashEnabledFacet, slashCommandsForContext } from "./aiSlash";
import i18n from "@myne/editor/i18n";

const SUPPRESS_NODE_NAMES = new Set<string>([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "URL",
  "Wikilink",
]);

/**
 * Returns true if position `pos` lies within a syntax tree node whose name
 * indicates `/` should be treated as content (code block / link URL /
 * wikilink). Pure function — testable without a view.
 */
export function isSlashSuppressed(
  state: { doc: { sliceString: (a: number, b: number) => string; length: number } } & Parameters<typeof syntaxTree>[0],
  pos: number,
  nodeNames: ReadonlySet<string> = SUPPRESS_NODE_NAMES,
): boolean {
  const tree = syntaxTree(state);
  let suppressed = false;
  tree.iterate({
    from: Math.max(0, pos - 1),
    to: pos,
    enter: (node) => {
      // Containment, not mere touching (myne#407). Lezer's `iterate` enters
      // every node that TOUCHES the [pos-1, pos] range — including a suppressed
      // node ending exactly at the caret's just-left boundary (`node.to === pos`),
      // i.e. the node the caret has already stepped out of. That wrongly killed
      // the trigger for one character after a wikilink / inline code / fenced
      // block / URL. Require the node to actually COVER the trigger position:
      // `from <= pos` (it starts at or before) and `to > pos` (it has not ended).
      if (nodeNames.has(node.name) && node.from <= pos && node.to > pos) {
        suppressed = true;
        return false;
      }
      return undefined;
    },
  });
  return suppressed;
}

type MenuState = {
  triggerFrom: number;
  triggerTo: number;
  selectedIndex: number;
};

class SlashMenuView implements PluginValue {
  private container: HTMLDivElement | null = null;
  private docked: DockedPicker | null = null;
  private state: MenuState | null = null;
  private rafHandle: number | null = null;
  private readonly commands: readonly SlashCommand[];

  constructor(private readonly view: EditorView) {
    // AI slash commands (`/devam`, `/başlık`) appear only when the host provides
    // `ai_enabled` via `aiSlashEnabledFacet` (default false → base menu; task 6).
    this.commands = slashCommandsForContext({
      aiEnabled: view.state.facet(aiSlashEnabledFacet),
    });
    ensureFloatingStyles();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      let openedFromInsert = false;
      update.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
        const insertedStr = inserted.toString();
        if (insertedStr.endsWith("/") && this.state === null) {
          const pos = toB;
          if (
            !isSlashSuppressed(update.view.state, pos - 1) &&
            this.isLineStartOrAfterWhitespace(update.view, pos - 1)
          ) {
            this.open(pos - 1, pos);
            openedFromInsert = true;
          }
        }
      });
      if (this.state !== null && !openedFromInsert) {
        // Reset highlight to the first match whenever the filter changes, so
        // typing `/todo` + Enter accepts the top result without an arrow press.
        this.state = {
          ...this.state,
          triggerTo: update.view.state.selection.main.head,
          selectedIndex: 0,
        };
        this.scheduleRender();
      }
      // Reopen-on-deletion (myne#408, approach B, continuous). A no-match query
      // closes the menu (`render()` nulls state), and the only open path is an
      // inserted `/` — so backspacing a mistyped query back toward the `/` never
      // brought the menu back. Here: whenever a change leaves the menu closed but
      // the caret is back inside a live `/` query, reopen so the list tracks the
      // query in BOTH directions. Guarded on `state === null`, so it never fights
      // the open-from-insert path above; and because it only latches onto an
      // EXISTING `/`, deleting the `/` itself can never reopen it — that #329
      // close still runs below on `selectionSet`, after this, and wins.
      if (this.state === null) {
        const head = update.view.state.selection.main.head;
        const triggerFrom = this.findSlashTriggerLeftOfCaret(update.view, head);
        if (triggerFrom !== null) this.open(triggerFrom, head);
      }
    }
    if (update.selectionSet && this.state !== null) {
      const head = update.view.state.selection.main.head;
      // `<= triggerFrom`, not `< triggerFrom` (myne#329). The trigger `/` sits
      // AT `triggerFrom`, so a caret landing exactly there means the `/` is gone
      // — Backspace over it — and the menu has nothing left to be about.
      //
      // With the old bound the menu stayed open: the filter slice degenerated to
      // the empty string, the fuzzy filter returns every command for an empty
      // query, and the whole menu kept rendering. The `Prec.highest` Enter
      // binding then consumed the key and applied the first entry, `/h1`, whose
      // `replaceLinePrefix` rewrote the caret's line to `# <line>` and swallowed
      // the newline the user actually asked for. ArrowUp/ArrowDown/Escape and a
      // mousedown on any row were hijacked the same way.
      if (head <= this.state.triggerFrom || head > this.state.triggerTo + 1) {
        this.close();
      }
    }
  }

  destroy(): void {
    this.close();
  }

  private isLineStartOrAfterWhitespace(view: EditorView, slashPos: number): boolean {
    if (slashPos === 0) return true;
    const prev = view.state.doc.sliceString(slashPos - 1, slashPos);
    return prev === " " || prev === "\t" || prev === "\n";
  }

  /** Approach B for myne#408: find the `/` that anchors the slash query the
   *  caret currently sits in, so a deletion landing back inside a live trigger
   *  can reopen the menu. Returns the `/` position, or null when the caret is
   *  not inside a live slash query.
   *
   *  Scans the current line leftward from the caret over the contiguous
   *  non-whitespace run: a slash query never spans whitespace (a space ends it,
   *  which closes the menu on the ensuing no-match), so the first whitespace
   *  breaks the search. The candidate `/` must clear the SAME two guards the
   *  open path uses — `isLineStartOrAfterWhitespace` and the corrected
   *  `isSlashSuppressed` (myne#407) — so a `/` mid-word, or one inside code / a
   *  URL / a wikilink, is never treated as a trigger. Because it only ever
   *  latches onto an existing `/`, deleting the `/` itself cannot reopen the
   *  menu (myne#329). */
  private findSlashTriggerLeftOfCaret(view: EditorView, head: number): number | null {
    const { doc } = view.state;
    const line = doc.lineAt(head);
    let triggerFrom = -1;
    for (let i = head - 1; i >= line.from; i--) {
      const ch = doc.sliceString(i, i + 1);
      if (ch === " " || ch === "\t") return null; // whitespace ends the query run
      if (ch === "/") {
        triggerFrom = i;
        break;
      }
    }
    if (triggerFrom === -1) return null;
    if (
      isSlashSuppressed(view.state, triggerFrom) ||
      !this.isLineStartOrAfterWhitespace(view, triggerFrom)
    ) {
      return null;
    }
    return triggerFrom;
  }

  private open(triggerFrom: number, triggerTo: number): void {
    this.state = { triggerFrom, triggerTo, selectedIndex: 0 };
    this.scheduleRender();
  }

  private close(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.container !== null) {
      this.container.remove();
      this.container = null;
    }
    if (this.docked !== null) {
      this.docked.dispose();
      this.docked.root.remove();
      this.docked = null;
    }
    this.state = null;
  }

  /** The element the rows go into: the anchored popover's own box, or, when the
   *  host declares the docked presentation, the sheet shell's list (myne-md/myne#884).
   *  The two are mutually exclusive and `close()` tears down whichever exists. */
  private surface(): HTMLElement {
    if (floatingSurfacePresentation() === "docked") {
      if (this.docked === null) {
        this.docked = createDockedPicker({
          title: i18n.t("editor.slash.sheetTitle"),
          testId: "editor.slash-menu-sheet",
          closeLabel: i18n.t("common.close"),
          onClose: () => this.dismiss(),
        });
        document.body.appendChild(this.docked.root);
      }
      return this.docked.list;
    }
    if (this.container === null) {
      this.container = document.createElement("div");
      this.container.className = "cm-slash-menu";
      this.container.setAttribute("role", "menu");
      // Mount to document.body so position: fixed escapes any ancestor
      // containing-block context (transform/filter/contain quirks).
      document.body.appendChild(this.container);
    }
    return this.container;
  }

  /** Defer render to next animation frame so `coordsAtPos` returns
   *  measured coords after the DOM update lands. */
  private scheduleRender(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  private render(): void {
    if (this.state === null) return;
    const filter = this.view.state.doc.sliceString(
      this.state.triggerFrom + 1,
      this.state.triggerTo,
    );
    const filtered = filterCommands(this.commands, filter);
    if (filtered.length === 0) {
      this.close();
      return;
    }
    if (this.state.selectedIndex >= filtered.length) {
      this.state.selectedIndex = filtered.length - 1;
    }

    const surface = this.surface();
    surface.replaceChildren();
    let selectedRow: HTMLDivElement | null = null;
    filtered.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = "cm-slash-menu-row";
      if (i === this.state!.selectedIndex) {
        row.classList.add("cm-slash-menu-row-selected");
        selectedRow = row;
      }
      row.setAttribute("role", "menuitem");
      // Hover sets the highlight (parity with keyboard nav). Bound to
      // `mousemove`, NOT `mouseenter`: keyboard nav rebuilds the rows
      // (`replaceChildren`) and `scrollIntoView`s the selection on every press.
      // When the pointer happens to rest over the menu, the browser fires a
      // synthetic `mouseenter`/`mouseover` on whichever fresh row now sits under
      // the (stationary) cursor — which would yank the highlight back to the
      // mouse and fight the arrow keys (the "ArrowDown jumps back to the top"
      // bug). `mousemove` only fires on real pointer motion, so a stationary
      // mouse never hijacks keyboard navigation; genuine hover still works.
      // Update classes in place rather than re-rendering to avoid teardown
      // mid-pointer-move.
      row.addEventListener("mousemove", () => {
        if (this.state === null || this.state.selectedIndex === i) return;
        this.state.selectedIndex = i;
        surface
          .querySelectorAll(".cm-slash-menu-row")
          .forEach((r, idx) =>
            r.classList.toggle("cm-slash-menu-row-selected", idx === i),
          );
      });
      const icon = document.createElement("span");
      icon.className = "cm-slash-menu-icon";
      if (cmd.svgIcon !== undefined) {
        icon.appendChild(makeSlashIcon(cmd.svgIcon));
      } else {
        icon.textContent = cmd.icon;
      }
      const label = document.createElement("span");
      label.className = "cm-slash-menu-label";
      label.textContent = cmd.label;
      row.append(icon, label);
      if (cmd.kbd !== undefined) {
        const kbd = document.createElement("span");
        kbd.className = "cm-slash-menu-kbd";
        kbd.textContent = cmd.kbd;
        row.append(kbd);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.applyCommand(cmd);
      });
      surface.appendChild(row);
    });

    // Only the anchored popover is positioned against the caret. The docked
    // sheet is pinned to the bottom edge by its own stylesheet, so running the
    // positioner there would write inline `left`/`top` over the pinned box.
    if (this.docked === null) {
      // Anchor on the cursor coords; fall back to the editor's content
      // rect center if coords aren't measured yet.
      const surfaceWidth = 300;
      // Cap to the CSS max-height (.cm-slash-menu) so positioning flips above
      // the cursor correctly when the full list would overflow below.
      const surfaceHeight = Math.min(40 + filtered.length * 32, 300);
      const coords = this.view.coordsAtPos(this.state.triggerTo);
      let anchorRect;
      if (coords !== null) {
        anchorRect = {
          left: coords.left,
          top: coords.top,
          right: coords.right,
          bottom: coords.bottom,
        };
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
      surface.style.position = "fixed";
      surface.style.left = `${pos.left}px`;
      surface.style.top = `${pos.top}px`;
      surface.style.width = `${surfaceWidth}px`;
      surface.style.zIndex = "1000";
    }

    // Keep the highlighted row visible when the list scrolls (arrow nav past
    // the menu's max-height, or the docked sheet's own scroller).
    if (selectedRow !== null) {
      (selectedRow as HTMLDivElement).scrollIntoView({ block: "nearest" });
    }
  }

  private applyCommand(cmd: SlashCommand): void {
    if (this.state === null) return;
    const { triggerFrom, triggerTo } = this.state;
    this.close();
    cmd.apply(this.view, triggerFrom, triggerTo);
  }

  private currentFiltered(): readonly SlashCommand[] {
    if (this.state === null) return [];
    const filter = this.view.state.doc.sliceString(
      this.state.triggerFrom + 1,
      this.state.triggerTo,
    );
    return filterCommands(this.commands, filter);
  }

  /** Move the highlight by `delta` (wraps). Returns true if it consumed. */
  move(delta: number): boolean {
    if (this.state === null) return false;
    const n = this.currentFiltered().length;
    if (n === 0) return false;
    this.state = {
      ...this.state,
      selectedIndex: (this.state.selectedIndex + delta + n) % n,
    };
    this.scheduleRender();
    return true;
  }

  /** Apply the highlighted command, or close if nothing matches. */
  confirm(): boolean {
    if (this.state === null) return false;
    const cmd = this.currentFiltered()[this.state.selectedIndex];
    if (cmd !== undefined) {
      this.applyCommand(cmd);
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

const slashPlugin = ViewPlugin.fromClass(SlashMenuView);

// Nav keys are bound through a `Prec.highest` keymap rather than the plugin's
// `eventHandlers`, so they reliably win over `defaultKeymap`'s cursor-line
// and Enter bindings while the menu is open. Each command no-ops (returns
// false → editor handles the key normally) when the menu is closed.
function slashKeymap(): readonly KeyBinding[] {
  const whenOpen =
    (fn: (v: SlashMenuView) => boolean): Command =>
    (view) => {
      const inst = view.plugin(slashPlugin);
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

export function slashMenuExtension(): Extension {
  // The `aiSlashEnabledFacet` value is NOT provided here — it lives in the
  // live-reconfigurable AI compartment (`extensions.ts::aiSurface`) so
  // `ai_enabled` can toggle the AI slash commands without a remount. Absent a
  // provided value the facet defaults to `false` (base menu only).
  return [slashPlugin, Prec.highest(keymap.of(slashKeymap()))];
}
