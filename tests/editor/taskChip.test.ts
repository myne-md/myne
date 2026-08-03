// @vitest-environment jsdom
//
// Due-date chip decoration (MYND-614 task 3).
//
// Three of the five acceptance criteria are about traps this codebase has hit
// before, so they are tested directly rather than by eye:
//
//   - atomic ranges must match the decoration ranges EXACTLY (same predicate,
//     same scope) — a wider atomic scope makes off-screen raw text atomic and the
//     caret starts skipping characters in ordinary-looking text;
//   - widget identity must include the source position — CodeMirror reuses widget
//     DOM when `eq` says two widgets are equal, so two chips with the same value
//     on different lines would share DOM and a click would resolve to the wrong
//     range after an edit shifts lines;
//   - the click handler must resolve position LIVE, not from a closure captured
//     at build time.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import { history, undo } from "@codemirror/commands";
import {
  taskChipDecorations,
  taskChipAt,
  applyTaskFieldEdit,
  TASK_CHIP_EVENT,
} from "@myne/editor/decorations/task-chip";
import { taskListDecorations } from "@myne/editor/decorations/task-list";
import i18n from "../../src/i18n";

const DOC = "- [ ] pay the rent [due:: 2026-08-01]\n- [ ] second [due:: 2026-08-01]\n";

function mount(doc = DOC): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: { parser } as never }),
        taskListDecorations(),
        taskChipDecorations(),
      ],
    }),
  });
  return { view, host };
}

function teardown(view: EditorView, host: HTMLElement): void {
  view.destroy();
  host.remove();
}

describe("the chip renders", () => {
  it("replaces the due field with a chip carrying the value", () => {
    const { view, host } = mount();
    const chips = host.querySelectorAll('[data-testid="editor.task-chip-due"]');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0]?.textContent).toBe("2026-08-01");
    teardown(view, host);
  });

  it("leaves a line with no due field alone", () => {
    const { view, host } = mount("- [ ] plain task\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(0);
    teardown(view, host);
  });

  it("chips the emoji dialect too", () => {
    const { view, host } = mount("- [ ] pay rent 📅 2026-08-01\n");
    const chip = host.querySelector('[data-testid="editor.task-chip-due"]');
    expect(chip?.textContent).toBe("2026-08-01");
    teardown(view, host);
  });

  it("does not chip a field Myne does not chip", () => {
    // `scheduled` is recognized by the parser (preserved on write) but is not one
    // of the three chipped kinds.
    const { view, host } = mount("- [ ] x [scheduled:: 2026-08-05]\n");
    expect(host.querySelectorAll("[data-task-chip]").length).toBe(0);
    teardown(view, host);
  });
});

describe("atomic ranges match the decoration ranges exactly", () => {
  it("every chipped span is atomic, and nothing else is", () => {
    const { view, host } = mount();
    // Both sets are derived from the same predicate over the same scope; compare
    // them span-for-span rather than trusting that by inspection.
    const decorated: Array<[number, number]> = [];
    const plugin = view.plugin as never; // not accessible; use the rendered DOM instead
    void plugin;
    for (const el of host.querySelectorAll("[data-chip-from]")) {
      const from = Number((el as HTMLElement).getAttribute("data-chip-from"));
      decorated.push([from, from]);
    }

    const atomic: Array<[number, number]> = [];
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const set = f(view);
      const iter = set.iter();
      while (iter.value !== null) {
        atomic.push([iter.from, iter.to]);
        iter.next();
      }
    });

    expect(atomic.length).toBe(decorated.length);
    for (const [from] of decorated) {
      expect(atomic.some(([a]) => a === from)).toBe(true);
    }
    teardown(view, host);
  });

  it("makes nothing atomic when there is no due field", () => {
    const { view, host } = mount("- [ ] plain task with no fields\n");
    let count = 0;
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const iter = f(view).iter();
      while (iter.value !== null) {
        count++;
        iter.next();
      }
    });
    expect(count).toBe(0);
    teardown(view, host);
  });
});

