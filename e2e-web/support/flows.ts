// Shared multi-step flows for the web E2E lane (MYND-574 task 105).
//
// The desktop lane's `e2e/support/flows.ts` exists because scenarios that
// re-roll "unlock and get to the editor" drift apart, and then a change to the
// unlock screen breaks eleven files in eleven different ways. Same reasoning
// here, over a different entry sequence: a browser's first run is account number
// → password → a vault that does not exist locally yet, which desktop never
// does.
//
// **`byTestId` only.** `e2e/AGENTS.md`'s non-negotiable, and it applies to this
// lane verbatim: no CSS-class selectors, no text matching. Text selectors break
// on translation and quietly re-pass when the wrong element happens to contain
// the right substring.
//
// **No credential ever reaches a failure message.** Every assertion here is
// shaped so its failure diff carries a testid or a boolean, never a password, an
// account number or a phrase — the same SYNC-13 rule the desktop lane follows,
// and the reason `waitForTestId` reports the ID it was waiting for rather than
// dumping the page.

import type { Session } from "./session";
import { testIdSelector } from "./session";

/** Long enough for a first paint plus the wasm module's instantiation, which is
 *  the slowest thing between navigation and the first testid on this client. */
const BOOT_TIMEOUT_MS = 30_000;
/** Argon2id at production parameters, in a browser, on a CI runner. */
const UNLOCK_TIMEOUT_MS = 60_000;

/** Navigate to the app origin and wait for the boot probe to render something.
 *
 *  The BETA-TERMS gate is part of "something". `AccountBootstrap` renders it
 *  ahead of the account-entry step whenever consent is missing (myne-ops#15),
 *  and a fresh browser profile has no consent — so on the web client it is the
 *  FIRST screen, every time. This helper used to wait only for the three
 *  admitted surfaces, none of which exists behind the gate, and every scenario
 *  in the lane died in `openApp` with a boot timeout, all with the same message,
 *  which reads like the bundle failing to start rather than
 *  like one screen that was added in front of it.
 *
 *  The desktop lane was given a consent seed (`multi-device.ts`'s
 *  `legalConsentSeed`) in the same change; the web lane has no config dir to
 *  seed, so it accepts the terms the way a user does — through the button. */
