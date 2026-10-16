// The docked sheet shell (myne-md/myne#884).
//
// One box, four surfaces: the task-field sheet and the three typeahead pickers.
// It owns the parts that are the same for all of them (the geometry that keeps the
// sheet above the software keyboard, the header with its Back and Close controls,
// the scrolling body, and the actions row that must never be inside that scroll)
// and nothing about what goes in the body.
//
// **Why `bottom` is computed rather than declared.** `position: fixed; bottom: 0`
// means the bottom of the LAYOUT viewport, and on iOS the layout viewport does not
// shrink for the software keyboard. `floating/viewport.ts` turns the visible
// viewport into the two numbers this needs. The height travels to CSS as a custom
// property, so the only thing the stylesheet decides is what FRACTION of the
// visible area the sheet may take.
//
// **Why the actions are a sibling of the body rather than a child.** The body
// scrolls; a Save button inside it scrolls away, and on a phone with the keyboard
// up that is the same dead end as the anchored popover this replaces.
//
// The caller owns the backdrop, the focus trap and the Escape/Enter routing
// (`host/lib/imperative-modal`), exactly as the anchored surfaces do, so dismissal
// behaves identically in both presentations.

import { dockGeometry, subscribeVisibleViewport, visibleViewport } from "./viewport";

export type DockedSheet = {
  /** The sheet box. Append it to whatever the caller mounted (a modal backdrop). */
  readonly root: HTMLElement;
  /** The scrolling region. Its children are the sheet's content. */
  readonly body: HTMLElement;
  /** The pinned row under the body, for commit and cancel controls. */
  readonly actions: HTMLElement;
  setTitle: (text: string) => void;
  /** Show or hide the Back control. `null` hides it, which is what the first step
   *  of a wizard wants: it has nowhere to go back to. */
  setBack: (handler: (() => void) | null) => void;
  /** Stop tracking the viewport. Idempotent. */
  dispose: () => void;
};

export function createDockedSheet(opts: {
  title: string;
  testId: string;
  /** Accessible label for the Back control (its visible glyph is an arrow). */
  backLabel: string;
  /** Accessible label for the Close control. */
  closeLabel: string;
  /** Fired by the Close control. The dismissal itself belongs to the caller. */
  onClose: () => void;
}): DockedSheet {
  const shell = buildShell(opts);

  const actions = document.createElement("div");
  actions.className = "cm-docked-sheet-actions";
  actions.setAttribute("data-testid", `${opts.testId}-actions`);

  shell.root.append(actions);

  return {
    root: shell.root,
    body: shell.body,
    actions,
    setTitle: shell.setTitle,
    setBack: shell.setBack,
    dispose: shell.dispose,
  };
}

/** Everything the two docked surfaces share: the box and its wiring to the
 *  visible viewport, the header with its title and Close control, and the
 *  scrolling body. What differs is what goes INSIDE the body (`createDockedSheet`
 *  appends a pinned actions row beside it; `createDockedPicker` puts a
 *  `role="menu"` list in it), so that difference is one append at each constructor
 *  rather than two copies of the shell. */
type DockedShell = {
  root: HTMLElement;
  body: HTMLElement;
  setTitle: (text: string) => void;
  setBack: (handler: (() => void) | null) => void;
  dispose: () => void;
};

function buildShell(opts: {
  title: string;
  testId: string;
  backLabel: string;
  closeLabel: string;
  onClose: () => void;
}): DockedShell {
  const root = document.createElement("div");
  root.className = "cm-docked-sheet";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", opts.title);
  root.setAttribute("data-testid", opts.testId);

  const header = document.createElement("div");
  header.className = "cm-docked-sheet-header";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "cm-docked-sheet-back";
  back.setAttribute("aria-label", opts.backLabel);
  back.setAttribute("data-testid", `${opts.testId}-back`);
  back.textContent = "\u2190";
  back.hidden = true;

  const title = document.createElement("span");
  title.className = "cm-docked-sheet-title";
  title.setAttribute("data-testid", `${opts.testId}-title`);
  title.textContent = opts.title;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "cm-docked-sheet-close";
  close.setAttribute("aria-label", opts.closeLabel);
  close.setAttribute("data-testid", `${opts.testId}-close`);
  close.textContent = "\u00d7";
  close.addEventListener("click", () => opts.onClose());

  header.append(back, title, close);

  const body = document.createElement("div");
  body.className = "cm-docked-sheet-body";
  body.setAttribute("data-testid", `${opts.testId}-body`);

  root.append(header, body);

  // Measured on creation and then on every change. A rotation, the keyboard
  // arriving or leaving, and iOS scrolling the page to reveal a caret all move
  // these numbers, and a sheet that measured once would keep the stale ones for as
  // long as it stayed open.
  const apply = (): void => {
    const geometry = dockGeometry(visibleViewport());
    root.style.bottom = `${geometry.bottom}px`;
    root.style.setProperty("--cm-visible-h", `${geometry.maxHeight}px`);
  };
  apply();
  const unsubscribe = subscribeVisibleViewport(apply);

  let disposed = false;
  return {
    root,
    body,
    setTitle: (text: string) => {
      title.textContent = text;
      root.setAttribute("aria-label", text);
    },
    setBack: (handler: (() => void) | null) => {
      back.hidden = handler === null;
      back.onclick = handler;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

/** One docked typeahead picker: the sheet shell around a `role="menu"` list the
 *  caller fills with rows (myne-md/myne#884, task 5).
 *
 *  **No actions row.** A picker commits by TAPPING a row, so a pinned commit bar
 *  would be an empty bordered strip under a list that already does the job.
 *
 *  **No Back control.** It is built (the shell's header is shared) and stays
 *  hidden: a picker has one step, so there is nowhere to go back to.
 *
 *  **Not modal, deliberately.** The caller appends {@link DockedPicker.root} to
 *  the document directly rather than to a `host/lib/imperative-modal` backdrop,
 *  and installs no focus trap, because the editor has to KEEP the focus: the user
 *  narrows the list by continuing to type. A modal sheet would take the keyboard
 *  away from the typeahead it is presenting. */
export type DockedPicker = {
  /** The sheet box. Append it to `document.body`. */
  readonly root: HTMLElement;
  /** The `role="menu"` region. Its children are the picker's rows. */
  readonly list: HTMLElement;
  setTitle: (text: string) => void;
  /** Stop tracking the viewport. The caller removes `root`; idempotent. */
  dispose: () => void;
};

export function createDockedPicker(opts: {
  title: string;
  testId: string;
  /** Accessible label for the Close control. */
  closeLabel: string;
  /** Fired by the Close control. The dismissal itself belongs to the caller. */
  onClose: () => void;
}): DockedPicker {
  const shell = buildShell({ ...opts, backLabel: "" });

  const list = document.createElement("div");
  list.className = "cm-docked-picker-list";
  list.setAttribute("role", "menu");
  list.setAttribute("data-testid", `${opts.testId}-list`);
  shell.body.replaceChildren(list);

  return {
    root: shell.root,
    list,
    setTitle: shell.setTitle,
    dispose: shell.dispose,
  };
}
