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
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { computePosition } from "../positioning";
import { ensureFloatingStyles } from "../floating-styles";
import { filterCommands, slashCommands, type SlashCommand } from "./commands";

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
): boolean {
  const tree = syntaxTree(state);
  let suppressed = false;
  tree.iterate({
    from: Math.max(0, pos - 1),
    to: pos,
    enter: (node) => {
      if (SUPPRESS_NODE_NAMES.has(node.name)) {
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
  private state: MenuState | null = null;
  private rafHandle: number | null = null;
  private readonly commands: readonly SlashCommand[];

  constructor(private readonly view: EditorView) {
    this.commands = slashCommands();
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
        this.state = {
          ...this.state,
          triggerTo: update.view.state.selection.main.head,
        };
        this.scheduleRender();
      }
    }
    if (update.selectionSet && this.state !== null) {
      const head = update.view.state.selection.main.head;
      if (head < this.state.triggerFrom || head > this.state.triggerTo + 1) {
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
    this.state = null;
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

    if (this.container === null) {
      this.container = document.createElement("div");
      this.container.className = "cm-slash-menu";
      this.container.setAttribute("role", "menu");
      // Mount to document.body so position: fixed escapes any ancestor
      // containing-block context (transform/filter/contain quirks).
      document.body.appendChild(this.container);
    }
    this.container.replaceChildren();
    filtered.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = "cm-slash-menu-row";
      if (i === this.state!.selectedIndex) {
        row.classList.add("cm-slash-menu-row-selected");
      }
      row.setAttribute("role", "menuitem");
      const icon = document.createElement("span");
      icon.className = "cm-slash-menu-icon";
      icon.textContent = cmd.icon;
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
      this.container!.appendChild(row);
    });

    // Anchor on the cursor coords; fall back to the editor's content
    // rect center if coords aren't measured yet.
    const surfaceWidth = 300;
    const surfaceHeight = 40 + filtered.length * 32;
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
    this.container.style.position = "fixed";
    this.container.style.left = `${pos.left}px`;
    this.container.style.top = `${pos.top}px`;
    this.container.style.width = `${surfaceWidth}px`;
    this.container.style.zIndex = "1000";
  }

  private applyCommand(cmd: SlashCommand): void {
    if (this.state === null) return;
    const { triggerFrom, triggerTo } = this.state;
    this.close();
    cmd.apply(this.view, triggerFrom, triggerTo);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (this.state === null) return false;
    const filter = this.view.state.doc.sliceString(
      this.state.triggerFrom + 1,
      this.state.triggerTo,
    );
    const filtered = filterCommands(this.commands, filter);
    if (e.key === "Escape") {
      this.close();
      return true;
    }
    if (e.key === "ArrowDown") {
      this.state = {
        ...this.state,
        selectedIndex: (this.state.selectedIndex + 1) % filtered.length,
      };
      this.scheduleRender();
      return true;
    }
    if (e.key === "ArrowUp") {
      this.state = {
        ...this.state,
        selectedIndex:
          (this.state.selectedIndex - 1 + filtered.length) % filtered.length,
      };
      this.scheduleRender();
      return true;
    }
    if (e.key === "Enter") {
      const cmd = filtered[this.state.selectedIndex];
      if (cmd !== undefined) {
        this.applyCommand(cmd);
      }
      return true;
    }
    return false;
  }

  isOpen(): boolean {
    return this.state !== null;
  }
}

export function slashMenuExtension(): Extension {
  const plugin = ViewPlugin.fromClass(SlashMenuView, {
    eventHandlers: {
      keydown(this: SlashMenuView, e: KeyboardEvent): boolean {
        return this.handleKey(e);
      },
    },
  });
  return plugin;
}