describe("click position resolves live, not from a closure", () => {
  it("resolves a chip to its own span", () => {
    const { view, host } = mount();
    const chip = host.querySelector('[data-testid="editor.task-chip-due"]') as HTMLElement;
    const span = taskChipAt(view, chip);
    expect(span).not.toBeNull();
    expect(view.state.doc.sliceString(span!.from, span!.to)).toBe("[due:: 2026-08-01]");
    teardown(view, host);
  });

  it("still resolves correctly after an edit above shifts every offset", () => {
    // The trap: a closure captured at build time would still point at the old
    // offset, and the two identical-valued chips make DOM reuse likely.
    const { view, host } = mount();
    view.dispatch({ changes: { from: 0, insert: "# A heading inserted above\n\n" } });

    const chips = host.querySelectorAll('[data-testid="editor.task-chip-due"]');
    expect(chips.length).toBeGreaterThan(0);
    const span = taskChipAt(view, chips[0] as HTMLElement);
    expect(span).not.toBeNull();
    // Whatever it resolves to must actually BE a due field in the current doc.
    expect(view.state.doc.sliceString(span!.from, span!.to)).toContain("due");
    teardown(view, host);
  });
});

describe("widget identity includes the source position", () => {
  it("two chips with the same value on different lines are distinct widgets", () => {
    // Both lines carry `[due:: 2026-08-01]`. If identity were value-only, the
    // editor could reuse one chip's DOM for the other.
    const { view, host } = mount();
    const chips = [...host.querySelectorAll("[data-chip-from]")] as HTMLElement[];
    expect(chips.length).toBe(2);
    const positions = chips.map((c) => c.getAttribute("data-chip-from"));
    expect(new Set(positions).size).toBe(2);
    teardown(view, host);
  });
});

describe("recurrence and priority chips (task 4)", () => {
  // Each fixture here carries a `due` date, because a repeat rule with nothing
  // to repeat FROM is not a working rule and no longer chips (myne#197). The
  // anchorless case has its own describe block below.
  it("chips a repeat field in both dialects", () => {
    const bracketed = mount("- [ ] water plants [due:: 2026-08-01] [repeat:: every 3 days]\n");
    expect(
      bracketed.host.querySelector('[data-testid="editor.task-chip-repeat"]')?.textContent,
    ).toBe("every 3 days");
    teardown(bracketed.view, bracketed.host);

    const emoji = mount("- [ ] water plants [due:: 2026-08-01] 🔁 every 3 days\n");
    expect(
      emoji.host.querySelector('[data-testid="editor.task-chip-repeat"]')?.textContent,
    ).toBe("every 3 days");
    teardown(emoji.view, emoji.host);
  });

  it("chips a priority field from its word form", () => {
    const { view, host } = mount("- [ ] urgent [priority:: high]\n");
    expect(host.querySelector('[data-testid="editor.task-chip-priority"]')?.textContent).toBe(
      "high",
    );
    teardown(view, host);
  });

  it("chips a valueless priority emoji, labelled by its meaning", () => {
    // The marker IS the value here — there is no value node to read.
    const { view, host } = mount("- [ ] urgent ⏫\n");
    expect(host.querySelector('[data-testid="editor.task-chip-priority"]')?.textContent).toBe(
      "high",
    );
    teardown(view, host);
  });

  it("renders all three kinds on one line", () => {
    const { view, host } = mount(
      "- [ ] x [due:: 2026-08-01] [repeat:: every week] [priority:: low]\n",
    );
    expect(host.querySelectorAll("[data-task-chip]").length).toBe(3);
    const kinds = [...host.querySelectorAll("[data-task-chip]")].map((e) =>
      e.getAttribute("data-task-chip"),
    );
    expect(new Set(kinds)).toEqual(new Set(["due", "repeat", "priority"]));
    teardown(view, host);
  });

  it("all three share one class, so one token module drives their look", () => {
    const { view, host } = mount(
      "- [ ] x [due:: 2026-08-01] [repeat:: every week] [priority:: low]\n",
    );
    for (const el of host.querySelectorAll("[data-task-chip]")) {
      expect(el.className).toContain("cm-task-chip");
    }
    teardown(view, host);
  });
});

