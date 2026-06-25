// Spell correction menu (spell-checker epic, MYND-265).
//
// Right-click on a squiggled (misspelled) word opens a floating menu of ranked
// suggestions plus "Add to dictionary" / "Ignore in this vault" / "Ignore this
// session" (SYNC-14). The native WebView contextmenu is suppressed ONLY over a
// squiggle (default OS menu elsewhere). A keyboard shortcut (Cmd/Ctrl+.) opens
// it for the flagged word under the caret (accessibility / no-mouse).
//
// Mechanics mirror the slash menu: a vanilla-DOM floating surface in a
// ViewPlugin positioned via `computePosition`, dismissed on Esc / outside-click
// / selection-or-doc change. Applying a suggestion is a surgical byte-stable
// range edit (SYNC-14, `applySpellCorrection`); add/ignore route through the
// MYND-266 IPC and never touch storage here.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate, keymap } from "@codemirror/view";
import { computePosition } from "../positioning";
import { ensureFloatingStyles } from "../floating-styles";
import {
  applySpellCorrection,
  getActiveSpellLangs,
  ignoreWordThisSession,
  requestSpellRescan,
  spellErrorAt,
  type SpellRange,
} from "../decorations/spell";
import {
  spellCheck,
  addToPersonalDictionary,
  ignoreWordInVault,
} from "../../lib/spell";
import i18n from "../../i18n";

/** Max suggestions shown (SYNC-14); the engine returns more, the UI caps. */
export const MAX_SUGGESTIONS = 5;

/** A menu row: either a suggestion to apply, or a standing action. */
export type MenuItem =
  | { kind: "suggestion"; label: string }
  | { kind: "action"; action: "add" | "ignore-vault" | "ignore-session"; label: string };

/**
 * Build the menu's item model from the engine's suggestions: up to
 * [`MAX_SUGGESTIONS`] suggestion rows (or a single disabled-feel "no
 * suggestions" handled by the renderer when empty) followed by the three
 * standing actions, ALWAYS present (SYNC-14). Pure + unit-tested; the renderer
 * turns this into DOM.
 */
export function buildMenuItems(suggestions: string[]): MenuItem[] {
  const items: MenuItem[] = suggestions
    .slice(0, MAX_SUGGESTIONS)
    .map((label) => ({ kind: "suggestion", label }) as MenuItem);
  items.push({ kind: "action", action: "add", label: i18n.t("editor.spell.menu.addToDictionary") });
  items.push({ kind: "action", action: "ignore-vault", label: i18n.t("editor.spell.menu.ignoreInVault") });
  items.push({ kind: "action", action: "ignore-session", label: i18n.t("editor.spell.menu.ignoreThisSession") });
  return items;
}

const MENU_CLASS = "cm-spell-menu";
const ROW_CLASS = "cm-spell-menu-row";

