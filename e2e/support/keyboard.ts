// Shared keyboard-driving helpers for the accessibility E2E specs (MYND-93).
//
// Keys are sent through the W3C Actions API (a `key` input source), so they
// land on the document's FOCUSED element rather than a specific node — the
// right model for Tab/Shift-Tab/Escape navigation.
//
// CRITICAL: the W3C key code points are PRIVATE-USE characters (U+E004 Tab,
// U+E007 Enter, …). Writing them as literals would put invisible bytes in the
// source — the exact U+E007 hazard the harness warns about. So they are built
// with `String.fromCharCode(...)`, keeping this file pure ASCII.

import type { Session } from "./webdriver";

/** W3C WebDriver key code points (https://www.w3.org/TR/webdriver2/#keyboard-actions). */
export const KEY = {
  TAB: String.fromCharCode(0xe004),
  /** Erases the character BEFORE the caret — the key macOS labels "delete",
   *  and the one a user reaches for to erase text. Distinct from `DELETE`
   *  below, which is forward-delete. */
  BACKSPACE: String.fromCharCode(0xe003),
  /**
   * W3C `Enter`. **It does not activate a `<button>` in this lane**, and that
   * is a property of the driver rather than of the app (myne-md/myne#728).
   *
   * Measured in this container, not reasoned: focus a button, press one key,
   * then read `document.activeElement` and the button's own computed style.
   *
   *     U+E007 (Enter)   -> no click. The handler never runs.
   *     U+E006 (Return)  -> no click.
   *     U+E00D (Space)   -> clicks, and focus lands where the handler sends it.
   *
   * It cost an afternoon on `a11y-keyboard.e2e.ts` ak4, and the reason it is
   * expensive is that the failure wears the shape of a product bug: every
   * other assertion was green, the target was present, inside its region, not
   * inert, and took focus when `.focus()` was called on it directly. The only
   * tell was the button still carrying its focused-state style afterwards,
   * meaning its `onClick` had never run.
   *
   * So drive a button with {@link KEY.SPACE} here, and SAY SO at the press:
   * the finding does not generalise to users, because a real WebKitGTK window
   * does activate a focused button on Enter. What fails is the driver's
   * synthesis of it, so "Enter activates this control" stays a claim for the
   * manual keyboard pass (`agent-tooling/docs/dev/accessibility-checklist.md` section 1)
   * rather than one this suite can make.
   */
  ENTER: String.fromCharCode(0xe007),
  ESCAPE: String.fromCharCode(0xe00c),
  /** W3C `Space`. The activation key that WORKS on a button here; see
   *  {@link KEY.ENTER} for the measurement and for why a scenario using this
   *  must say it is a statement about the driver. */
  SPACE: String.fromCharCode(0xe00d),
  SHIFT: String.fromCharCode(0xe008),
  CONTROL: String.fromCharCode(0xe009),
  /** W3C `Meta` — Command on macOS.
   *
   *  Needed by the BROWSER lane rather than this one (myne-md/myne#556): the
   *  desktop suite runs on Linux, where the app's `Mod` resolves to Ctrl, so
   *  `CONTROL` was the only modifier any chord here ever needed. The web lane
   *  runs on whatever OS the developer or runner has, and on macOS the same
   *  binding is Cmd — a `Ctrl+K` sent there opens nothing, and the scenario
   *  times out on a dialog that was never asked for. Resolve the modifier from
   *  the page's own `navigator.platform`, the way `src/commands/chord.ts` does. */
  META: String.fromCharCode(0xe03d),
  DELETE: String.fromCharCode(0xe017),
  /** W3C `Home`. Selecting with Shift+Home is how a scenario gets a
   *  selection without depending on the app's `Mod-a` binding, which is
   *  rebindable AND scoped (`editor/src/keymap.ts` narrows select-all to
   *  the frontmatter block or the body depending on where the caret is). */
  HOME: String.fromCharCode(0xe011),
  /** W3C `End`, the sibling of HOME above. */
  END: String.fromCharCode(0xe010),
  /** W3C `ArrowUp` / `ArrowDown`. Vertical caret motion is Myne's own command
   *  (`editor/src/line-vertical.ts`, myne-md/myne#631) rather than CodeMirror's,
   *  and its defect only exists under a real layout engine, so this lane is the
   *  only one that can press these against the shipped behaviour. */
  ARROW_UP: String.fromCharCode(0xe013),
  ARROW_DOWN: String.fromCharCode(0xe015),
  /** W3C `ArrowLeft`. The same lane uses it to walk back from a line's end to a
   *  known interior column, which is a fact a click cannot give it. */
  ARROW_LEFT: String.fromCharCode(0xe012),
  /**
   * W3C `ArrowRight`, the sibling of ARROW_LEFT.
   *
   * No scenario in this lane presses it, and this comment previously claimed
   * one did ("the sidebar tree uses the horizontal pair to expand and
   * collapse a folder"). That is true of the APP and false of this suite:
   * AK-2 presses only ArrowDown, and the folder expand/collapse path is
   * covered in jsdom (`tests/a11y/folderTree.test.ts`) and by no real-render
   * scenario. Corrected rather than deleted, for the reason {@link KEY.META}
   * is also here while belonging to the other lane: this table documents the
   * W3C code points, and a half-populated one is what sends the next author
   * to an inline `String.fromCharCode`, which four files already do.
   */
  ARROW_RIGHT: String.fromCharCode(0xe014),
  /** W3C `F6`, the three-region cycle (myne-md/myne#728). The function keys
   *  run U+E031 (F1) upward, so F6 is U+E036; written through
   *  `fromCharCode` like every other key here so the file stays pure ASCII. */
  F6: String.fromCharCode(0xe036),
} as const;