describe("the canon's prohibitions", () => {
  it("the token uses a neutral fill — state is never carried by the background", async () => {
    const { TASK_CHIP_TOKEN, taskChipCmTheme } = await import(
      "@myne/editor/host/notes/taskChipToken"
    );
    // Neutral paper, not an accent or a state colour.
    expect(TASK_CHIP_TOKEN.bg).toBe("var(--paper-2)");
    const rules = taskChipCmTheme();
    expect(rules[".cm-task-chip"]?.backgroundColor).toBe("var(--paper-2)");
  });

  it("introduces no green check anywhere", async () => {
    const { TASK_CHIP_TOKEN } = await import("@myne/editor/host/notes/taskChipToken");
    const serialized = JSON.stringify(TASK_CHIP_TOKEN).toLowerCase();
    expect(serialized).not.toContain("green");
    expect(serialized).not.toContain("success");
    // And no chip renders a check glyph.
    const { view, host } = mount("- [x] done thing [due:: 2026-08-01]\n");
    for (const el of host.querySelectorAll("[data-task-chip]")) {
      expect(el.textContent).not.toContain("✓");
      expect(el.textContent).not.toContain("✅");
    }
    teardown(view, host);
  });
});

describe("reveal policy (task 5)", () => {
  it("caret entry does NOT reveal raw text", async () => {
    // The wikilink rule, not the tag rule: a date is a structured value, and a
    // line with three chips would reflow every time the caret travelled it.
    const { view, host } = mount("- [ ] pay rent [due:: 2026-08-01]\n");
    const before = host.querySelectorAll("[data-task-chip]").length;
    expect(before).toBe(1);

    const chipStart = view.state.doc.toString().indexOf("[due::");
    view.dispatch({ selection: { anchor: chipStart + 3 } });
    view.focus();

    expect(host.querySelectorAll("[data-task-chip]").length).toBe(1);
    teardown(view, host);
  });

  it("opening the find panel reveals raw text, closing it restores the chip", async () => {
    const { openSearchPanel, closeSearchPanel, search } = await import("@codemirror/search");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "- [ ] pay rent [due:: 2026-08-01]\n",
        extensions: [
          markdown({ base: { parser } as never }),
          search(),
          taskChipDecorations(),
        ],
      }),
    });

    expect(host.querySelectorAll("[data-task-chip]").length).toBe(1);

    openSearchPanel(view);
    expect(host.querySelectorAll("[data-task-chip]").length).toBe(0);

    closeSearchPanel(view);
    expect(host.querySelectorAll("[data-task-chip]").length).toBe(1);

    teardown(view, host);
  });

  it("makes nothing atomic while revealed — revealed chips are raw text", async () => {
    const { openSearchPanel, search } = await import("@codemirror/search");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "- [ ] pay rent [due:: 2026-08-01]\n",
        extensions: [
          markdown({ base: { parser } as never }),
          search(),
          taskChipDecorations(),
        ],
      }),
    });

    openSearchPanel(view);
    let count = 0;
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const iter = f(view).iter();
      while (iter.value !== null) {
        count++;
        iter.next();
      }
    });
    expect(count).toBe(0);
    teardown(view, host);
  });

  it("reading mode never reveals, even with the find panel open", async () => {
    const { readingModeFacet } = await import("@myne/editor/decorations/cursor-aware");
    const { taskChipsRevealed } = await import("@myne/editor/decorations/task-chip");
    const state = EditorState.create({
      doc: "- [ ] x [due:: 2026-08-01]\n",
      extensions: [readingModeFacet.of(true)],
    });
    expect(taskChipsRevealed(state)).toBe(false);
  });
});