export async function openApp(session: Session, origin: string): Promise<void> {
  await session.navigate(origin);
  // Include the gate in the probe so a hang still reports WHICH surface never
  // appeared rather than timing out on three that cannot appear.
  const seen = await waitForAnyTestId(
    session,
    ["bootstrap.beta-terms", "account-entry.input", "unlock.password-input", "editor.root"],
    BOOT_TIMEOUT_MS,
  );
  if (seen === "bootstrap.beta-terms") {
    // OPEN the dialog first. The gate itself renders only a heading, an intro
    // and a "review the terms" button; the accept button lives inside
    // `BetaTermsConsent`, which `AccountBootstrap` mounts with `open={termsOpen}`
    // and `ModalShell` renders as NOTHING while that is false. Waiting for
    // `sync.beta-terms.accept` straight off the gate therefore waits for an
    // element that cannot exist until this click, which is how the lane spent 12
    // of 20 tests timing out inside `openApp` on a message that reads like a
    // dead bundle. The user's own path is review-then-accept; so is this.
    const review = await session.byTestId("bootstrap.beta-terms.open", {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    await review.click();
    // SCROLL first. The terms carry a long full-text block, and in the browser
    // lane's viewport the accept button sits below it — `/click`'s own
    // scroll-into-view only guarantees the border box intersects the VIEWPORT,
    // which is not the same as revealing an element clipped inside an
    // overflowing container (`support/webdriver.ts` says so at the helper this
    // uses). Without it the click reports "element interactable" forever, which
    // reads like a disabled button and is really one that is off-screen.
    const accept = await session.byTestId("sync.beta-terms.accept", {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    await accept.scrollIntoView();
    await accept.click();
    await waitForAnyTestId(
      session,
      ["account-entry.input", "unlock.password-input", "editor.root"],
      BOOT_TIMEOUT_MS,
    );
  }
}

/** The first-run identity step: type an account number and continue. */
export async function enterAccountNumber(session: Session, accountNumber: string): Promise<void> {
  const input = await session.byTestId("account-entry.input", { timeoutMs: BOOT_TIMEOUT_MS });
  await input.sendKeys(accountNumber);
  await (await session.byTestId("account-entry.submit")).click();
  // The password step of the bootstrap, NOT the unlock screen: on a first run
  // there is no local vault to unlock yet.
  await session.byTestId("account-bootstrap.password", { timeoutMs: BOOT_TIMEOUT_MS });
}

/**
 * The whole first run: account number, password, and whatever the join returns.
 *
 * Returns which door it landed on rather than asserting one, because BOTH are
 * correct outcomes and which one you get depends on the account's device roster
 * — a browser enrolling on the password path lands `pending` until an existing
 * device approves it (`server-protocol.md` §3.1), and task 92 leaves a browser no
 * other path. A helper that assumed "approved" would fail on the ordinary case.
 */
export async function bootstrapAccount(
  session: Session,
  accountNumber: string,
  password: string,
): Promise<"approved" | "pending"> {
  await enterAccountNumber(session, accountNumber);
  await (await session.byTestId("account-bootstrap.password")).sendKeys(password);
  await (await session.byTestId("account-bootstrap.submit")).click();
  const landed = await waitForAnyTestId(
    session,
    ["account-bootstrap.pending-notice", "unlock.password-input", "editor.root"],
    UNLOCK_TIMEOUT_MS,
  );
  return landed === "account-bootstrap.pending-notice" ? "pending" : "approved";
}

/** Type the master password on the unlock screen and wait for the editor. */
export async function unlockToEditor(session: Session, password: string): Promise<void> {
  await (
    await session.byTestId("unlock.password-input", { timeoutMs: BOOT_TIMEOUT_MS })
  ).sendKeys(password);
  await (await session.byTestId("unlock.submit")).click();
  await session.byTestId("editor.root", { timeoutMs: UNLOCK_TIMEOUT_MS });
}

/**
 * Wait until every note the sidebar shows has reached the server.
 *
 * Read from the DOM, through the task-23 marker, and with **one extra
 * condition that is the whole point**: the sidebar must be mounted and showing
 * at least one row. "No unsynced markers" is trivially true of an unmounted
 * sidebar, and a first-sync assertion that passes before the list renders would
 * pass on every run including the broken ones.
 *
 * Deliberately NOT a page-side call into the client: `e2e/AGENTS.md`'s
 * zero-test-hooks rule applies to this lane verbatim, and an
 * `window.__MYNE_WEB_E2E__` bridge would be exactly the production hook it
 * forbids.
 */
export async function waitForFirstSync(session: Session, timeoutMs = 120_000): Promise<void> {
  await session.waitUntil(
    async () => {
      const rows = await session.byTestIdAll("notes.row");
      if (rows.length === 0) return null; // the list has not rendered yet
      const unsynced = await session.byTestIdAll("notes.row-unsynced");
      return unsynced.length === 0 ? true : null;
    },
    { label: "every visible note has reached the server", timeoutMs },
  );
}

/**
 * Wait for whichever of `testIds` appears first, and return it.
 *
 * The value is in the FAILURE: a scenario that waits for one testid and gets a
 * different screen fails with "timed out waiting for X", which says nothing
 * about what actually rendered. This one names the set it was watching, so the
 * message points at the fork rather than at one arm of it.
 */
export async function waitForAnyTestId(
  session: Session,
  testIds: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return session.waitUntil(
    async () => {
      for (const id of testIds) {
        if ((await session.byTestIdAll(id)).length > 0) return id;
      }
      return null;
    },
    { label: `one of [${testIds.join(", ")}]`, timeoutMs },
  );
}

// ── Typing into the editor, which took four attempts to get right ──────────
//
// Everything below exists because getting one keystroke into the web editor is
// not the desktop lane's `typeIntoEditor`, and three of the obvious routes fail
// DIFFERENTLY (myne-md/myne#556):
//
//   * `Element.click()` on `.cm-content` times out on the driver's
//     interactability check ("element interactable + clicked" after 10s);
//   * a scripted `.focus()` leaves CodeMirror without a selection, so the
//     keystrokes go nowhere and the buffer stays empty — the worst of the three,
//     because nothing errors;
//   * `Element.sendKeys` on that handle is refused outright ("element not
//     interactable"), which is chromedriver's view of a contenteditable div.
//
// …and none of them land at all until the importer overlay is dismissed.

/**
 * Dismiss the fresh-vault importer onboarding overlay, if it is up.
 *
 * It covers the editor and SWALLOWS the click that would place the caret —
 * probed: `document.activeElement` stayed `BODY` and `.cm-editor.cm-focused`
 * was `false` after an `actionClick` that reported success. The desktop lane's
 * `dismissImporterOffer` exists for the same reason; this lane had no
 * equivalent because nothing here had needed to type into a fresh vault.
 *
 * Tolerant by design: a vault that already holds notes shows no overlay, and a
 * hard wait would burn its budget on something correctly absent.
 */
export async function dismissImporterOfferIfPresent(session: Session): Promise<void> {
  const present = await session.findElements(testIdSelector("importer.offer-root"));
  if (present.length === 0) return;
  await session.execute(
    "document.querySelector('[data-testid=\"importer.offer-dismiss\"]')?.click();",
  );
  await session.waitForGone(testIdSelector("importer.offer-root"), { timeoutMs: 15_000 });
}

/**
 * Create a note from the sidebar's create button and wait for its editor.
 *
 * The create actions used to live behind a `+` menu (`notes.new-menu` →
 * `notes.new-menu-dropdown`). e35c8a7b (myne#779) replaced it with direct
 * buttons on BOTH clients; `e2e/support/flows.ts` followed the move and this
 * lane did not, so every scenario that creates a note clicked a `null` until
 * this was fixed. `notes.create` is the button that carried over.
 *
 * NO rename step, unlike the desktop helper: `notes.create` lands directly on a
 * mounted `editor.content` with no `notes.rename-input` anywhere in the tree. A
 * helper copied from `e2e/support/flows.ts` waits fifteen seconds for that
 * input and then reports a timeout that reads like a broken sidebar.
 *
 * Scripted clicks rather than driver clicks, which is this lane's working idiom
 * — `quarantine-roundtrip.e2e.ts` records that the driver cannot click a
 * settings tab here.
 */
export async function createNote(session: Session): Promise<void> {
  await session.execute(
    "document.querySelector('[data-testid=\"notes.create\"]').click();",
  );
  await session.waitForElement(testIdSelector("editor.content") + " .cm-content", {
    timeoutMs: 20_000,
  });
}

/**
 * Click one open context-menu item by its `data-item-id`, and wait for the
 * menu to react.
 *
 * A DOM `click()`, for the reason {@link openNoteContextMenu} records about the
 * gesture that opens the menu: the driver's synthesized pointer does not reach
 * this surface in Chromium. Measured here too — the driver click on the
 * `export` parent row spends its whole 10 s interactability budget and lands
 * nothing, while a dispatched click mounts the submenu at once.
 *
 * Returns the item ids present after the click, so a caller asserting what a
 * submenu contains reads one value rather than re-querying.
 */
export async function clickContextMenuItem(
  session: Session,
  itemId: string,
  waitForItemId?: string,
): Promise<string[]> {
  await session.execute(
    `var el = document.querySelector('[data-testid="notes.context-menu-item"][data-item-id="${itemId}"]');` +
      `if (!el) throw new Error('no context-menu item ${itemId} to click');` +
      "el.click();",
  );
  return session.waitUntil(
    async () => {
      const raw = await session.execute<string>(
        "return JSON.stringify([].slice.call(" +
          "document.querySelectorAll('[data-testid=\"notes.context-menu-item\"]')" +
          ").map(function (e) { return e.getAttribute('data-item-id'); }));",
      );
      const ids = JSON.parse(raw) as string[];
      if (waitForItemId === undefined) return ids.length > 0 ? ids : null;
      return ids.includes(waitForItemId) ? ids : null;
    },
    { label: `context menu after clicking ${itemId}`, timeoutMs: 15_000 },
  );
}

/**
 * Click a LEAF context-menu item, one that performs its action and dismisses
 * the menu, and wait for the menu to be gone.
 *
 * The pair to {@link clickContextMenuItem}, which waits for the menu to still
 * be there because it is used on rows that OPEN a submenu. Waiting for items
 * after a leaf click is waiting for a menu that is on its way out, so the two
 * cases cannot share one contract: the first version of this scenario used the
 * submenu helper on a format row and timed out against a menu that had closed
 * exactly as it should.
 *
 * Same DOM click, same reason: {@link openNoteContextMenu} records that the
 * driver's synthesized pointer does not reach this surface in Chromium.
 */
export async function clickContextMenuLeaf(session: Session, itemId: string): Promise<void> {
  await session.execute(
    `var el = document.querySelector('[data-testid="notes.context-menu-item"][data-item-id="${itemId}"]');` +
      `if (!el) throw new Error('no context-menu leaf ${itemId} to click');` +
      "el.click();",
  );
  await session.waitUntil(
    async () => {
      const n = await session.execute<number>(
        "return document.querySelectorAll('[data-testid=\"notes.context-menu-item\"]').length;",
      );
      return n === 0 ? true : null;
    },
    { label: `context menu dismissed after ${itemId}`, timeoutMs: 15_000 },
  );
}

/**
 * Open a note row's context menu, and wait until it has items.
 *
 * **A dispatched `contextmenu`, not the driver's right-click, and that is a
 * MEASUREMENT rather than a shortcut.** `Element.rightClick()` in the shared
 * W3C client is a real pointer press with button 2, and it is what the desktop
 * lane uses successfully against WebKitGTK. In Chromium it produces nothing:
 * the Actions request is accepted (no "not interactable", no "click
 * intercepted") and no `contextmenu` event reaches the page. Measured side by
 * side in one session on a seeded vault, on the same row, one line apart: the
 * driver press left 0 menu items and a dispatched event left 10.
 *
 * Nothing in this lane had ever opened a context menu before, so the primitive
 * was carried, unexercised, from a suite where it works. A scenario reaching
 * for it would have timed out and read as "the web client has no context menu",
 * which is the wrong finding: the product's handler is on the row, shared with
 * desktop, and it fires.
 *
 * The event carries `bubbles` because the handler is on the row itself and the
 * menu positions from `clientX`/`clientY`, so both are supplied rather than
 * defaulted to the origin, where a menu would render in the page corner.
 */
export async function openNoteContextMenu(
  session: Session,
  opts: { x?: number; y?: number } = {},
): Promise<string[]> {
  const x = opts.x ?? 40;
  const y = opts.y ?? 40;
  await session.execute(
    "var r = document.querySelector('[data-testid=\"notes.row\"]');" +
      "if (!r) throw new Error('no notes.row to open a context menu on');" +
      `r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${x}, clientY: ${y} }));`,
  );
  return session.waitUntil(
    async () => {
      const raw = await session.execute<string>(
        "return JSON.stringify([].slice.call(" +
          "document.querySelectorAll('[data-testid=\"notes.context-menu-item\"]')" +
          ").map(function (e) { return e.getAttribute('data-item-id'); }));",
      );
      const ids = JSON.parse(raw) as string[];
      return ids.length > 0 ? ids : null;
    },
    { label: "the note context menu opened", timeoutMs: 15_000 },
  );
}

/**
 * Type into the editor: dismiss the overlay, place a real caret, send keys to
 * whatever has focus.
 *
 * The click is `actionClick` (a real pointer move + press through the W3C
 * Actions API) because that is what places a caret, and the keys go through the
 * Actions KEYBOARD source, which has no element target and therefore reaches
 * the focused node — the same thing a user's keyboard does.
 *
 * Asserts the text landed rather than trusting that the driver accepted it: a
 * `sendKeys` that resolves means the DRIVER took the keys, not that CodeMirror
 * applied them, and the desktop lane has paid for that distinction more than
 * once (`e2e/AGENTS.md`, the `typeEmbedIntoEditor` note).
 */
export async function typeIntoEditor(session: Session, text: string): Promise<void> {
  await dismissImporterOfferIfPresent(session);
  const content = await session.waitForElement(
    testIdSelector("editor.content") + " .cm-content",
    { timeoutMs: 20_000 },
  );
  await content.actionClick();
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [...text].flatMap((ch) => [
          { type: "keyDown", value: ch },
          { type: "keyUp", value: ch },
        ]),
      },
    ],
  });
  let seen = "";
  await session.waitUntil(
    async () => {
      seen =
        (await session.execute<string>(
          "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
            "return c ? (c.textContent || '') : '';",
        )) ?? "";
      return seen.includes(text.trim()) ? true : null;
    },
    {
      label: () =>
        `the editor buffer to carry the typed text — it reads ${JSON.stringify(seen)}. ` +
        `An empty buffer after a click that reported success is the importer ` +
        `overlay swallowing the caret placement, or a focus that CodeMirror did ` +
        `not act on; see this module's header for the routes that fail that way.`,
      timeoutMs: 15_000,
    },
  );
}