/** Press a single key (optionally with Shift held) at the focused element. */
export async function pressKey(
  session: Session,
  key: string,
  opts: { shift?: boolean } = {},
): Promise<void> {
  const actions: Array<Record<string, unknown>> = [];
  if (opts.shift) actions.push({ type: "keyDown", value: KEY.SHIFT });
  actions.push({ type: "keyDown", value: key });
  actions.push({ type: "keyUp", value: key });
  if (opts.shift) actions.push({ type: "keyUp", value: KEY.SHIFT });
  await session.send("POST", "/actions", {
    actions: [{ type: "key", id: "kbd", actions }],
  });
  // Release the driver's input-source state between chains (W3C "release
  // actions") so a held modifier never leaks into the next press.
  await session.send("DELETE", "/actions");
}

/**
 * Type `text` at whatever currently holds focus, one key action per character.
 *
 * The distinction from `Element.sendKeys` is the whole reason this exists:
 * element-scoped typing FOCUSES the element first, so a scenario asserting that
 * a field already owned focus cannot use it — the helper would create the
 * condition it is meant to observe. Driving the keyboard input source instead
 * sends the burst wherever focus actually is, which is what VU-13
 * (`vault-unlock.e2e.ts`) is about: the password field owning focus early
 * enough at first paint that a burst typed immediately arrives whole.
 */
export async function typeIntoActive(session: Session, text: string): Promise<void> {
  const actions: Array<Record<string, unknown>> = [];
  for (const ch of text) {
    actions.push({ type: "keyDown", value: ch });
    actions.push({ type: "keyUp", value: ch });
  }
  await session.send("POST", "/actions", {
    actions: [{ type: "key", id: "kbd", actions }],
  });
  await session.send("DELETE", "/actions");
}

/** Tab (or Shift-Tab) once. */
export function tab(session: Session, opts: { shift?: boolean } = {}): Promise<void> {
  return pressKey(session, KEY.TAB, opts);
}

/** Press `key` while holding a single modifier (e.g. Ctrl+K to open the
 *  command palette). `key` is a plain character; `modifier` a KEY escape. */
export async function pressChord(
  session: Session,
  modifier: string,
  key: string,
): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: modifier },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: modifier },
        ],
      },
    ],
  });
}

/** `data-testid` of the focused element, or null. */
export function activeTestId(session: Session): Promise<string | null> {
  return session.execute<string | null>(
    "return document.activeElement ? document.activeElement.getAttribute('data-testid') : null",
  );
}

/**
 * **`blur()` does not reset the Tab sequence** (myne-md/myne#728). The engine
 * resumes from where the blurred element sat, so the next Tab is not the
 * document's first stop and a walk that counts from an imagined start is
 * counting from somewhere else. Anchor on a known element, assert the anchor
 * with {@link activeSignature} or {@link activeTestId}, and only then walk;
 * `a11y-keyboard.e2e.ts` ak4 and `saved-views-table-list.e2e.ts` svt3 both do.
 */
/** A stable focus signature: `testid:<id>` when the focused element carries a
 *  testid, else `<tag>#<id>`, else `(body)` — enough to detect movement and
 *  traps without needing every control to be testid'd. */
export function activeSignature(session: Session): Promise<string> {
  return session.execute<string>(
    "var el = document.activeElement;" +
      "if (!el || el === document.body) return '(body)';" +
      "var tid = el.getAttribute('data-testid');" +
      "if (tid) return 'testid:' + tid;" +
      "return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');",
  );
}

/** Tab forward up to `maxTabs` times, stopping when the focused element's
 *  testid equals `testId`. Returns true if reached. */
export async function tabToTestId(
  session: Session,
  testId: string,
  maxTabs = 12,
): Promise<boolean> {
  for (let i = 0; i < maxTabs; i++) {
    if ((await activeTestId(session)) === testId) return true;
    await tab(session);
  }
  return (await activeTestId(session)) === testId;
}

/** Press Tab `count` times, returning the focus signature after each press. */
export async function tabSignatures(
  session: Session,
  count: number,
  opts: { shift?: boolean } = {},
): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await tab(session, opts);
    seen.push(await activeSignature(session));
  }
  return seen;
}
