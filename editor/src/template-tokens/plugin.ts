// `{{` token-autocomplete CM6 ViewPlugin — intercepts `{{` typing inside a
// template note, opens a floating menu of the variable engine's supported
// tokens, and inserts the chosen `{{token}}` (text only — it NEVER evaluates;
// SYNC-6-R anti-scripting). MYND-189.
//
// Modeled on `src/editor/slash/plugin.ts`. Two differences from the slash menu:
//   1. **Template-scoped.** The menu opens only when the open note carries
//      `template: true` in its frontmatter (read via the dialect's value-strict
//      `readTemplateFromFmBody` over the cached frontmatter range). In an
//      ordinary note `{{date}}` stays literal — the menu never appears.
//   2. **closeBrackets-aware.** `closeBrackets()` auto-inserts the closing
//      `}}` as the user types `{{`, leaving the cursor at `{{|}}`. Detection
//      keys off "the two chars before the cursor are `{{`" (robust to the
//      auto-close), and insertion consumes a trailing auto-closed `}}` so the
//      result is a single clean `{{token}}`, never `{{token}}}}`.
//
// Token vocabulary is imported from the engine's `SUPPORTED_TOKENS` registry
// (`src/dialect/templateEngine.ts`) — never hard-coded here, so adding a token
// to the engine surfaces it in this menu with no second edit site.

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
import { isSlashSuppressed } from "../slash/plugin";
import { cachedLocateFrontmatter } from "../frontmatter-cache";
import { readTemplateFromFmBody } from "@myne/dialect";
import { SUPPORTED_TOKENS } from "@myne/dialect/templateEngine";
import i18n from "@myne/editor/i18n";

/** True iff the doc carries the value-strict `template: true` flag. */
function isTemplateDoc(view: EditorView): boolean {
  const fm = cachedLocateFrontmatter(view.state.doc);
  if (fm === null) return false;
  const fmBody = view.state.doc.sliceString(fm.bodyStart, fm.bodyEnd);
  return readTemplateFromFmBody(fmBody);
}

/** Tokens whose name starts with `filter` (case-insensitive), registry order. */
function filterTokens(filter: string): readonly string[] {
  const f = filter.toLowerCase();
  return SUPPORTED_TOKENS.filter((t) => t.startsWith(f));
}

type MenuState = {
  triggerFrom: number; // position of the first `{` of the `{{`
  triggerTo: number; // cursor head (end of the typed filter)
  selectedIndex: number;
};

class TemplateTokenMenuView implements PluginValue {
  private container: HTMLDivElement | null = null;
  private docked: DockedPicker | null = null;
  private state: MenuState | null = null;
  private rafHandle: number | null = null;

  constructor(private readonly view: EditorView) {
    ensureFloatingStyles();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      const head = update.view.state.selection.main.head;
      if (this.state === null) {
        // Open when the two chars before the cursor are `{{`, the doc is a
        // template, and `{{` isn't content (code/url/wikilink).
        const before = update.view.state.doc.sliceString(
          Math.max(0, head - 2),
          head,
        );
        if (
          before === "{{" &&
          isTemplateDoc(update.view) &&
          !isSlashSuppressed(update.view.state, head - 1)
        ) {
          this.open(head - 2, head);
        }
      } else {
        // Filter changed → follow the cursor, reset highlight to the top match.
        this.state = {
          ...this.state,
          triggerTo: head,
          selectedIndex: 0,
        };
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
    this.close();
  }

  private currentFilter(): string {
    if (this.state === null) return "";
    return this.view.state.doc.sliceString(
      this.state.triggerFrom + 2,
      this.state.triggerTo,
    );
  }

  /** The token list for the current filter — the one place render/move/confirm
   *  agree on (parity with the slash plugin's `currentFiltered`). */
  private currentFiltered(): readonly string[] {
    return filterTokens(this.currentFilter());
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
   *  host declares the docked presentation, the sheet shell's list
   *  (myne-md/myne#884). */
  private surface(): HTMLElement {
    if (floatingSurfacePresentation() === "docked") {
      if (this.docked === null) {
        this.docked = createDockedPicker({
          title: i18n.t("editor.templateToken.sheetTitle"),
          testId: "editor.template-token-sheet",
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
      document.body.appendChild(this.container);
    }
    return this.container;
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
    // A non-token character in the filter (`}`, `{`, whitespace) means the user
    // is no longer picking a token — close rather than match nothing forever.
    if (/[^a-z]/i.test(filter)) {
      this.close();
      return;
    }
    const filtered = this.currentFiltered();
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
    filtered.forEach((token, i) => {
      const row = document.createElement("div");
      row.className = "cm-slash-menu-row";
      if (i === this.state!.selectedIndex) {
        row.classList.add("cm-slash-menu-row-selected");
        selectedRow = row;
      }
      row.setAttribute("role", "menuitem");
      // `mousemove`, NOT `mouseenter`: keyboard nav rebuilds the rows on every
      // press, so a synthetic enter under a stationary pointer would yank the
      // highlight back to the mouse and fight the arrow keys. See the slash
      // menu (`editor/slash/plugin.ts`) for the full rationale.
      row.addEventListener("mousemove", () => {
        if (this.state === null || this.state.selectedIndex === i) return;
        this.state.selectedIndex = i;
        surface
          .querySelectorAll(".cm-slash-menu-row")
          .forEach((r, idx) =>
            r.classList.toggle("cm-slash-menu-row-selected", idx === i),
          );
      });
      const label = document.createElement("span");
      label.className = "cm-slash-menu-label";
      label.textContent = `{{${token}}}`;
      row.append(label);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.applyToken(token);
      });
      surface.appendChild(row);
    });

    // The docked sheet is pinned by its own stylesheet; only the anchored
    // popover is positioned against the caret.
    if (this.docked === null) {
      const surfaceWidth = 220;
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

    if (selectedRow !== null) {
      (selectedRow as HTMLDivElement).scrollIntoView({ block: "nearest" });
    }
  }

  private applyToken(token: string): void {
    if (this.state === null) return;
    const { triggerFrom, triggerTo } = this.state;
    this.close();
    // Consume a trailing auto-closed `}}` (closeBrackets) so we don't double it.
    let end = triggerTo;
    if (this.view.state.doc.sliceString(triggerTo, triggerTo + 2) === "}}") {
      end = triggerTo + 2;
    }
    const insert = `{{${token}}}`;
    this.view.dispatch({
      changes: { from: triggerFrom, to: end, insert },
      selection: { anchor: triggerFrom + insert.length },
    });
    this.view.focus();
  }

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

  confirm(): boolean {
    if (this.state === null) return false;
    const token = this.currentFiltered()[this.state.selectedIndex];
    if (token !== undefined) {
      this.applyToken(token);
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

const templateTokenPlugin = ViewPlugin.fromClass(TemplateTokenMenuView);

function templateTokenKeymap(): readonly KeyBinding[] {
  const whenOpen =
    (fn: (v: TemplateTokenMenuView) => boolean): Command =>
    (view) => {
      const inst = view.plugin(templateTokenPlugin);
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

export function templateTokenMenuExtension(): Extension {
  return [templateTokenPlugin, Prec.highest(keymap.of(templateTokenKeymap()))];
}