describe("chip write path (task 7)", () => {
  function docView(doc: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: { parser } as never }),
          history(),
          taskChipDecorations(),
        ],
      }),
    });
    return { view, host };
  }

  it("dispatches ONE transaction with a namespaced user event", () => {
    const { view, host } = docView("- [ ] pay rent [due:: 2026-08-01]\n");
    const seen: (string | undefined)[] = [];
    const original = view.dispatch.bind(view);
    // @ts-expect-error - test seam
    view.dispatch = (...specs) => {
      for (const spec of specs) seen.push((spec as { userEvent?: string }).userEvent);
      return original(...(specs as never));
    };

    const changed = applyTaskFieldEdit(view, { from: 15, to: 33, kind: "due" }, "2026-09-09");

    expect(changed).toBe(true);
    expect(seen).toEqual(["myne.task-field.edit"]);
    teardown(view, host);
  });

  it("one undo restores the document exactly", () => {
    const before = "- [ ] pay rent [due:: 2026-08-01]\n";
    const { view, host } = docView(before);
    applyTaskFieldEdit(view, { from: 15, to: 33, kind: "due" }, "2026-09-09");
    expect(view.state.doc.toString()).not.toBe(before);

    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    expect(view.state.doc.toString()).toBe(before);
    teardown(view, host);
  });

  it("editing one field converts EVERY task field on that line", () => {
    // The emoji-form line becomes fully Myne-form — the accepted export
    // asymmetry, made active here rather than latent.
    const { view, host } = docView("- [ ] ship it 📅 2026-08-01 🔁 every week ⏫\n");
    const chipFrom = view.state.doc.toString().indexOf("📅");
    applyTaskFieldEdit(view, { from: chipFrom, to: chipFrom + 14, kind: "due" }, "2026-09-09");

    const out = view.state.doc.toString();
    expect(out).toContain("[due:: 2026-09-09]");
    expect(out).toContain("[repeat:: every week]");
    expect(out).toContain("[priority:: high]");
    expect(out).not.toContain("📅");
    expect(out).not.toContain("🔁");
    teardown(view, host);
  });

  it("leaves other lines untouched", () => {
    const { view, host } = docView(
      "- [ ] first [due:: 2026-08-01]\n- [ ] second [due:: 2026-08-02]\n",
    );
    applyTaskFieldEdit(view, { from: 12, to: 30, kind: "due" }, "2026-09-09");
    expect(view.state.doc.toString()).toContain("- [ ] second [due:: 2026-08-02]");
    teardown(view, host);
  });

  it("returns false and dispatches nothing when the value is unchanged", () => {
    const { view, host } = docView("- [ ] x [due:: 2026-08-01]\n");
    const before = view.state.doc.toString();
    const changed = applyTaskFieldEdit(view, { from: 8, to: 26, kind: "due" }, "2026-08-01");
    expect(changed).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
    teardown(view, host);
  });

  it("preserves a value the parser refuses rather than dropping it", () => {
    const { view, host } = docView("- [ ] x [due:: 2026-08-01]\n");
    applyTaskFieldEdit(view, { from: 8, to: 26, kind: "due" }, "not-a-date");
    expect(view.state.doc.toString()).toContain("not-a-date");
    teardown(view, host);
  });
});

describe("malformed values render as raw text with a hint (task 8)", () => {
  it("does not chip a half-written date — it marks it instead", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(0);
    expect(host.querySelectorAll('[data-testid="editor.task-field-invalid-due"]').length).toBe(1);
    teardown(view, host);
  });

  it("keeps the source text visible rather than showing a blank chip", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08]\n");
    const marked = host.querySelector('[data-testid="editor.task-field-invalid-due"]');
    expect(marked?.textContent).toContain("2026-08");
    teardown(view, host);
  });

  it("refuses an impossible date rather than correcting it", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-02-31]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(0);
    // The text is untouched — no silent correction to 2026-03-03 or similar.
    expect(view.state.doc.toString()).toContain("2026-02-31");
    teardown(view, host);
  });

  it("refuses an unknown priority word", () => {
    const { view, host } = mount("- [ ] x [priority:: urgent]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-priority"]').length).toBe(0);
    expect(
      host.querySelectorAll('[data-testid="editor.task-field-invalid-priority"]').length,
    ).toBe(1);
    teardown(view, host);
  });

  it("flags a recurrence rule the closed vocabulary does not read (MYND-615 task 10)", () => {
    // When this chip shipped, MYND-615's rule grammar did not exist, so every
    // rule chipped. It exists now, and an unreadable rule must LOOK unread —
    // the silent alternative is data-loss-shaped.
    const { view, host } = mount("- [ ] x [repeat:: whenever I feel like it]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-repeat"]').length).toBe(0);
    expect(host.querySelectorAll('[data-testid="editor.task-field-invalid-repeat"]').length).toBe(
      1,
    );
    teardown(view, host);
  });

  it("a malformed field is NOT atomic — the caret must reach it to fix it", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08]\n");
    let count = 0;
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const iter = f(view).iter();
      while (iter.value !== null) {
        count++;
        iter.next();
      }
    });
    expect(count).toBe(0);
    teardown(view, host);
  });

  it("a partially-typed value does not flicker into a wrong chip", () => {
    // Typing `2026-0` then `2026-08` then `2026-08-0`: none of these type, so
    // none of them may render as a chip showing a date the user did not write.
    for (const partial of ["2", "2026", "2026-0", "2026-08", "2026-08-0"]) {
      const { view, host } = mount(`- [ ] x [due:: ${partial}]\n`);
      expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(0);
      teardown(view, host);
    }
  });

  it("types the moment the value becomes valid", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(1);
    teardown(view, host);
  });
});