/**
 * Scrape the 24 revealed phrase words in `data-index` order, in ONE in-page
 * pass rather than 48 round trips. Each cell's LAST span carries the word; the
 * first is the index numeral.
 *
 * Shape-only assertions on purpose (SYNC-13): a phrase that never reaches a log
 * cannot be quoted out of a CI report.
 */
export async function scrapePhrase(session: Session, stem: string): Promise<string[]> {
  const words = await session.execute<string[]>(
    "var words = [];" +
      "for (var i = 1; i <= 24; i++) {" +
      "  var el = document.querySelector(" +
      "    '[data-testid=\"' + arguments[0] + '\"][data-index=\"' + i + '\"] span:last-child');" +
      "  words.push(el ? el.textContent || '' : '');" +
      "}" +
      "return words;",
    [stem],
  );
  if (words.length !== 24 || words.some((w) => w.length === 0)) {
    throw new Error(`scrapePhrase: expected 24 non-empty words at ${stem}, got ${words.length}`);
  }
  return words;
}

/**
 * Complete the first-run identity ceremony, which since myne-md/myne#768 stands
 * in front of vault creation on every client.
 *
 * The ceremony is network-free by construction (`IdentitySetupPanel`: the
 * keypair derives from the phrase and the frame is sealed locally), so it
 * completes against an unreachable sync origin. That is what makes it safe for
 * the web lane, whose account-creation scenarios point registration at
 * `https://sync.unreachable.test` on purpose: reaching the vault flow through
 * the ceremony does not borrow a server that could not be reached.
 *
 * Leaves the app at whatever the caller's next stage is; on first run that is
 * the safety briefing, then the vault name.
 */
