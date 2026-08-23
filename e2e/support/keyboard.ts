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
  ENTER: String.fromCharCode(0xe007),
  ESCAPE: String.fromCharCode(0xe00c),
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