describe("layout carve-outs (task 9)", () => {
  it("the strike-through carve-out exists for chips on a completed line", async () => {
    // The completed-task strike spans to the end of the line, so without a
    // carve-out it draws straight through every chip and the values become
    // unreadable. jsdom does not compute inherited text-decoration, so this
    // asserts the rule itself is present in the theme source.
    const themeSrc = await import("node:fs").then((fs) =>
      fs.readFileSync("editor/src/theme.ts", "utf-8"),
    );
    expect(themeSrc).toContain('".cm-task-done-label .cm-task-chip"');
    expect(themeSrc.split('".cm-task-done-label .cm-task-chip"')[1]).toContain('textDecoration: "none"');
  });

  it("chips reset the inherited hanging indent", async () => {
    // A list item carries `text-indent: -1.5em`; an inline-block chip inherits it
    // and pushes its own label out of the pill. The token resets it.
    const { taskChipCmTheme } = await import("@myne/editor/host/notes/taskChipToken");
    expect(taskChipCmTheme()[".cm-task-chip"]?.textIndent).toBe("0");
  });

  it("renders a chip inside a nested list item without dropping it", () => {
    const { view, host } = mount("- outer\n  - [ ] nested [due:: 2026-08-01]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(1);
    teardown(view, host);
  });

  it("renders chips on a completed task line", () => {
    const { view, host } = mount("- [x] done thing [due:: 2026-08-01]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-due"]').length).toBe(1);
    teardown(view, host);
  });
});

describe("accessibility (task 10)", () => {
  it("every chip carries an accessible name naming the field and its value", () => {
    const { view, host } = mount(
      "- [ ] x [due:: 2026-08-01] [repeat:: every week] [priority:: low]\n",
    );
    const labels = [...host.querySelectorAll("[data-task-chip]")].map((e) =>
      e.getAttribute("aria-label"),
    );
    expect(labels).toContain("due, 2026-08-01");
    expect(labels).toContain("repeat, every week");
    expect(labels).toContain("priority, low");
    teardown(view, host);
  });

  it("every chip is keyboard-reachable", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01]\n");
    for (const el of host.querySelectorAll("[data-task-chip]")) {
      expect(el.getAttribute("tabindex")).toBe("0");
      expect(el.getAttribute("role")).toBe("button");
    }
    teardown(view, host);
  });

  it("Enter on a focused chip activates it", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01]\n");
    const chip = host.querySelector("[data-task-chip]") as HTMLElement;
    let fired = 0;
    view.dom.addEventListener("myne-open-task-chip", () => {
      fired++;
    });
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(fired).toBe(1);
    teardown(view, host);
  });

  it("a single keypress deletes a whole chip — atomic ranges make it one unit", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01]\n");
    const doc = view.state.doc.toString();
    const chipEnd = doc.indexOf("]", doc.indexOf("[due::")) + 1;
    view.dispatch({ selection: { anchor: chipEnd } });
    // The atomic range makes Backspace remove the whole span rather than one
    // character of it. Verified through the facet, since jsdom has no key input.
    let covered = false;
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const iter = f(view).iter();
      while (iter.value !== null) {
        if (iter.to === chipEnd) covered = true;
        iter.next();
      }
    });
    expect(covered).toBe(true);
    teardown(view, host);
  });
});