export async function createFirstRunIdentity(
  session: Session,
  prefix = "first-run.identity",
): Promise<void> {
  await (await session.byTestId(`${prefix}.create-cta`, { timeoutMs: 30_000 })).click();
  await session.byTestId(`${prefix}.phrase`, { timeoutMs: 120_000 });
  // Every control here is scrolled into view before it is clicked. The headless
  // web viewport is 413 px tall and the ceremony's scroll container is an inner
  // element rather than the document, which chromedriver's own auto-scroll does
  // not reach: the control reports `element not interactable` with
  // `elementFromPoint` returning null at its centre. The briefing step in this
  // same file already carries that measurement; the 24-word grid is taller
  // still.
  const reveal = await session.byTestId(`${prefix}.phrase-reveal`);
  await reveal.scrollIntoView();
  await reveal.click();
  const words = await scrapePhrase(session, `${prefix}.phrase-word`);
  const cont = await session.byTestId(`${prefix}.phrase-continue`);
  await cont.scrollIntoView();
  await cont.click();

  const cells = await session.byTestIdAll(`${prefix}.confirm-input`);
  if (cells.length !== 4) {
    throw new Error(`createFirstRunIdentity: expected 4 confirm cells, got ${cells.length}`);
  }
  for (const cell of cells) {
    const pos = Number(await cell.attribute("data-index"));
    if (!(pos >= 1 && pos <= 24)) {
      throw new Error(`createFirstRunIdentity: confirm cell declares data-index ${pos}`);
    }
    await cell.scrollIntoView();
    await cell.sendKeys(words[pos - 1]);
  }
  const done = await session.byTestId(`${prefix}.close-cta`);
  await session.waitUntil(() => done.enabled(), {
    label: "identity Done enabled (4/4 words match)",
    timeoutMs: 20_000,
  });
  await done.scrollIntoView();
  await done.click();
}
