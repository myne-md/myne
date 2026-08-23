// The quick picker traps focus and gives it back — in a BROWSER, where the
// engine owns focus. myne-md/myne#556, the `search.quick-picker` bullet:
//
//   > focus stays inside the dialog and Esc returns focus to the opener is
//   > exactly what KN-4/KN-5 already assert on the same shared component; the
//   > same assertions run on all three seats.
//
// # Why running the same assertions again on a second engine is not redundant
//
// The component is shared, so the LOGIC is the same code `e2e/keyboard-nav-working.e2e.ts`
// already drives. What is not shared is the thing being asserted: focus order,
// what `Tab` does at the end of a subtree, and where focus lands when an
// element is removed from the document are the ENGINE's behaviour, and WebKitGTK
// (the desktop lane) and Chromium (here) are two different implementations of
// it. A focus trap correct on one is not thereby correct on the other — which is
// the entire reason the platform-seam contract tests exist for the seam and not
// for the DOM.
//
// The failure this catches is also specific to a browser: a trap that leaks lets
// Tab reach the BROWSER's own chrome — the address bar, the extensions menu — at
// which point a keyboard user is outside the app entirely and the vault is open
// behind them. There is no address bar in the desktop shell.
//
// # What is asserted
//
//  1. Opening moves focus INTO the dialog (a dialog that opens without focus is
//     one a keyboard user cannot reach at all);
//  2. Tab keeps it inside, repeatedly — one Tab proves nothing, since the first
//     stop is usually inside anyway;
//  3. Esc closes it and RESTORES focus to the opener, rather than dropping focus
//     to `<body>`, which is where a screen reader loses its place.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import { KEY, pressChord, pressKey, activeSignature } from "../e2e/support/keyboard";
import type { Session } from "./support/session";

/** True when the focused element is inside the element carrying `testId`. */
function activeWithin(session: Session, testId: string): Promise<boolean> {
  return session.execute<boolean>(
    'var root = document.querySelector(\'[data-testid="\' + arguments[0] + \'"]\');' +
      "return !!(root && document.activeElement && root.contains(document.activeElement));",
    [testId],
  );
}

describeE2E("the quick picker's focus trap in a browser", () => {
  it("takes focus, keeps it through repeated Tab, and hands it back on Esc", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      // The palette's toggle derives its `when` context from the FOCUSED
      // element, so something in the app has to hold focus before the chord
      // means anything — `e2e/keyboard-nav-working.e2e.ts` focuses the editor
      // by typing into it for exactly this reason. This fixture holds no notes
      // (the lane's own comment says so), so the editor never mounts; focus is
      // put on the shell instead, which is the context the palette also
      // answers in.
      await session.execute(
        "document.querySelector('[data-testid=\"editor.bottom-bar\"] button')?.focus();",
      );

      // The modifier is resolved from the PAGE, not assumed. `Mod` is Cmd on
      // macOS and Ctrl everywhere else (`src/commands/chord.ts::isMacPlatform`),
      // and this lane runs on whatever OS the developer or runner has — unlike
      // the desktop suite, which is Linux-only and can hard-code Ctrl. A
      // hard-coded Ctrl+K on a Mac seat opens nothing and the scenario times out
      // waiting for a dialog it never asked for, which reads like a broken
      // palette. Measured, not guessed: that is exactly what the first run did.
      const isMac = await session.execute<boolean>(
        "return /Mac|iP(hone|[oa]d)/.test(navigator.platform);",
      );
      const MOD = isMac ? KEY.META : KEY.CONTROL;

      // Opened through the command palette's own binding rather than a click,
      // because the claim is about KEYBOARD users and a pointer-opened dialog
      // is a different path.
      await pressChord(session, MOD, "k");
      await session.waitForElement('[data-testid="palette.dialog"]', { timeoutMs: 15_000 });

      // 1. Focus is INSIDE on open.
      expect(
        await activeWithin(session, "palette.dialog"),
        `opening the palette left focus at ${await activeSignature(session)} rather ` +
          `than inside it — a dialog that opens without focus is one a keyboard ` +
          `user cannot reach at all`,
      ).toBe(true);

      // 2. It STAYS inside. Repeatedly, because the first Tab stop is usually
      //    inside anyway and one press would prove nothing about the trap.
      for (let i = 0; i < 8; i += 1) {
        await pressKey(session, KEY.TAB);
        expect(
          await activeWithin(session, "palette.dialog"),
          `after ${i + 1} Tab press(es) focus escaped to ${await activeSignature(session)}. ` +
            `In a browser the next stop after the page is the BROWSER's own chrome — ` +
            `the address bar, the extensions menu — so a leaked trap puts a keyboard ` +
            `user outside the app with the vault open behind them.`,
        ).toBe(true);
      }

      // …and backwards, which is a separate code path in every engine.
      for (let i = 0; i < 4; i += 1) {
        await pressKey(session, KEY.TAB, { shift: true });
        expect(
          await activeWithin(session, "palette.dialog"),
          `after ${i + 1} Shift+Tab press(es) focus escaped to ${await activeSignature(session)}`,
        ).toBe(true);
      }

      // 3. Esc closes it and gives focus BACK.
      await pressKey(session, KEY.ESCAPE);
      await session.waitUntil(
        async () =>
          (await session.findElements('[data-testid="palette.dialog"]')).length === 0
            ? true
            : null,
        { label: "the palette closed on Escape", timeoutMs: 10_000 },
      );

      const after = await activeSignature(session);
      expect(
        after,
        `after Esc, focus is at ${after}. Dropping focus to <body> is where a ` +
          `screen reader loses its place: the next Tab starts from the top of the ` +
          `document rather than from where the user was.`,
      ).not.toBe("(body)");
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