describe("the inherited checkbox debt is fixed, not deferred (task 10)", () => {
  it("the task checkbox now has an accessible name and a focus stop", () => {
    const { view, host } = mount("- [ ] pay rent\n");
    const box = host.querySelector('[role="checkbox"]');
    expect(box).not.toBeNull();
    expect(box!.getAttribute("tabindex")).toBe("0");
    expect(box!.getAttribute("aria-label")).toBeTruthy();
    teardown(view, host);
  });

  it("announces its state in the accessible name", () => {
    const open = mount("- [ ] not done\n");
    expect(open.host.querySelector('[role="checkbox"]')!.getAttribute("aria-label")).toContain(
      "not completed",
    );
    teardown(open.view, open.host);

    const done = mount("- [x] finished\n");
    expect(done.host.querySelector('[role="checkbox"]')!.getAttribute("aria-label")).toBe(
      "Task, completed",
    );
    teardown(done.view, done.host);
  });

  it("toggles from the keyboard", () => {
    const { view, host } = mount("- [ ] pay rent\n");
    const box = host.querySelector('[role="checkbox"]') as HTMLElement;
    box.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(view.state.doc.toString()).toContain("- [x]");
    teardown(view, host);
  });
});

describe("unrecognized recurrence rule (MYND-615 task 10)", () => {
  // Story 12. The silent path is a data-loss-shaped surprise: the user believes
  // the task repeats, completes it, nothing appears, and they find out by
  // missing something months later. So an unreadable rule is SHOWN as unread.

  it("is visibly flagged rather than chipped", () => {
    const { view, host } = mount("- [ ] x [repeat:: FREQ=DAILY;INTERVAL=1]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-repeat"]').length).toBe(0);
    const flagged = host.querySelector('[data-testid="editor.task-field-invalid-repeat"]');
    expect(flagged).not.toBeNull();
    expect(flagged!.classList.contains("cm-task-field-invalid")).toBe(true);
    teardown(view, host);
  });

  it("says what follows from it, not just that it failed", () => {
    // The consequence — "this task won't repeat" — is the part the user cannot
    // infer from a dotted underline.
    const { view, host } = mount("- [ ] x [repeat:: FREQ=DAILY]\n");
    const flagged = host.querySelector('[data-testid="editor.task-field-invalid-repeat"]');
    expect(flagged!.getAttribute("title")).toContain("repeat");
    teardown(view, host);
  });

  it("keeps its raw text visible", () => {
    const { view, host } = mount("- [ ] x [repeat:: whenever I feel like it]\n");
    const flagged = host.querySelector('[data-testid="editor.task-field-invalid-repeat"]');
    expect(flagged!.textContent).toContain("whenever I feel like it");
    teardown(view, host);
  });

  it("stays reachable — a mark decoration, so the caret can get in to fix it", () => {
    const { view, host } = mount("- [ ] x [repeat:: not a rule]\n");
    let atomic = 0;
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const iter = f(view).iter();
      while (iter.value !== null) {
        atomic++;
        iter.next();
      }
    });
    expect(atomic).toBe(0);
    teardown(view, host);
  });

  it("preserves the rule's bytes exactly", () => {
    const raw = "- [ ] x [repeat:: every fortnight, ish]\n";
    const { view, host } = mount(raw);
    expect(view.state.doc.toString()).toBe(raw);
    teardown(view, host);
  });

  it("does not silently recur — the completion path declines on the same rule", async () => {
    const { nextOccurrenceLine } = await import("@myne/editor/decorations/task-recurrence");
    expect(
      nextOccurrenceLine("- [x] x [due:: 2026-08-01] [repeat:: not a rule]", {
        year: 2026,
        month: 8,
        day: 1,
      }),
    ).toBeNull();
  });

  it("still chips every rule the vocabulary DOES read", () => {
    for (const rule of [
      "every day",
      "every 3 weeks",
      "every monday and friday",
      "first monday of every month",
      "day 31 of every month",
      "last day of every month",
      "every 3 days when done",
    ]) {
      const { view, host } = mount(`- [ ] x [due:: 2026-08-01] [repeat:: ${rule}]\n`);
      expect(host.querySelectorAll('[data-testid="editor.task-chip-repeat"]').length).toBe(1);
      teardown(view, host);
    }
  });
});