const correctionMenuPlugin = ViewPlugin.fromClass(
  class {
    private container: HTMLDivElement | null = null;
    private target: SpellRange | null = null;
    private selected = 0;
    private outsideHandler: ((e: MouseEvent) => void) | null = null;

    constructor(readonly view: EditorView) {
      ensureFloatingStyles();
    }

    update(u: ViewUpdate) {
      // Any doc or selection change dismisses (the word may have moved/changed).
      if (this.container && (u.docChanged || u.selectionSet)) this.dismiss();
    }

    destroy() {
      this.dismiss();
    }

    get isOpen(): boolean {
      return this.container !== null;
    }

    /** Open for the misspelled `range`; fetches suggestions then renders. */
    async openFor(range: SpellRange) {
      this.target = range;
      this.selected = 0;
      let suggestions: string[] = [];
      try {
        const verdicts = await spellCheck([range.word], getActiveSpellLangs());
        suggestions = verdicts[0]?.suggestions ?? [];
      } catch {
        suggestions = [];
      }
      if (this.target !== range) return; // superseded / dismissed
      this.render(range, buildMenuItems(suggestions), suggestions.length === 0);
    }

    private render(range: SpellRange, items: MenuItem[], noSuggestions: boolean) {
      this.dismiss();
      const el = document.createElement("div");
      el.className = MENU_CLASS;
      el.setAttribute("data-testid", "spell.suggestion-menu");
      el.setAttribute("role", "menu");

      if (noSuggestions) {
        const empty = document.createElement("div");
        empty.className = `${ROW_CLASS} cm-spell-menu-empty`;
        empty.textContent = i18n.t("editor.spell.menu.noSuggestions");
        el.appendChild(empty);
      }

      items.forEach((item, i) => {
        const row = document.createElement("div");
        row.className = ROW_CLASS;
        row.setAttribute("role", "menuitem");
        row.setAttribute("data-index", String(i));
        row.setAttribute(
          "data-testid",
          item.kind === "suggestion"
            ? "spell.suggestion-row"
            : `spell.action-${item.action}`,
        );
        row.textContent = item.label;
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.activate(range, item);
        });
        el.appendChild(row);
      });

      document.body.appendChild(el);
      this.container = el;
      this.position(range, el);

      this.outsideHandler = (e: MouseEvent) => {
        if (this.container && !this.container.contains(e.target as Node)) {
          this.dismiss();
        }
      };
      document.addEventListener("mousedown", this.outsideHandler, true);
    }

    private position(range: SpellRange, el: HTMLDivElement) {
      const coords = this.view.coordsAtPos(range.from);
      if (!coords) return;
      const rect = {
        left: coords.left,
        top: coords.top,
        right: coords.right ?? coords.left,
        bottom: coords.bottom,
      };
      const { left, top } = computePosition({
        anchor: rect,
        surfaceWidth: el.offsetWidth || 220,
        surfaceHeight: el.offsetHeight || 160,
        preferredPlacement: "below",
      });
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    private activate(range: SpellRange, item: MenuItem) {
      if (item.kind === "suggestion") {
        applySpellCorrection(this.view, range, item.label);
      } else if (item.action === "add") {
        void addToPersonalDictionary(range.word).then(() =>
          requestSpellRescan(this.view),
        );
      } else if (item.action === "ignore-vault") {
        void ignoreWordInVault(range.word).then(() => requestSpellRescan(this.view));
      } else {
        ignoreWordThisSession(this.view, range.word);
      }
      this.dismiss();
      this.view.focus();
    }

    move(delta: number) {
      if (!this.container) return;
      const rows = this.container.querySelectorAll(`.${ROW_CLASS}[data-index]`);
      if (rows.length === 0) return;
      this.selected = (this.selected + delta + rows.length) % rows.length;
      rows.forEach((r, i) =>
        r.classList.toggle("cm-spell-menu-row-active", i === this.selected),
      );
    }

    confirm(range: SpellRange, items: MenuItem[]) {
      const item = items[this.selected];
      if (item) this.activate(range, item);
    }

    dismiss() {
      if (this.outsideHandler) {
        document.removeEventListener("mousedown", this.outsideHandler, true);
        this.outsideHandler = null;
      }
      this.container?.remove();
      this.container = null;
      this.target = null;
    }
  },
  {
    eventHandlers: {
      contextmenu(this: { openFor(r: SpellRange): void }, event: MouseEvent, view: EditorView) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const range = spellErrorAt(view.state, pos);
        if (!range) return false; // not over a squiggle → default OS menu
        event.preventDefault();
        void this.openFor(range);
        return true;
      },
    },
  },
);

/** Keyboard: Cmd/Ctrl+. opens the menu for the flagged word under the caret;
 * Esc dismisses. (Arrow/Enter nav is handled inside the open menu's own state.) */
const correctionMenuKeymap = Prec.highest(
  keymap.of([
    {
      key: "Mod-.",
      run: (view) => {
        const pos = view.state.selection.main.head;
        const range = spellErrorAt(view.state, pos);
        if (!range) return false;
        const plugin = view.plugin(correctionMenuPlugin);
        if (plugin) void plugin.openFor(range);
        return true;
      },
    },
    {
      key: "Escape",
      run: (view) => {
        const plugin = view.plugin(correctionMenuPlugin);
        if (plugin?.isOpen) {
          plugin.dismiss();
          return true;
        }
        return false;
      },
    },
  ]),
);

/** The composed correction-menu extension (MYND-265). */
export function spellCorrectionMenu(): readonly Extension[] {
  return [correctionMenuPlugin, correctionMenuKeymap];
}