describe("anchorless recurrence rule (myne#197)", () => {
  // A rule with no date to repeat FROM parses perfectly and then does nothing.
  // That is the same data-loss-shaped silence the unrecognized-rule state exists
  // to prevent — it simply was not covered, because the chip layer asked whether
  // the vocabulary could PARSE the rule rather than whether the rule could be
  // EVALUATED on this line.

  it("does not chip — the rule is readable but not workable", () => {
    const { view, host } = mount("- [ ] shower [repeat:: every day]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-repeat"]').length).toBe(0);
    const flagged = host.querySelector('[data-testid="editor.task-field-invalid-repeat"]');
    expect(flagged).not.toBeNull();
    expect(flagged!.classList.contains("cm-task-field-invalid")).toBe(true);
    teardown(view, host);
  });

  it("says the rule needs a date, not that the rule is wrong", () => {
    // The two failures call for different actions: an unreadable rule gets
    // corrected, an anchorless one gets a date. Telling the user to fix a rule
    // that is already correct would send them the wrong way.
    const { view, host } = mount("- [ ] shower [repeat:: every day]\n");
    const flagged = host.querySelector('[data-testid="editor.task-field-invalid-repeat"]');
    expect(flagged!.getAttribute("title")).toBe(i18n.t("editor.taskField.repeatNoAnchor"));
    teardown(view, host);
  });

  it("still blames the RULE when the rule is also unreadable", () => {
    const { view, host } = mount("- [ ] shower [repeat:: every fortnight]\n");
    const flagged = host.querySelector('[data-testid="editor.task-field-invalid-repeat"]');
    expect(flagged!.getAttribute("title")).toBe(i18n.t("editor.taskField.invalidRepeat"));
    teardown(view, host);
  });

  it("chips again as soon as the line gains an anchor", () => {
    // The verdict is a property of the RECORD, so it follows the record.
    const { view, host } = mount("- [ ] shower [due:: 2026-08-01] [repeat:: every day]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-repeat"]').length).toBe(1);
    expect(host.querySelectorAll('[data-testid="editor.task-field-invalid-repeat"]').length).toBe(
      0,
    );
    teardown(view, host);
  });

  // myne#276 — the tooltip was the WHOLE explanation, and it required already
  // knowing where to hover. This one failure's repair is somewhere else on the
  // line (a due date that isn't there), so unlike the other three hints, reading
  // the flagged text is not the diagnosis. It renders inline.
  it("explains itself inline, not only on hover", () => {
    const { view, host } = mount("- [ ] shower [repeat:: every day]\n");
    const hint = host.querySelector('[data-testid="editor.task-field-hint"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(i18n.t("editor.taskField.repeatNoAnchor"));
    teardown(view, host);
  });

  it("contributes no bytes — the note on disk is what the user typed", () => {
    const raw = "- [ ] shower [repeat:: every day]\n";
    const { view, host } = mount(raw);
    expect(view.state.doc.toString()).toBe(raw);
    teardown(view, host);
  });

  it("shows no inline hint for a rule that is simply unreadable", () => {
    // That text IS the diagnosis — an aside repeating it would be noise.
    const { view, host } = mount("- [ ] shower [repeat:: every fortnight]\n");
    expect(host.querySelector('[data-testid="editor.task-field-hint"]')).toBeNull();
    teardown(view, host);
  });

  it("drops the inline hint as soon as the line gains an anchor", () => {
    const { view, host } = mount(
      "- [ ] shower [due:: 2026-08-01] [repeat:: every day]\n",
    );
    expect(host.querySelector('[data-testid="editor.task-field-hint"]')).toBeNull();
    teardown(view, host);
  });

  it("accepts a reminder as the anchor", () => {
    // A pure reminder still recurs (decisions.md 2026-07-30: the anchor is
    // `due`, else `remind`), so it must still chip.
    const { view, host } = mount("- [ ] call mother [remind:: 2026-08-01] [repeat:: every week]\n");
    expect(host.querySelectorAll('[data-testid="editor.task-chip-repeat"]').length).toBe(1);
    teardown(view, host);
  });

  it("stays reachable and byte-exact, so the user can fix it", () => {
    const raw = "- [ ] shower [repeat:: every day]\n";
    const { view, host } = mount(raw);
    let atomic = 0;
    view.state.facet(EditorView.atomicRanges).forEach((f) => {
      const iter = f(view).iter();
      while (iter.value !== null) {
        atomic++;
        iter.next();
      }
    });
    expect(atomic).toBe(0);
    expect(view.state.doc.toString()).toBe(raw);
    teardown(view, host);
  });
});

describe("recurrence rules display localized over canonical storage (task 11)", () => {
  it("renders the rule through the catalogue, not the stored bytes", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01] [repeat:: every 3 days]\n");
    const chip = host.querySelector('[data-testid="editor.task-chip-repeat"]');
    expect(chip!.textContent).toBe(i18n.t("recurrence.everyN.day", { count: 3 }));
    teardown(view, host);
  });

  it("translates weekday and ordinal names individually", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01] [repeat:: last friday of every month]\n");
    const chip = host.querySelector('[data-testid="editor.task-chip-repeat"]');
    expect(chip!.textContent).toBe(
      i18n.t("recurrence.ordinalOfMonth", {
        ordinal: i18n.t("recurrence.ordinal.last"),
        weekday: i18n.t("recurrence.weekday.friday"),
      }),
    );
    teardown(view, host);
  });

  it("shows the anchoring mode rather than dropping it", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-08-01] [repeat:: every 3 days when done]\n");
    const chip = host.querySelector('[data-testid="editor.task-chip-repeat"]');
    expect(chip!.textContent).toContain(
      i18n.t("recurrence.whenDone", { rule: "" }).replace(/^,?\s*/, "").trim(),
    );
    teardown(view, host);
  });

  // Only `locales/en/common.json` is hand-maintained; every other catalog is
  // Weblate-managed and must not be edited in the repo. So the second language
  // is supplied at RUNTIME here — which is a truer test anyway: it proves the
  // label comes from the catalog rather than from anything baked into the code.
  const useTurkish = async (): Promise<void> => {
    i18n.addResourceBundle(
      "tr",
      "common",
      { recurrence: { every: { week: "her hafta" } } },
      true,
      true,
    );
    await i18n.changeLanguage("tr");
  };

  it("switching language changes the display and NOT the file", async () => {
    const doc = "- [ ] x [due:: 2026-08-01] [repeat:: every week]\n";
    const en = mount(doc);
    const english = en.host.querySelector('[data-testid="editor.task-chip-repeat"]')!.textContent;
    expect(english).toBe("every week");
    teardown(en.view, en.host);

    await useTurkish();
    const tr = mount(doc);
    const turkish = tr.host.querySelector('[data-testid="editor.task-chip-repeat"]')!.textContent;
    // The display moved…
    expect(turkish).toBe("her hafta");
    // …and the bytes did not. This is the whole safety property: a vault must
    // not end up carrying two languages.
    expect(tr.view.state.doc.toString()).toBe(doc);
    teardown(tr.view, tr.host);
    await i18n.changeLanguage("en");
  });

  it("the chip hands the SOURCE value to the editor, never the localized label", async () => {
    await useTurkish();
    const { view, host } = mount("- [ ] x [due:: 2026-08-01] [repeat:: every week]\n");
    const chip = host.querySelector('[data-testid="editor.task-chip-repeat"]') as HTMLElement;
    expect(chip.textContent).toBe("her hafta");

    let detail: { value: string } | null = null;
    view.dom.addEventListener(TASK_CHIP_EVENT, (e) => {
      detail = (e as CustomEvent<{ value: string }>).detail;
    });
    chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    // If the label leaked here, a commit would write Turkish into the file.
    expect(detail).not.toBeNull();
    expect(detail!.value).toBe("every week");
    teardown(view, host);
    await i18n.changeLanguage("en");
  });
});
