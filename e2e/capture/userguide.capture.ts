// User-guide screenshot capture pass (guide-golive, MYND-252 gate #7).
//
// NOT a test — a CAPTURE tool that rides the real-IPC harness. It drives
// the production binary through tauri-driver, builds a realistic
// (non-sensitive) vault entirely through the UI, then writes one PNG per
// guide frame to `e2e/artifacts/userguide/`. Run via the dedicated
// container path (`scripts/capture-userguide.sh`); it is excluded from
// `pnpm test:e2e` by file extension (`*.capture.ts`, not `*.e2e.ts`).
//
// Why through the harness and not natively: tauri-driver has no macOS
// support (docs/dev/e2e.md), and there is no mock layer (src/AGENTS.md),
// so a plain browser can't boot the app. The Linux/webkit2gtk + xvfb seat
// is the only automated path — and it sidesteps the macOS/Windows
// screen-capture protection that blocks the OS screenshot API, because
// Linux has no content-protection backend (PrivacyPanel.tsx).
//
// Discipline: zero test hooks, zero capability changes (E2E contract).
// Navigation is by `data-testid` where present, else by stable
// accessible selectors (aria-label) or CSS classes — read-only, no
// production edits. Every frame is independent and best-effort: a frame
// that can't be reached is logged and skipped, never aborting the rest of
// the pass. The screenshot-freshness gate at golive re-runs this against
// the shipping build before publish.
//
// Reading order (study before reorganizing): clean single-pane editor
// frames first (view modes, focus, folding, find, slash, comments, stats,
// spell), then the static Markdown render samples, then sidebar/notes
// frames, saved views, the search/tag/backlink overlays (opened then
// dismissed so they don't block later frames), then ALL settings panels
// inside ONE settings-modal open, then attachments, and the GRAPH frame
// LAST (it occupies a workspace tab over the editor). Every transient
// editor state (focus, find bar, reading mode, split view) is toggled OFF
// after its capture so it does not corrupt the frames that follow.

import { it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { harnessSupported, launchApp, REPO_ROOT } from "./../support/session";
import { seedVault } from "./../support/fixtures";
import {
  activeNoteId,
  clickRibbonUntilVisible,
  clickUntilVisible,
  clickNoteRow,
  closeSettings,
  createNote as createNoteFlow,
  dismissImporterOffer,
  enableDeveloperModeInSettings,
  openExportSubmenuItem,
  pageSeatInvoke,
  pasteIntoEditor,
  rightClickBySelector,
  rowMenuPick,
  nameNewNote,
  searchAndOpenNote,
  selectSettingsTopic,
  setFolderNotesEnabled,
  setViewsEnabled,
  waitForSaved,
  runPaletteAction,
  unlockToEditor,
  createFolder,
} from "./../support/flows";
import { testIdSelector, type Element, type Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "userguide");
const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";
const CM_EDITOR = testIdSelector("editor.content") + " .cm-editor";
const ENTER = String.fromCharCode(0xe007); // W3C key: commit inline rename
const ESCAPE = String.fromCharCode(0xe00c); // W3C key: dismiss overlays/menus
const CTRL = String.fromCharCode(0xe009); // W3C modifier (sticky until repeated)
const HOME = String.fromCharCode(0xe011); // W3C Home key
const END = String.fromCharCode(0xe010); // W3C End key
const SHIFT = String.fromCharCode(0xe008); // W3C modifier (extend selection)
const ARROW_RIGHT = String.fromCharCode(0xe014); // W3C ArrowRight

interface FrameRecord {
  name: string;
  slug: string; // guide article the frame belongs to
  alt: string; // literal alt text (voice rules; golive finalizes copy)
  ok: boolean;
  note?: string; // failure reason when !ok
}

const frames: FrameRecord[] = [];
const capturedNoteIds = new Map<string, string>();

/** Snap the current viewport to `<OUT_DIR>/<name>.png` and record it. */
async function capture(session: Session, name: string, slug: string, alt: string): Promise<void> {
  const png = await session.screenshot();
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(png, "base64"));
  frames.push({ name, slug, alt, ok: true });
  // eslint-disable-next-line no-console
  console.log(`[capture] OK ${name}.png`);
}

/** Wrap a frame so a single unreachable surface never kills the pass. */
async function frame(
  session: Session,
  name: string,
  slug: string,
  alt: string,
  build: () => Promise<void>,
): Promise<void> {
  try {
    await build();
    await capture(session, name, slug, alt);
  } catch (e) {
    // A locked vault makes every REMAINING frame fail on its own wait, and each
    // one costs its full timeout before it does. The failure then reads as a
    // moved surface ("waitUntil(waitForElement([data-testid=…])) timed out"),
    // which is what sent the last investigation hunting selectors. Probe once
    // and say so: the session is over, not the frame.
    const locked = await session
      .findElements(testIdSelector("unlock.password-input"))
      .then((rows) => rows.length > 0)
      .catch(() => false);
    const note = `${locked ? "vault auto-locked; " : ""}${String(e).slice(0, 200)}`;
    frames.push({ name, slug, alt, ok: false, note });
    // eslint-disable-next-line no-console
    console.warn(`[capture] FAIL ${name} — ${note.slice(0, 160)}`);
  }
}

/** Use the shared E2E flow for create + title commit. The title field lives in
 *  a CodeMirror widget and can remount during typing, so the helper re-finds it
 *  and verifies that the title reached the sidebar before returning. */
async function createNote(session: Session, title: string): Promise<void> {
  await createNoteFlow(session, title);
  const noteId = await activeNoteId(session);
  if (!noteId) throw new Error(`createNote left no active note tab for "${title}"`);
  capturedNoteIds.set(title, noteId);
}

/** Create a note and fill it with a real English body (so frames show a
 *  populated note, not an empty pane). The created note stays open and
 *  selected — create the note you want on screen LAST. */
async function createNoteWithBody(session: Session, title: string, body: string): Promise<void> {
  await createNote(session, title);
  // Let the new note's CodeMirror finish (re)mounting before driving it —
  // a paste fired into a mid-remount editor throws "stale element".
  await sleep(700);
  await typeBody(session, body);
}

/** Current CodeMirror document text (textContent — the doc nests in
 *  .cm-line children this driver's getText drops). Re-found per call. */
async function editorText(session: Session): Promise<string> {
  return (await session.waitForElement(CM_CONTENT)).textContent();
}

/** Inject `text` into the live CodeMirror document via a synthetic paste
 *  event. Keystroke typing is unusable for Markdown samples — CodeMirror's
 *  bracket auto-close eats `[ ]` (so `> [!note]` collapses to `!note` and
 *  the callout never renders).
 *
 *  The mechanism moved to `support/flows.ts` when the theme-preview capture
 *  needed the same verbatim insert; this alias keeps the local name (used at
 *  ~30 call sites below) pointing at the one implementation. */
const typeBody = pasteIntoEditor;

/** Try a list of CSS selectors in order, click the first that resolves. */
async function clickFirst(session: Session, selectors: string[], timeoutMs = 6000): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = await session.waitForElement(sel, { timeoutMs });
      await el.click();
      return;
    } catch {
      // try the next selector
    }
  }
  throw new Error(`none of the selectors resolved: ${selectors.join(" | ")}`);
}

/** Short fixed settle (covers lazy KaTeX / mermaid / canvas mounts). */
async function settle(_session: Session, ms: number): Promise<void> {
  await sleep(ms);
}

/** Run a vault-building step; log and swallow failures so a finicky
 *  affordance never aborts the frame-capture phase that follows. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[capture] setup skip (${label}) — ${String(e).slice(0, 140)}`);
  }
}

// ---- navigation idioms adapted from the matching E2E scenarios ----------

/** Press one Ctrl+<key> chord via the W3C Actions API — Control DOWN →
 *  key DOWN → key UP → Control UP (find-replace.e2e.ts `sendCtrlChord`;
 *  Ctrl is the Linux-container modifier). */
async function ctrlChord(session: Session, key: string): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: CTRL },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: CTRL },
        ],
      },
    ],
  });
}

/** Press a single bare key (Escape) via the W3C Actions API. */
async function pressKey(session: Session, key: string): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
        ],
      },
    ],
  });
}

/** Press `key` while holding every modifier in `mods` (all down, key, all up)
 *  via the W3C Actions API. Used by the multi-cursor frame (Shift+ArrowRight to
 *  select a word, then Ctrl+d to add occurrences). */
async function pressChord(session: Session, mods: string[], key: string): Promise<void> {
  const downs = [...mods, key].map((value) => ({ type: "keyDown", value }));
  const ups = [...mods, key].reverse().map((value) => ({ type: "keyUp", value }));
  await session.send("POST", "/actions", {
    actions: [{ type: "key", id: "kbd", actions: [...downs, ...ups] }],
  });
}

/** Right-click the sidebar row titled `title` and click the context-menu item
 *  whose `data-item-id` is `itemId`. The row context-menu idiom recurs across
 *  the new notes-organization frames (favourite / delete / archive / export). */
async function rowContextAction(session: Session, title: string, itemId: string): Promise<void> {
  const noteId = capturedNoteIds.get(title) ?? (await noteIdByTitle(session, title));
  try {
    await rowMenuPick(session, noteId, itemId);
  } catch (e) {
    // A failed menu item must not leave a transparent overlay covering every
    // later best-effort frame in the same capture session.
    try {
      await pressKey(session, ESCAPE);
    } catch (dismissError) {
      throw new AggregateError([e, dismissError], "row context action and overlay dismissal failed");
    }
    throw e;
  }
}

/** Open the sidebar note titled `title` by matching the row textContent.
 *  Note rows share `data-testid="notes.row"`; there is no public
 *  title→id map, so scan the rows' text (the byTestIdAll idiom from
 *  saved-views-entry.e2e.ts `openRowMenu`). Keep the id rather than the row
 *  element, which can go stale as the list updates after a save. */
async function noteIdByTitle(session: Session, title: string): Promise<string> {
  return session.waitUntil(
    async () => {
      for (const r of await session.byTestIdAll("notes.row")) {
        if ((await r.textContent()).includes(title)) {
          const noteId = await r.attribute("data-note-id");
          if (noteId) return noteId;
        }
      }
      return null;
    },
    // 20s: the guide vault carries ~20 notes and byTestIdAll scans every row's
    // textContent per poll — under the @2x retina render that occasionally
    // exceeds the old 12s (best-effort frames then flaked "row timed out").
    { label: `notes.row titled "${title}"`, timeoutMs: 20000 },
  );
}

/** Open a captured note through palette search and return its id. The sidebar
 *  virtualizes rows outside its viewport, so scanning `notes.row` cannot find
 *  every note once the sample vault has grown. */
async function openNoteByTitle(session: Session, title: string): Promise<string> {
  const noteId = capturedNoteIds.get(title) ?? (await noteIdByTitle(session, title));
  // One retry, and it is not a substitute for a diagnosis: it is the diagnosis.
  // `palettePick` types the title through W3C element-send-keys, and under CPU
  // load on this host WebKit intermittently drops the SHIFT of the FIRST
  // character, so the input ends up holding the same NUMBER of characters in
  // the wrong case ("papers on local-first" for "Papers on local-first"). The helper's own nudge
  // retypes it the same way, the row never matches, and the frame dies on a
  // 45 s palette wait that reports "held 12 of 12 typed characters" — lengths
  // only, by design (SYNC-13), which is why the case never showed up in the
  // message and the failure read as a search bug.
  //
  // The QUERY is therefore lowercased: `searchNotes` lowercases both sides
  // (`src/notes/searchNotes.ts`), so the match is unaffected, while the typed
  // string needs no SHIFT at all and the whole failure class disappears at its
  // source rather than being retried around. The retry stays for every other
  // way the palette can lose a query. Safe, unlike a frame-level retry: opening
  // a note creates nothing, so a second attempt cannot duplicate a sample note.
  // Escape first, because a failed attempt leaves the palette OPEN and the next
  // `sendKeys` would append to the half-typed query.
  const query = title.toLowerCase();
  try {
    await searchAndOpenNote(session, query, noteId);
  } catch {
    await pressKey(session, ESCAPE).catch(() => {});
    await searchAndOpenNote(session, query, noteId);
  }
  await sleep(500); // let the editor swap to the selected note
  return noteId;
}

/** The sidebar row Element titled `title` (no click), for static read-only
 *  capture state. Use `rowMenuPick` for row actions so it re-finds by id. */
async function noteRowByTitle(session: Session, title: string): Promise<Element> {
  return session.waitUntil(
    async () => {
      for (const r of await session.byTestIdAll("notes.row")) {
        if ((await r.textContent()).includes(title)) return r;
      }
      return null;
    },
    // 20s to match openNoteByTitle — see the note there (row-scan under @2x load).
    { label: `notes.row titled "${title}" (no click)`, timeoutMs: 20000 },
  );
}

/** Type `text` into the live editor via real keystrokes (NOT paste).
 *  The slash menu suppresses a pasted `/`, so the slash + voice frames
 *  need genuine typing on a fresh line start (slash-datetime.e2e.ts). */
async function keyTypeIntoEditor(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  // Establish the keystroke pipeline and land the caret on a fresh line.
  await session.waitUntil(
    async () => {
      await content.sendKeys("x" + ENTER);
      return (await editorText(session)).includes("x") || null;
    },
    { label: "keystroke pipeline established at a line start", timeoutMs: 10000 },
  );
  // Reuse the SAME focused handle — refetching CM_CONTENT here drops focus, so
  // the "/" never reaches the editor and the slash menu never opens.
  await content.sendKeys(text);
}

/** Type a slash query on a fresh line and wait for the menu to open, retrying
 *  once. `keyTypeIntoEditor` proves the keystroke pipeline works by typing `x`,
 *  which says nothing about the SLASH reaching the menu handler: the two frames
 *  that use it sit at opposite ends of the pass, and `voice-notes` arrives from
 *  the attachments library, where the editor has just been remounted. Measured
 *  there: `x` landed, `/record` did not open the menu, and the frame was lost
 *  after its 8 s wait. Escape + one more attempt costs a couple of seconds and
 *  a second `x` in a throwaway note. */
async function typeSlashCommand(session: Session, query: string): Promise<void> {
  await keyTypeIntoEditor(session, query);
  try {
    await session.waitForElement(".cm-slash-menu", { timeoutMs: 4_000 });
  } catch {
    await pressKey(session, ESCAPE).catch(() => {});
    await keyTypeIntoEditor(session, query);
    await session.waitForElement(".cm-slash-menu", { timeoutMs: 8_000 });
  }
}

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

runner(
  "captures user-guide frames",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    // Which palette this run produces. Read here rather than at the theme step
    // because the manifest is written after the walk and reports it.
    const captureTheme = process.env.CAPTURE_THEME === "dark" ? "dark" : "light";
    const app = await launchApp({
      // Production KDF: the weak-KDF fixture's m_kib=8 is below the
      // validate_kdf_params 8 MiB floor (protocol, 2026-06-17) and the binary
      // rejects it as corrupt. Production params are valid + honest for a
      // real-looking vault. Slower unlock (~1-2s Argon2), fine for capture.
      seed: (dir) => void (password = seedVault(dir, { kdf: "production" }).password),
    });
    const s = app.session;
    try {
      // ---- Frame: the unlock screen (MUST run before the vault is opened) ----
      // The only frame that has to come first: this surface is unreachable for
      // the rest of the pass once the vault is unlocked, and re-locking to get
      // it back would throw away the vault the pass just built. It is also the
      // one frame whose whole subject is the state the harness normally spends
      // its first seconds leaving.
      await frame(
        s,
        "unlock-screen",
        "getting-started/unlocking-your-vault",
        "The unlock screen: the vault's name, the master-password field, and the recovery-phrase and delete-vault links below it.",
        async () => {
          await s.byTestId("unlock.password-input", { timeoutMs: 15_000 });
          // The gate resolves when the node is in the DOM, which is mid-way
          // through the screen's entrance fade: the first capture of this frame
          // had the heading at half opacity and no password field visible at all.
          await settle(s, 1_000);
        },
      );

      await unlockToEditor(s, password);
      await dismissImporterOffer(s);

      // ---- Keep the session alive for the length of the pass ----
      // The desktop auto-lock default is 300 s (`myne_core::DEFAULT_AUTO_LOCK_SECS`),
      // and this pass legitimately runs far longer, so the vault locked about
      // five minutes in and every frame after that waited out its own timeout on
      // the unlock screen: 18 frames lost, the 900 s test timeout hit, no
      // manifest written. The reason it is not a flake is the idle SOURCE:
      // `src-tauri/src/auto_lock.rs::machine_idle` reads X11 ScreenSaver on
      // Linux, and WebDriver input never reaches the X server (tauri-driver
      // drives WebKit, not X), so that clock grows from the moment the session
      // starts while the frontend's own heartbeat stays fresh. `effective_idle_from`
      // prefers the machine value over the window one, so the heartbeat cannot
      // save it. Raising the pref to the envelope's ceiling (3600 s, `AUTO_LOCK_CEILING_SECS`)
      // is the real user-facing command, not a test hook; the console stays
      // untouched. Deliberately NOT `safe()`: if this fails the pass is doomed
      // and a clear abort now costs 5 s instead of ten minutes of lying waits.
      await pageSeatInvoke(s, "plugin:prefs|set_auto_lock_timeout", { seconds: 3600 }, 15_000);
      const prefsAfter = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 15_000);
      const autoLockSecs = (prefsAfter.ok as { auto_lock_seconds?: number | null } | null)
        ?.auto_lock_seconds;
      if (autoLockSecs !== 3600) {
        throw new Error(
          `auto-lock did not take (auto_lock_seconds=${String(autoLockSecs)}); the pass would lock mid-walk`,
        );
      }

      // ---- Build a realistic, non-sensitive vault through the UI ----
      // All content is English (the guide is English) and mundane (no
      // secrets appear on screen). Each step is best-effort: a finicky
      // affordance degrades richness but never blocks the capture phase.
      // Every note gets a real body so no frame shows an empty pane.
      await safe("folder Projects", () => createFolder(s, "Projects"));
      await safe("folder Research", () => createFolder(s, "Research"));

      await safe("note Field notes", () =>
        createNoteWithBody(
          s,
          "Field notes from the beta",
          "\nWhat is still rough, in the order it bites:\n\n" +
            "- [ ] Attachments on a locked vault\n" +
            "- [x] Full-text search across the vault\n" +
            "- [x] Markdown editor with live preview\n\n" +
            "Tagged #beta #shipping\n\n" +
            "The reading behind it is in the [[Papers on local-first]].\n",
        ),
      );
      await safe("note Papers", () =>
        createNoteWithBody(
          s,
          "Papers on local-first",
          "\nWhat to read before the next design pass:\n\n" +
            "1. Local-first software: the seven ideals\n" +
            "2. Convergent replicated data types, in practice\n" +
            "3. Why a server that cannot read is cheaper to trust\n",
        ),
      );
      await safe("note Friday log", () =>
        createNoteWithBody(
          s,
          "Friday log",
          "\nWhat moved this week:\n\n" +
            "- The editor lost its last toolbar\n" +
            "- The sidebar stopped shouting\n\n" +
            "Next week: the migration, on a real vault. See the [[Field notes from the beta]],\n" +
            "and the [[Start here]] note if you are new to this vault.\n",
        ),
      );

      // Small, single-purpose notes so the frames that photograph one behaviour
      // have an unambiguous subject: the spellchecker, an inline comment, and a
      // heading long enough to fold.
      await safe("note Letter", () =>
        createNoteWithBody(
          s,
          "Letter to the landlord",
          "\nDear Mr Aldridge,\n\nThe raddiator in the back room has been cold since Tuesday and the\n" +
            "boiler makes a noise I can only descibe as resigned. Could somebody\nlook at it this week?\n",
        ),
      );
      await safe("note Recipe", () =>
        createNoteWithBody(
          s,
          "Recipe notes",
          "\nSourdough, third attempt. Mix at 68% hydration and leave it overnight.\n\n" +
            "%%the oven runs 15C hot, so drop everything by a notch%%\n\n" +
            "Score deep, bake 20 minutes with steam, then leave it alone for an hour.\n",
        ),
      );
      await safe("note Server budget", () =>
        createNoteWithBody(
          s,
          "Server budget",
          "\n## What it costs to run\n\n" +
            "A small instance is enough for two people.\n" +
            "Storage grows with attachments, not with notes.\n" +
            "Bandwidth is the whole bill once the blobs are sealed.\n" +
            "Everything else is a rounding error.\n",
        ),
      );

      // The onboarding note carries several headings, one nested, so the Outline
      // tab in the right panel has a legible structure to render.
      await safe("note Onboarding call", () =>
        createNoteWithBody(
          s,
          "Onboarding call",
          "\n## Who was on it\n\nTwo of us, and the new hire.\n\n" +
            "## What we covered\n\nWhere the vault lives, and what sync does.\n\n" +
            "### The part people ask about\n\nLosing the phrase, and what it costs.\n\n" +
            "## What happens next\n\nA second device, paired on Friday.\n\n" +
            "## Open questions\n\nWhether the export is readable without the app.\n",
        ),
      );

      // Unlinked-mention seed: a note that names the roadmap note in PLAIN TEXT
      // (not a [[wikilink]]) so the Unlinked mentions panel has a candidate.
      await safe("note Standup", () =>
        createNoteWithBody(
          s,
          "Standup, Tuesday",
          "\nWe walked through Field notes from the beta at standup and picked the next milestone.\n",
        ),
      );

      // Hub note LAST so it stays open + selected for the first frames.
      // Its wikilinks give the graph real edges (otherwise all nodes are
      // isolated and the graph reads as blank) and seed the roadmap note's
      // backlinks.
      await safe("note Start here", () =>
        createNoteWithBody(
          s,
          "Start here",
          "\nThis vault lives on this device and nowhere else until you turn sync " +
            "on. Every note, every title and every folder name is sealed before it " +
            "touches the disk, and the key never leaves this machine.\n\n" +
            "Start here:\n\n" +
            "- [[Field notes from the beta]]: what is still rough\n" +
            "- [[Papers on local-first]]: the reading behind it\n" +
            "- [[Friday log]]: how the week went\n\n" +
            "Nothing is uploaded, indexed or backed up anywhere unless you ask for it.\n",
        ),
      );

      // Best-effort: create a note inside the Projects folder and set it as
      // the folder index (folder-notes.e2e.ts: right-click the folder row →
      // "new-note", then right-click the note → "note.set-index").
      await safe("folder index note", async () => {
        await setFolderNotesEnabled(s, true);
        const folder = await s.waitForElement(testIdSelector("notes.folder-row"), {
          timeoutMs: 10000,
        });
        const folderPath = await folder.attribute("data-folder-path");
        if (!folderPath) throw new Error("folder row has no folder path");
        await rightClickBySelector(s, testIdSelector("notes.folder-row", { "data-folder-path": folderPath }));
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "new-note" }),
            { timeoutMs: 6000 },
          )
        ).click();
        // myne#653: a folder create names the note in the note, not in the
        // sidebar (the rename input is not opened any more).
        await nameNewNote(s, "Projects overview");
        await waitForSaved(s);
        const noteId = await activeNoteId(s);
        if (!noteId) throw new Error("creating the folder note left no active note tab");
        capturedNoteIds.set("Projects overview", noteId);
        const note = await noteRowByTitle(s, "Projects overview");
        const visibleNoteId = await note.attribute("data-note-id");
        if (visibleNoteId !== noteId) throw new Error("folder note row is not the created note");
        await rowMenuPick(s, noteId, "note.set-index");
        // MYND-370: setting a folder note now HIDES the note from the tree and
        // surfaces an "Open folder note" affordance on the folder's own row
        // (the old per-note index badge is gone). Wait for that affordance.
        await s.byTestId("notes.folder-index-affordance", { timeoutMs: 6000 });
      });
      await safe("dismiss setup menu", () => pressKey(s, ESCAPE));

      // =====================================================================
      // CLEAN SINGLE-PANE EDITOR FRAMES (every transient state toggled off
      // after capture so the next editor frame starts from Live + one pane).
      // =====================================================================

      // ---- Theme, once, before the first content frame ----
      // The marketing shots need a dark set and a light set, and the app's own
      // default is light, so a run without this step can only ever produce one
      // of the two. Set through the real preference command rather than by
      // clicking through Settings: `theme` is an AS3-low cosmetic pref with no
      // protective envelope, `plugin:prefs|set_theme` is what the panel calls,
      // and a console call cannot be thrown off by a moved tab or a rail that
      // is not mounted yet. `CAPTURE_THEME=light` reproduces the default.
      const themeSet = await pageSeatInvoke(
        s,
        "plugin:prefs|set_theme",
        { theme: captureTheme },
        15_000,
      );
      // `pageSeatInvoke` reports `{ ok }` on success and `{ err }` on failure,
      // and `set_theme` returns unit, so a successful call is `{ ok: null }`
      // and testing `.ok` for truthiness reads success as failure.
      if ("err" in themeSet) {
        throw new Error(`theme did not take: ${JSON.stringify(themeSet.err)}`);
      }
      // `setTheme` in `src/lib/prefs.ts` only PERSISTS the choice; the caller is
      // what applies it to `<html data-theme>` (`applyTheme`, `src/lib/theme.ts`),
      // and the Appearance panel is that caller. Invoking the command alone
      // therefore wrote the pref and left the screen on the app's default. The
      // first run of this pass produced a full light set under
      // `CAPTURE_THEME=dark` and nothing said so. Set the attribute too, which
      // is exactly what `applyTheme` does for an explicit choice.
      await s.execute(
        "document.documentElement.setAttribute('data-theme', arguments[0]);",
        [captureTheme],
      );
      await settle(s, 400);

      // ---- Frame: interface tour (populated editor) ----
      await frame(
        s,
        "interface-tour",
        "getting-started/interface-tour",
        "The Myne editor with the note sidebar on the left, a note open in the centre, and the bottom bar.",
        async () => {
          await openNoteByTitle(s, "Start here");
          await s.byTestId("editor.root");
        },
      );

      // ---- Frame: view modes (a note in Reading mode) ----
      // reading-source-modes.e2e.ts: the bottom-bar CTA cycles
      // live → reading → source → live; click once to reach Reading.
      await frame(
        s,
        "view-modes",
        "editor-and-writing/view-modes",
        "A note shown in reading mode, where Markdown is rendered for reading rather than editing.",
        async () => {
          await openNoteByTitle(s, "Papers on local-first");
          const cta = await s.byTestId("editor.view-mode-cta");
          await cta.click();
          await s.waitUntil(
            async () =>
              (await (await s.byTestId("editor.view-mode-cta")).attribute("data-view-mode")) ===
                "reading" || null,
            { label: "view-mode CTA reached reading", timeoutMs: 8000 },
          );
          await settle(s, 600);
        },
      );
      // Cycle back to Live (reading → source → live) so later editor frames
      // are not stuck in reading mode.
      await safe("reset view mode to live", async () => {
        for (let i = 0; i < 2; i++) {
          await (await s.byTestId("editor.view-mode-cta")).click();
          await sleep(300);
        }
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.view-mode-cta")).attribute("data-view-mode")) ===
              "live" || null,
          { label: "view-mode CTA back to live", timeoutMs: 8000 },
        );
      });

      // ---- Frame: focus mode (focus ON) ----
      // focus-mode.e2e.ts: runPaletteAction(view.toggle-focus) → editor.root
      // gains data-focus-active="true".
      await frame(
        s,
        "focus-mode",
        "editor-and-writing/focus-mode",
        "The editor in focus mode, with surrounding panels dimmed so only the current note stands out.",
        async () => {
          await openNoteByTitle(s, "Friday log");
          await settle(s, 500); // let the note + palette infra settle before the action
          await runPaletteAction(s, "view.toggle-focus", "focus");
          // Focus activates on the action; the data-focus-active attribute
          // proved unreliable as a gate (the screen is correctly dimmed), so
          // settle and capture the focus-mode state directly.
          await settle(s, 1200);
        },
      );
      // Toggle focus OFF (settle, not an attribute gate) so later editor frames
      // start with a normal, non-dimmed, sidebar-visible layout.
      await safe("toggle focus off", async () => {
        await runPaletteAction(s, "view.toggle-focus", "focus");
        await settle(s, 800);
      });

      // ---- Frame: folding (a folded heading section) ----
      // heading-list-folding.e2e.ts: hover the editor to reveal the inline fold
      // markers, click one, wait for the fold placeholder.
      await frame(
        s,
        "folding",
        "editor-and-writing/folding",
        "A note with a heading section folded, showing the collapsed placeholder where the hidden lines were.",
        async () => {
          await pressKey(s, ESCAPE); // ensure no lingering focus mode / overlay
          await settle(s, 300);
          await openNoteByTitle(s, "Server budget");
          await settle(s, 600);
          // Fold via the palette action (heading-list-folding.e2e.ts hlf2) —
          // robust and coordinate-free. The prior synthetic `.click()` fired at
          // (0,0), which mapped to the non-foldable frontmatter line, so nothing
          // folded and the placeholder never appeared (ok:false).
          await runPaletteAction(s, "editor.fold-all", "Fold all");
          await s.byTestId("editor.fold-placeholder", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );
      // Unfold so later editor frames start from a fully-expanded document.
      await safe("unfold all", () => runPaletteAction(s, "editor.unfold-all", "Unfold all"));

      // ---- Frame: find and replace (the find bar open with a query) ----
      // find-replace.e2e.ts: Ctrl+F opens find.input; reveal replace too.
      await frame(
        s,
        "find-and-replace",
        "editor-and-writing/find-and-replace",
        "The find and replace bar open over a note, with a search term entered.",
        async () => {
          await openNoteByTitle(s, "Papers on local-first");
          await settle(s, 400);
          await ctrlChord(s, "f");
          await (await s.byTestId("find.input", { timeoutMs: 10000 })).sendKeys("local");
          await safe("reveal replace row", async () => {
            await (await s.byTestId("find.toggle-replace")).click();
            await (await s.byTestId("find.replace-input")).sendKeys("E2EE");
          });
          await settle(s, 400);
        },
      );
      // Close the find bar (Esc) so it does not overlay later frames.
      await safe("close find bar", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone(testIdSelector("find.input"));
      });

      // ---- Frame: slash commands (the slash menu open) ----
      // slash-datetime.e2e.ts: type "/" on a fresh line → .cm-slash-menu.
      await frame(
        s,
        "slash-commands",
        "editor-and-writing/slash-commands",
        "The slash command menu open in a note, listing insertable blocks and actions.",
        async () => {
          await openNoteByTitle(s, "Friday log");
          await settle(s, 400);
          await typeSlashCommand(s, "/");
          await settle(s, 400);
        },
      );
      // Dismiss the slash menu (Esc) so it does not bleed into later frames.
      await safe("close slash menu", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone(".cm-slash-menu");
      });

      // ---- Frame: comments (the dimmed %%comment%% span) ----
      // comment.ts: an inline %%…%% span renders with class cm-comment.
      await frame(
        s,
        "comments",
        "editor-and-writing/comments",
        "A note containing an inline comment, shown dimmed between the surrounding visible text.",
        async () => {
          await openNoteByTitle(s, "Recipe notes");
          await s.waitForElement(".cm-comment", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: document statistics (the bottom-bar stats) ----
      // Editor.tsx exposes editor.doc-stats in the bottom bar.
      await frame(
        s,
        "document-statistics",
        "editor-and-writing/document-statistics",
        "The bottom bar of the editor showing the current note's word and character counts.",
        async () => {
          await openNoteByTitle(s, "Start here");
          await s.byTestId("editor.doc-stats", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: spell check (a misspelled word with the red squiggle) ----
      // spell.e2e.ts: spell errors carry data-testid="editor.spell-error";
      // poll the set and match a known typo by textContent.
      await frame(
        s,
        "spell-check",
        "editor-and-writing/spell-check",
        "A note with a misspelled word underlined by the spell checker.",
        async () => {
          await openNoteByTitle(s, "Letter to the landlord");
          const squiggle = await s.waitUntil(
            async () => {
              for (const el of await s.byTestIdAll("editor.spell-error")) {
                if ((await el.textContent()).trim() === "raddiator") return el;
              }
              return null;
            },
            { label: 'squiggle for "raddiator"', timeoutMs: 15000 },
          );
          // Best-effort: open the suggestion menu so the frame shows the fix UI.
          await safe("open spell suggestion menu", async () => {
            await squiggle.rightClick();
            await s.byTestId("spell.suggestion-menu", { timeoutMs: 6000 });
          });
          await settle(s, 400);
        },
      );
      // Dismiss any open spell suggestion menu before moving on.
      await safe("close spell menu", () => pressKey(s, ESCAPE));

      // ---- Static Markdown render frames (live CodeMirror preview) ----
      const mdSamples = [
        {
          name: "markdown-callouts",
          slug: "markdown/callouts",
          alt: "A note showing rendered callouts: note, tip, warning, and danger.",
          title: "Callouts sample",
          body:
            "\n> [!note] A note callout\n> Context that is good to know.\n\n" +
            "> [!tip] A tip callout\n> A helpful suggestion.\n\n" +
            "> [!warning] A warning callout\n> Something to be careful about.\n\n" +
            "> [!danger] A danger callout\n> A risky action.\n",
        },
        {
          name: "markdown-table",
          slug: "markdown/tables",
          alt: "A note showing a rendered three-column Markdown table.",
          title: "Table sample",
          body:
            "\n| Feature | Status | Notes |\n| --- | --- | --- |\n" +
            "| Notes | Shipped | Encrypted at rest |\n" +
            "| Search | Shipped | Local index |\n" +
            "| Sync | Planned | Phase 2 |\n",
        },
        {
          name: "markdown-equation",
          slug: "markdown/math",
          alt: "A note showing a rendered block equation set with KaTeX.",
          title: "Equation sample",
          body:
            "\nThe quadratic formula renders as a block equation:\n\n" +
            "$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$\n",
        },
        {
          name: "markdown-flowchart",
          slug: "markdown/diagrams",
          alt: "A note showing a rendered flowchart diagram.",
          title: "Flowchart sample",
          body:
            "\nA simple flow:\n\n```mermaid\nflowchart TD\n" +
            "  A[Write note] --> B[Autosave]\n  B --> C[Encrypt at rest]\n```\n",
        },
        {
          name: "markdown-basics",
          slug: "markdown/markdown-basics",
          alt: "A note showing rendered Markdown basics: a heading, bold and italic text, and a bulleted list.",
          title: "Markdown basics sample",
          body:
            "\n## A heading\n\nText can be **bold**, *italic*, or ~~struck through~~.\n\n" +
            "- First item\n- Second item\n- Third item\n\n1. Step one\n2. Step two\n",
        },
        {
          name: "markdown-code-block",
          slug: "markdown/code-blocks",
          alt: "A note showing a fenced code block with syntax highlighting.",
          title: "Code block sample",
          body:
            "\nInline `code` sits in a sentence. A fenced block renders highlighted:\n\n" +
            "```js\nfunction greet(name) {\n  return `Hello, ${name}`;\n}\n\ngreet(\"world\");\n```\n",
        },
        {
          name: "markdown-footnotes",
          slug: "markdown/footnotes-and-reference-links",
          alt: "A note showing a footnote reference with its rendered Footnotes list, plus a reference-style link.",
          title: "Footnotes sample",
          body:
            "\nLocal-first software keeps data on your device.[^1] More on the [project site][home].\n\n" +
            "[^1]: Your notes never require a server.\n\n[home]: https://myne.md\n",
        },
        {
          name: "markdown-inline-extras",
          slug: "markdown/html-and-inline-extras",
          alt: "A note showing a highlight, subscript and superscript, a coloured mark, an abbreviation and a keyboard key, all rendered inline.",
          title: "Inline extras sample",
          body:
            "\nBeyond the core syntax: ==a yellow highlight==, H~2~O, x^2^, and press <kbd>Ctrl</kbd>+<kbd>K</kbd>.\n\n" +
            "The same highlight in another color: <mark class=\"hl-green\">green</mark>, " +
            "and <abbr title=\"HyperText Markup Language\">HTML</abbr> explains itself on hover.\n\n" +
            "An emoji name renders too: :tada:\n",
        },
      ];
      for (const m of mdSamples) {
        await frame(s, m.name, m.slug, m.alt, async () => {
          await createNoteWithBody(s, m.title, m.body);
          await settle(s, 1500); // lazy KaTeX / mermaid render
        });
      }

      // ---- Frame: frontmatter properties (the Properties panel atop a note) ----
      // frontmatter.ts renders a PropertiesWidget (.cm-fm-properties) whenever a
      // note carries frontmatter — every capture note has managed title/updated.
      await frame(
        s,
        "frontmatter-properties",
        "markdown/frontmatter-properties",
        "The Properties panel at the top of a note, showing its title and frontmatter fields.",
        async () => {
          await openNoteByTitle(s, "Start here");
          await s.waitForElement(".cm-fm-properties", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: wikilinks (rendered [[wikilink]] pills) ----
      // wikilink/chip-widget.ts renders .cm-wikilink-chip when the caret is off
      // that line. "Start here" already contains three wikilinks.
      await frame(
        s,
        "wikilinks",
        "find-and-connect/wikilinks",
        "A note with rendered wikilink pills that link to other notes in the vault.",
        async () => {
          await openNoteByTitle(s, "Start here");
          await s.waitForElement(".cm-wikilink-chip", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: multiple cursors (same word selected in 3 places) ----
      // multi-cursor.e2e.ts mc2: select a word, Ctrl+d twice → data-selection-count=3.
      await frame(
        s,
        "multiple-cursors",
        "editor-and-writing/multiple-cursors",
        "A note with the same word selected in three places at once for simultaneous editing.",
        async () => {
          await createNoteWithBody(s, "Multiple cursors", "\nwidget widget widget in one line");
          await settle(s, 500);
          const content = await s.waitForElement(CM_CONTENT);
          await content.click();
          await content.sendKeys(CTRL + END + CTRL); // end of body
          await pressChord(s, [], HOME); // start of the "widget…" line
          for (let i = 0; i < 6; i++) await pressChord(s, [SHIFT], ARROW_RIGHT); // select "widget"
          await pressChord(s, [CTRL], "d"); // + 2nd occurrence
          await pressChord(s, [CTRL], "d"); // + 3rd occurrence
          await s.waitUntil(
            async () =>
              (await (await s.waitForElement(CM_EDITOR)).attribute("data-selection-count")) ===
                "3" || null,
            { label: "three selections", timeoutMs: 8000 },
          );
          await settle(s, 400);
        },
      );
      await safe("collapse multicursor", () => pressKey(s, ESCAPE));

      // ---- Frame: tasks (a note with inline task chips) ----
      // Bracketed task-field syntax ([due::/priority::/repeat::]) is the
      // canonical emit form (dialect/src/taskFieldWriter.ts), rendered as the
      // .cm-task-chip decoration (editor/src/host/notes/taskChipToken.ts).
      await frame(
        s,
        "tasks",
        "notes-and-organization/tasks",
        "A note with checkbox tasks carrying due, priority, and repeat chips shown inline.",
        async () => {
          await createNoteWithBody(
            s,
            "Launch checklist",
            "\n- [ ] Draft the quarterly review [due:: 2026-08-15] [priority:: high] [repeat:: every week]\n- [ ] Email the vendor [due:: 2026-08-02]\n- [x] Book the venue",
          );
          await settle(s, 600);
          await s.waitForElement(".cm-task-chip", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: export a note (the context-menu Export as Markdown entry) ----
      // note-export.e2e.ts: the in-app export pre-flight modal renders only for
      // attachment-bearing notes; a plain note goes to the native save dialog
      // (undriveable). The reachable in-app surface is the row context-menu item.
      await frame(
        s,
        "export-notes",
        "editor-and-writing/export-notes",
        "The note context menu with the Export as Markdown option, which saves a note as a Markdown file.",
        async () => {
          await createNote(s, "Export sample");
          const noteId = capturedNoteIds.get("Export sample");
          if (!noteId) throw new Error("export sample note id was not recorded");
          await rightClickBySelector(s, testIdSelector("notes.row", { "data-note-id": noteId }));
          // The formats sit under one `Export…` row since myne-md/myne#611, so
          // the screenshot has to open the submenu to show them at all.
          await openExportSubmenuItem(s, "export-markdown");
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "export-markdown" }),
            { timeoutMs: 6000 },
          );
          await settle(s, 400);
        },
      );
      await safe("close export menu", () => pressKey(s, ESCAPE));

      // ---- Frame: note snapshots (the version-history panel) ----
      // snapshots-restore.e2e.ts: a fresh vault has no snapshots, so seed ONE via
      // the sanctioned page-seat production IPC note_snapshot_flush, then open the
      // panel and select the row to show the preview pane.
      await frame(
        s,
        "note-snapshots",
        "safety-and-recovery/note-snapshots",
        "The note snapshots panel listing earlier saved versions of a note, with a preview of the selected one.",
        async () => {
          const noteId = await openNoteByTitle(s, "Field notes from the beta");
          await pageSeatInvoke(s, "plugin:notes|note_snapshot_flush", { noteId }, 15000);
          await runPaletteAction(s, "snapshots.open", "snap");
          await s.byTestId("snapshots.panel", { timeoutMs: 8000 });
          await (await s.byTestId("snapshots.row", { timeoutMs: 8000 })).click();
          await s.byTestId("snapshots.preview", { timeoutMs: 8000 });
          await settle(s, 500);
        },
      );
      await safe("close snapshots panel", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone(testIdSelector("snapshots.panel"));
      });

      // =====================================================================
      // SIDEBAR / NOTES-ORGANIZATION FRAMES
      // =====================================================================

      // ---- Frame: customized sidebar (folders + loose notes + trash footer) ----
      await frame(
        s,
        "customized-sidebar",
        "notes-and-organization/sidebar-customization",
        "The note sidebar showing folders, loose notes, and the Trash footer.",
        async () => {
          await s.byTestId("editor.root");
        },
      );

      // ---- Frame: notes and folders (the sidebar tree) ----
      await frame(
        s,
        "notes-and-folders",
        "notes-and-organization/notes-and-folders",
        "The sidebar with notes organized into folders alongside loose top-level notes.",
        async () => {
          await pressKey(s, ESCAPE);
          await openNoteByTitle(s, "Start here");
          await s.byTestId("editor.root");
          await settle(s, 400);
        },
      );

      // ---- Frame: daily notes (today's dated note opened from the palette) ----
      // daily.open-today is an idempotent open-or-create in the Daily/ folder.
      await frame(
        s,
        "daily-notes",
        "notes-and-organization/periodic-notes",
        "Today's dated note, opened from the command palette and filed in the Daily folder.",
        async () => {
          await runPaletteAction(s, "daily.open-today", "today");
          await s.byTestId("editor.root");
          await settle(s, 800);
        },
      );

      // ---- Frame: favorites (a note starred into the Favorites section) ----
      // Favoriting is the note-row context item favorite; the Favorites section
      // renders above the tree when non-empty (the note then appears twice).
      await frame(
        s,
        "favorites",
        "notes-and-organization/favorites",
        "A note starred into the Favorites section pinned at the top of the sidebar.",
        async () => {
          await createNote(s, "Favorite sample");
          await rowContextAction(s, "Favorite sample", "favorite");
          await s.waitUntil(
            async () => {
              let n = 0;
              for (const r of await s.byTestIdAll("notes.row"))
                if ((await r.textContent()).includes("Favorite sample")) n++;
              return n >= 2 ? true : null;
            },
            { label: "note shown in Favorites + tree", timeoutMs: 8000 },
          );
          await settle(s, 400);
        },
      );
      // Un-favourite so the sidebar returns to its plain shape for later frames.
      await safe("un-favourite", () => rowContextAction(s, "Favorite sample", "favorite"));

      // ---- Frame: note colours (the colour/icon decoration popover) ----
      // NoteList.tsx menuItems id "color" opens the DecorationPopover
      // (notes.decoration-popover) — a flat anchored menu with the colour
      // swatch row. Dismissed with Escape so it does not block later frames.
      await frame(
        s,
        "note-colors",
        "notes-and-organization/note-colors-and-icons",
        "The colour picker opened from a note's context menu, showing the palette of colour swatches.",
        async () => {
          await createNote(s, "Color sample");
          await rowContextAction(s, "Color sample", "color");
          await s.byTestId("notes.decoration-popover", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      await safe("close colour popover", () => pressKey(s, ESCAPE));

      // ---- Frame: templates (the Manage templates tab) ----
      // `templates.manage` opens the template library as a TAB BODY, not a
      // modal (myne-md/myne#779, `decisions/ui/0633`): the title and the close
      // affordance come from the tab strip, so the `aria-labelledby` modal
      // attribute this frame used to wait for no longer exists anywhere in the
      // tree. Gate on the body's own testid. The capture vault has no templates,
      // so the first-run empty state shows.
      await frame(
        s,
        "templates",
        "notes-and-organization/templates",
        "The template library, where note templates are created, renamed, and removed.",
        async () => {
          await runPaletteAction(s, "templates.manage", "template");
          await s.byTestId("templates.pane", { timeoutMs: 8000 });
          await settle(s, 500);
        },
      );
      // The library is a tab now, so Escape does nothing: close it through the
      // palette action and land back on a note, or the tab strip carries a
      // stray "Templates" tab through every later frame.
      await safe("close templates tab", async () => {
        await runPaletteAction(s, "tab.close", "close tab");
        await openNoteByTitle(s, "Field notes from the beta");
      });

      // ---- Frame: trash (a soft-deleted note in the Trash panel) ----
      // notes.e2e.ts nc3: context delete soft-trashes (no confirm); the ribbon's
      // `trash.open` button opens trash.panel (myne-md/myne#762 replaced the
      // sidebar footer row with it). Use a throwaway so later frames keep their
      // notes.
      await frame(
        s,
        "trash",
        "notes-and-organization/trash",
        "The Trash panel listing a soft-deleted note with its restore and delete-forever actions.",
        async () => {
          await createNote(s, "Old draft");
          await rowContextAction(s, "Old draft", "delete");
          await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
          await s.byTestId("trash.restore", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );
      await safe("close trash panel", async () => {
        await (await s.byTestId("trash.close")).click();
        await s.waitForGone(testIdSelector("trash.panel"));
      });
      await safe("dismiss trash toast before archive capture", async () => {
        // The toaster keeps the whole stack in the DOM, with older rows hidden
        // behind the newest one. Dismiss from the front until the trash toast
        // and any older fixture toasts have all left the viewport.
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const dismissButtons = await s.byTestIdAll("editor.toast-dismiss");
          if (dismissButtons.length === 0) return;
          await dismissButtons[dismissButtons.length - 1].click();
          await sleep(220);
        }
        if ((await s.byTestIdAll("editor.toast-dismiss")).length > 0) {
          throw new Error("toast stack did not clear before the archive frame");
        }
      });

      // ---- Frame: archive (a note kept out of the working set) ----
      // archive.e2e.ts ar1: context archive removes from the tree; the ribbon's
      // `archive.open` button opens archive.panel. Throwaway note (safe anywhere).
      await frame(
        s,
        "archive",
        "notes-and-organization/archive",
        "The Archive panel listing a note kept out of the working set, with restore and delete actions.",
        async () => {
          await createNote(s, "Archived draft");
          await rowContextAction(s, "Archived draft", "archive");
          await clickRibbonUntilVisible(s, "archive.open", "archive.panel");
          await s.byTestId("archive.restore", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );
      await safe("close archive panel", async () => {
        await (await s.byTestId("archive.close")).click();
        await s.waitForGone(testIdSelector("archive.panel"));
      });

      // ---- Frame: folder notes (a folder's "Open folder note" affordance) ----
      // MYND-370: the folder note is hidden from the tree and reached from the
      // folder row (double-click / the inline "Open folder note" button). The
      // affordance is created in setup above (best-effort).
      await frame(
        s,
        "folder-notes",
        "notes-and-organization/folder-notes",
        "A folder row in the sidebar with its Open folder note button, which opens the folder's hidden index note.",
        async () => {
          // Hover the folder row first: when the index note IS set the "Open
          // folder note" affordance is unconditional, but when the set-index
          // setup didn't take, the "Create folder note" affordance is
          // hover-gated (FolderRow.tsx) — hovering surfaces it either way.
          await (await s.byTestId("notes.folder-row")).hover();
          await s.byTestId("notes.folder-index-affordance", { timeoutMs: 8000 });
        },
      );

      // ---- Frame: bulk note actions (multi-selected rows + context menu) ----
      // Use stable note ids and re-find each row: the sidebar replaces row DOM
      // nodes as title saves and selection state settle.
      await frame(
        s,
        "bulk-note-actions",
        "notes-and-organization/bulk-note-actions",
        "Several note rows selected together in the sidebar with the bulk-actions context menu open.",
        async () => {
          await createNote(s, "Bulk alpha");
          const firstId = capturedNoteIds.get("Bulk alpha");
          await createNote(s, "Bulk beta");
          const secondId = capturedNoteIds.get("Bulk beta");
          if (!firstId || !secondId) throw new Error("bulk-action sample note ids were not recorded");
          await clickNoteRow(s, firstId);
          const secondRow = await s.waitForElement(
            testIdSelector("notes.row", { "data-note-id": secondId }),
          );
          await secondRow.modifierClick(CTRL);
          await s.waitUntil(
            async () =>
              (await s.findElements(
                testIdSelector("notes.row", { "data-multiselected": "true" }),
              )).length >= 2 || null,
            { label: "two rows multi-selected", timeoutMs: 8000 },
          );
          await rightClickBySelector(
            s,
            testIdSelector("notes.row", { "data-note-id": secondId }),
          );
          await s.waitForElement(testIdSelector("notes.context-menu-item"), { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      // Dismiss the context menu and clear the multi-selection.
      await safe("clear bulk selection", async () => {
        await pressKey(s, ESCAPE);
        await openNoteByTitle(s, "Start here");
      });

      // ---- Frame: pinned and stacked tabs (a pinned tab + multiple tabs) ----
      // Use the rows' context-menu Open in new tab action, then the tab's own
      // context menu to pin it.
      //
      // The pin targets the FIRST TAB IN THE STRIP rather than the "Field notes from the beta"
      // tab by id. `createNote` reuses the focused pane's active tab, so by the
      // time the two "Tab …" notes exist the tab has already been
      // replaced and a lookup by its id can only time out. That is what this
      // frame shipped with: the article is about pinned tabs and the screenshot
      // had none, while every gate in the frame passed.
      await frame(
        s,
        "pinned-and-stacked-tabs",
        "notes-and-organization/pinned-and-stacked-tabs",
        "The editor tab strip with several note tabs open and one tab pinned.",
        async () => {
          await openNoteByTitle(s, "Field notes from the beta");
          await safe("open extra tabs from row menus", async () => {
            await createNote(s, "Tab reading");
            const readingId = capturedNoteIds.get("Tab reading");
            await createNote(s, "Tab weekly");
            const weeklyId = capturedNoteIds.get("Tab weekly");
            if (!readingId || !weeklyId) throw new Error("tab sample note ids were not recorded");
            await rowMenuPick(s, readingId, "open-in-new-tab");
            await rowMenuPick(s, weeklyId, "open-in-new-tab");
          });
          await s.byTestId("editor.tab-strip", { timeoutMs: 8000 });
          // NOT best-effort any more: a strip with no pin is the wrong picture
          // for this article, so the frame fails loudly instead of shipping it.
          await s.waitUntil(
            async () => ((await s.byTestIdAll("editor.tab")).length >= 2 ? true : null),
            { label: "two note tabs in the strip", timeoutMs: 10_000 },
          );
          const stripTabs = await s.byTestIdAll("editor.tab");
          const firstTabId = await stripTabs[0].attribute("data-tab-id");
          if (!firstTabId) throw new Error("first tab carries no data-tab-id");
          await rightClickBySelector(
            s,
            testIdSelector("editor.tab", { "data-tab-id": firstTabId }),
          );
          await (
            await s.waitForElement(
              testIdSelector("notes.context-menu-item", { "data-item-id": "tab.pin" }),
              { timeoutMs: 6000 },
            )
          ).click();
          await pressKey(s, ESCAPE); // the tab context menu, so the strip is clean
          await settle(s, 500);
        },
      );

      // ---- Frame: named workspaces (the switcher menu open) ----
      // named-workspaces.e2e.ts: click editor.workspace-switcher.toggle →
      // editor.workspace-switcher.menu.
      await frame(
        s,
        "named-workspaces",
        "notes-and-organization/named-workspaces",
        "The named-workspaces switcher menu open, listing the saved workspace layouts.",
        async () => {
          await (await s.byTestId("editor.workspace-switcher.toggle")).click();
          await s.byTestId("editor.workspace-switcher.menu", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );
      // Close the switcher menu.
      await safe("close workspace switcher", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone(testIdSelector("editor.workspace-switcher.menu"));
      });

      // ---- Frame: tabs and split view (two panes side by side) ----
      // Open a freshly-created row to the side through its context menu, then
      // confirm two editor.pane elements. Done AFTER single-pane frames.
      await frame(
        s,
        "tabs-and-split-view",
        "notes-and-organization/tabs-and-split-view",
        "Two notes open side by side in a split editor, each in its own pane.",
        async () => {
          await createNote(s, "Split target");
          const splitTargetId = capturedNoteIds.get("Split target");
          if (!splitTargetId) throw new Error("split target note id was not recorded");
          await openNoteByTitle(s, "Field notes from the beta");
          await rowMenuPick(s, splitTargetId, "open-to-side");
          await s.waitUntil(
            async () => ((await s.byTestIdAll("editor.pane")).length >= 2 ? true : null),
            { label: "two editor panes after split", timeoutMs: 10000 },
          );
          await settle(s, 600);
        },
      );
      // Back to ONE pane. Without this the split survives into every later frame
      // and the guide ends up showing it as the layout: the voice-notes frame
      // shipped with the attachments library open beside the editor and the note
      // squeezed into a third of the window, and every settings screenshot had a
      // two-pane tab strip across the top. Closing the focused pane is the user's
      // own route (`tab`/pane close), and the guard above proved there are two.
      await safe("close the split pane", async () => {
        await runPaletteAction(s, "pane.close", "close pane");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("editor.pane")).length <= 1 ? true : null),
          { label: "back to a single editor pane", timeoutMs: 10_000 },
        );
        await openNoteByTitle(s, "Start here");
      });

      // =====================================================================
      // FIND-AND-CONNECT FRAMES
      // =====================================================================

      // ---- Frame: backlinks (the right-sidebar backlinks for "Field notes from the beta") ----
      // search-palette.e2e.ts: backlink rows are editor.backlink-row.
      // Open in a single pane first so the layout is clean.
      await frame(
        s,
        "backlinks",
        "find-and-connect/backlinks",
        "A note's backlinks panel listing the other notes that link to it.",
        async () => {
          await openNoteByTitle(s, "Field notes from the beta");
          await s.byTestId("editor.backlink-row", { timeoutMs: 10000 });
          await settle(s, 500);
        },
      );

      // ---- Frame: outline (the right-panel Outline tab) ----
      // right-panel tabs (right-panel-tabs): each tab button carries
      // data-panel-tab-id; the outline body rows are editor.outline-row.
      await frame(
        s,
        "outline",
        "find-and-connect/outline",
        "The Outline tab in the right panel, listing a note's headings so you can jump to any section.",
        async () => {
          await openNoteByTitle(s, "Onboarding call");
          await settle(s, 400);
          await (
            await s.waitForElement(
              testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "outline" }),
              { timeoutMs: 8000 },
            )
          ).click();
          await s.byTestId("editor.outline-row", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: unlinked mentions (the right-panel Unlinked tab) ----
      // Same right-panel-tab idiom as outline (tab id "unlinked"). Open "Field notes from the beta",
      // which "Standup, Tuesday" names in plain text (an unlinked mention). Rows
      // carry no testid, so gate on the tab + a settle (best-effort).
      await frame(
        s,
        "unlinked-mentions",
        "find-and-connect/unlinked-mentions",
        "The Unlinked mentions tab listing other notes that name this note without linking it.",
        async () => {
          await openNoteByTitle(s, "Field notes from the beta");
          await settle(s, 400);
          await (
            await s.waitForElement(
              testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "unlinked" }),
              { timeoutMs: 8000 },
            )
          ).click();
          await settle(s, 1800); // async recall + decrypt-verify; no row testid to gate on
        },
      );

      // ---- Frame: search (command palette with a query + results) ----
      // search-palette.e2e.ts: Ctrl+K → palette.input → type → palette.option.
      await frame(
        s,
        "search",
        "find-and-connect/search",
        "The command palette open with a search term entered and matching note results listed.",
        async () => {
          await ctrlChord(s, "k");
          await (await s.byTestId("palette.input", { timeoutMs: 10000 })).sendKeys("field");
          await s.byTestId("palette.option", { timeoutMs: 8000 });
          await settle(s, 500);
        },
      );
      // Close the palette.
      await safe("close search palette", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone(testIdSelector("palette.input"));
      });

      // ---- Frame: tags (the tag browser) ----
      // tag-browser.e2e.ts: click editor.tags-cta → tags.modal.
      await frame(
        s,
        "tags",
        "find-and-connect/tags",
        "The tag browser open, listing the tags used across the vault.",
        async () => {
          await (await s.byTestId("editor.tags-cta")).click();
          await s.byTestId("tags.modal", { timeoutMs: 8000 });
          await settle(s, 500);
        },
      );
      // Close the tag browser.
      await safe("close tag browser", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone(testIdSelector("tags.modal"));
      });

      // ---- Frame: saved views (a saved view rendered as cards) ----
      // saved-views-cards.e2e.ts / saved-views-entry.e2e.ts: views.new-button
      // opens a new view as a tab (editor.view-host); the cards surface is
      // view.cards with view.card children (or view.empty when no notes match).
      await frame(
        s,
        "saved-views",
        "editor-and-writing/saved-views",
        "The saved-view builder, where conditions filter and group which notes a view shows.",
        async () => {
          await setViewsEnabled(s, true);
          // The + now lives in the flyout header rather than on a sidebar nav
          // row (myne-md/myne#762), so the flyout has to be open to reach it.
          await clickRibbonUntilVisible(s, "views.show", "views.flyout");
          await clickUntilVisible(s, "views.new-button", "view-filter.modal");
          // The "New view" builder dialog IS the saved-views illustration —
          // rendering a saved view would require saving it first. Capture the
          // dialog, then dismiss it below so it never blocks later frames.
          await settle(s, 900);
        },
      );
      // CRITICAL cleanup: the New view dialog is a modal overlay. If left open
      // it intercepts every later click (settings, graph). Dismiss it.
      await safe("close new-view dialog", () => pressKey(s, ESCAPE));

      // ---- Frame: multiple vaults (the account-chip vault switcher menu) ----
      // VaultSwitcher: switcher.chip opens a menu with switcher.vault-row(s) +
      // switcher.create-cta. The capture seeds one vault, so the menu shows one
      // row + "Create another vault" — demonstrates the switcher mechanism.
      await frame(
        s,
        "multiple-vaults",
        "safety-and-recovery/multiple-vaults",
        "The vault switcher menu open from the sidebar, listing your vaults with an option to create or switch to another.",
        async () => {
          await openNoteByTitle(s, "Start here");
          await (await s.byTestId("switcher.chip")).click();
          await s.byTestId("switcher.vault-row", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      await safe("close switcher menu", () => pressKey(s, ESCAPE));

      // =====================================================================
      // ALL SETTINGS FRAMES inside ONE modal open (account → privacy →
      // editor → hotkeys → appearance → storage). flows.ts/prefs.e2e.ts:
      // editor.settings-cta opens settings.modal; tabs are settings.tab-<id>.
      // =====================================================================
      // Belt-and-suspenders: dismiss any lingering overlay so the settings
      // modal opens cleanly and its tab rail isn't behind another modal.
      await safe("dismiss overlays before settings", async () => {
        await pressKey(s, ESCAPE);
        await pressKey(s, ESCAPE);
        await settle(s, 300);
      });
      await safe("open settings modal", async () => {
        await (await s.byTestId("editor.settings-cta")).click();
        await s.byTestId("settings.modal", { timeoutMs: 8000 });
      });

      // ---- Frame: privacy (auto-lock + screen-capture) ----
      // The panel is split into TOPICS since myne-md/myne#885 and only the
      // active topic's body mounts, so the auto-lock row lives under `locking`
      // rather than directly under `settings.tab-privacy`. Clicking the rail tab
      // alone lands on that panel's default topic and finds nothing.
      await frame(
        s,
        "settings-privacy",
        "settings-and-privacy/auto-lock-and-screen-capture",
        "The Privacy settings panel showing the auto-lock duration and screen-capture protection toggle.",
        async () => {
          await (await s.byTestId("settings.tab-privacy")).click();
          await selectSettingsTopic(s, "privacy", "locking");
          await s.byTestId("settings.auto-lock-select", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: quick unlock (the Privacy panel's Quick unlock block) ----
      // QuickUnlockSettings sits in the same Privacy `locking` topic as the
      // auto-lock row above (myne-md/myne#885), so the topic is re-selected
      // rather than assumed: a rail-tab click alone re-renders that panel's
      // default topic and the block is gone.
      await frame(
        s,
        "quick-unlock",
        "settings-and-privacy/quick-unlock",
        "The Quick unlock section of the Privacy settings, where a device PIN can be set up.",
        async () => {
          await (await s.byTestId("settings.tab-privacy")).click();
          await selectSettingsTopic(s, "privacy", "locking");
          const block = await s.byTestId("settings.quick-unlock", { timeoutMs: 6000 });
          // Scroll the block into view so it is centred in the frame.
          await safe("scroll quick-unlock into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("settings.quick-unlock")],
            );
          });
          void block;
          await settle(s, 400);
        },
      );

      // ---- Frame: editor display (the Editor settings panel) ----
      // TypographySettings lives in the Editor panel's `text` topic
      // (myne-md/myne#885), which is not the one a rail-tab click lands on.
      await frame(
        s,
        "editor-display",
        "editor-and-writing/editor-display",
        "The Editor settings panel with the text-size and display options.",
        async () => {
          await (await s.byTestId("settings.tab-editor")).click();
          await selectSettingsTopic(s, "editor", "text");
          await s.byTestId("settings.editor-text-size", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: vim mode (the Editor panel's Vim mode toggle) ----
      // VimModeSettings.tsx: settings.tab-editor → settings.vim-mode (a Switch,
      // off by default). Since #181 the row only renders while Developer mode
      // is on, so the frame turns that on first — which is also what the guide
      // has to tell the reader, hence the caption. Settings is already open at
      // this point in the walk, so this uses the rail-only variant rather than
      // the one that goes through the gear. Deliberately NOT turned back off
      // afterwards: the frames that follow (hotkeys, appearance, …) are
      // unaffected by it, and re-hiding would only add a rail round-trip.
      await frame(
        s,
        "vim-mode",
        "editor-and-writing/vim-mode",
        "The Editor settings panel scrolled to the Vim mode toggle, which is off by default and appears once Developer mode is on.",
        async () => {
          await enableDeveloperModeInSettings(s);
          await (await s.byTestId("settings.tab-editor")).click();
          // The vim toggle lives in the Editor panel's `editing` topic since
          // myne-md/myne#885; only the active topic's body is mounted.
          await selectSettingsTopic(s, "editor", "editing");
          const block = await s.byTestId("settings.vim-mode", { timeoutMs: 6000 });
          await safe("scroll vim-mode into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("settings.vim-mode")],
            );
          });
          void block;
          await settle(s, 400);
        },
      );

      // ---- Frame: dates and times (the Editor panel's format rows) ----
      // DateTimeSettings lives in the Editor panel's `editing` topic, the same
      // one `vim-mode` just left selected, but the topic is re-selected rather
      // than assumed: a rail-tab click re-renders the panel's default topic.
      await frame(
        s,
        "dates-and-times",
        "settings-and-privacy/dates-and-times",
        "The Editor settings panel showing the date format, time format and time zone rows.",
        async () => {
          await (await s.byTestId("settings.tab-editor")).click();
          await selectSettingsTopic(s, "editor", "editing");
          const row = await s.byTestId("settings.date-format", { timeoutMs: 6000 });
          await safe("scroll date-format into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("settings.date-format")],
            );
          });
          void row;
          await settle(s, 400);
        },
      );

      // ---- Frame: custom hotkeys (the Hotkeys panel) ----
      // hotkeys.e2e.ts: settings.tab-hotkeys → hotkeys.panel.
      await frame(
        s,
        "custom-hotkeys",
        "settings-and-privacy/custom-hotkeys",
        "The Hotkeys settings panel listing commands and their keyboard shortcuts.",
        async () => {
          await (await s.byTestId("settings.tab-hotkeys")).click();
          await s.byTestId("hotkeys.panel", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: appearance (the Appearance panel) ----
      // custom-themes.e2e.ts / prefs.e2e.ts: settings.tab-appearance.
      await frame(
        s,
        "appearance",
        "settings-and-privacy/appearance",
        "The Appearance settings panel with the theme options.",
        async () => {
          await (await s.byTestId("settings.tab-appearance")).click();
          await settle(s, 600);
        },
      );

      // ---- Frame: backup (the Storage panel's backup controls) ----
      // scheduled-backup.e2e.ts / backup-restore.e2e.ts: settings.tab-storage
      // → settings.backup-vault.
      await frame(
        s,
        "backup",
        "safety-and-recovery/back-up-your-vault",
        "The Storage settings panel showing the back-up controls for the vault.",
        async () => {
          await (await s.byTestId("settings.tab-storage")).click();
          await s.byTestId("settings.backup-vault", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: sync settings (the Sync panel) ----
      // SettingsModal PANELS: `sync` → settings.tab-sync; SyncPanel renders
      // settings.sync-panel (endpoint config + device management).
      await frame(
        s,
        "sync-settings",
        "sync-and-devices/turn-on-sync",
        "The Sync settings panel, where a sync server is configured and this device's sync is turned on.",
        async () => {
          await (await s.byTestId("settings.tab-sync")).click();
          await s.byTestId("settings.sync-panel", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: sync status (the local-only / Sync off indicator) ----
      // The capture vault has no endpoint → sync_status = disabled ("Sync off").
      // Scope the scroll to the panel — sync.status-indicator also lives in the
      // bottom bar, so an unscoped query would hit the wrong one.
      await frame(
        s,
        "sync-status",
        "sync-and-devices/sync-status",
        "The Sync status row in Sync settings, showing this device is local-only with sync turned off.",
        async () => {
          await (await s.byTestId("settings.tab-sync")).click();
          await s.byTestId("settings.sync-panel", { timeoutMs: 6000 });
          await safe("scroll sync status into view", async () => {
            await s.execute(
              "var el=document.querySelector(arguments[0]); if (el) el.scrollIntoView({ block: 'center' });",
              [`${testIdSelector("settings.sync-panel")} ${testIdSelector("sync.status-indicator")}`],
            );
          });
          await settle(s, 400);
        },
      );

      // ---- Frame: add a device (the enroll form, best-effort empty state) ----
      // The form lives in the Sync panel's `devices` topic (myne-md/myne#885),
      // and the beta-terms consent stands in its place until accepted
      // (operations#15): the gate REPLACES the form rather than covering it, so
      // the form is simply not rendered on a vault that has never answered. A
      // real user reads and accepts; the frame does the same.
      await frame(
        s,
        "add-a-device",
        "sync-and-devices/add-a-device",
        "The Add a device form in Sync settings, where you sign a new device in to your account.",
        async () => {
          await (await s.byTestId("settings.tab-sync")).click();
          await s.byTestId("settings.sync-panel", { timeoutMs: 6000 });
          await selectSettingsTopic(s, "sync", "devices");
          await safe("accept the sync beta terms", async () => {
            const gate = await s.findElements(testIdSelector("sync.beta-terms.open"));
            if (gate.length === 0) return;
            await gate[0].click();
            await (await s.byTestId("sync.beta-terms.accept", { timeoutMs: 6000 })).click();
          });
          const enroll = await s.byTestId("sync.enroll", { timeoutMs: 8000 });
          await safe("scroll enroll into view", async () => {
            await s.execute(
              "var el=document.querySelector(arguments[0]); if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("sync.enroll")],
            );
          });
          void enroll;
          await settle(s, 400);
        },
      );

      // ---- Frame: managing devices (the device list, empty until sync is set up) ----
      await frame(
        s,
        "managing-devices",
        "sync-and-devices/managing-devices",
        "The Devices section of Sync settings, which lists the devices on your account.",
        async () => {
          await (await s.byTestId("settings.tab-sync")).click();
          await s.byTestId("settings.sync-panel", { timeoutMs: 6000 });
          await safe("scroll device management into view", async () => {
            await s.execute(
              "var el=document.querySelector(arguments[0]); if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("sync.device-management")],
            );
          });
          await settle(s, 400);
        },
      );

      // ---- Frame: files settings (the Files panel) ----
      await frame(
        s,
        "files-settings",
        "settings-and-privacy/files",
        "The Files settings panel, with the default file to open on startup and where new notes are created.",
        async () => {
          await (await s.byTestId("settings.tab-files")).click();
          await s.byTestId("settings.files-panel", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: AI settings (the AI panel, off by default) ----
      // `ai` sits in the Developer group (developer-mode feature, MYND-593), so
      // the rail tab only renders once Developer mode is on. The `vim-mode`
      // frame above has already turned it on, which is why this frame can reach
      // it; nothing here re-toggles the mode.
      await frame(
        s,
        "ai-settings",
        "ai/turning-on-ai",
        "The AI (Beta) settings panel with the enable-local-AI toggle, the model pickers, and the on-device trust disclosure.",
        async () => {
          await (await s.byTestId("settings.tab-ai")).click();
          await s.byTestId("settings.ai-panel", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: Tor routing (the Network panel) ----
      // Developer group, like the AI panel above, hence after `vim-mode`. The
      // panel has its own root testid, so the gate is the panel itself.
      await frame(
        s,
        "network-tor",
        "settings-and-privacy/route-sync-through-tor",
        "The Network settings panel with the Tor routing toggle, which sends sync traffic through Tor when it is on.",
        async () => {
          await (await s.byTestId("settings.tab-network")).click();
          await s.byTestId("settings.network-panel", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: terminal access (the CLI panel) ----
      await frame(
        s,
        "cli-access",
        "command-line/the-myne-cli",
        "The CLI settings panel, where terminal access to the unlocked vault is switched on and its scope is limited.",
        async () => {
          await (await s.byTestId("settings.tab-cli")).click();
          const access = await s.byTestId("settings.cli-access", { timeoutMs: 6000 });
          await safe("scroll cli-access into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("settings.cli-access")],
            );
          });
          void access;
          await settle(s, 400);
        },
      );

      // ---- Frame: app updates (the About panel's update block) ----
      // Three frames share the About panel and each scrolls its own subject
      // into view, because the panel's body overflows the modal: the update
      // channel + check, the Developer-mode switch, and the diagnostic log.
      await frame(
        s,
        "updates",
        "settings-and-privacy/updates",
        "The About settings panel scrolled to the update channel, the manual check button and the automatic update check.",
        async () => {
          await (await s.byTestId("settings.tab-about")).click();
          const channel = await s.byTestId("about.update-channel", { timeoutMs: 6000 });
          await safe("scroll updates into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("about.update-channel")],
            );
          });
          void channel;
          await settle(s, 400);
        },
      );

      // ---- Frame: Developer mode (the About panel's switch) ----
      await frame(
        s,
        "developer-mode",
        "settings-and-privacy/developer-mode",
        "The About settings panel scrolled to the Developer mode switch, which reveals the AI, Network and CLI panels.",
        async () => {
          await (await s.byTestId("settings.tab-about")).click();
          const row = await s.byTestId("about.developer-mode", { timeoutMs: 6000 });
          await safe("scroll developer-mode into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("about.developer-mode")],
            );
          });
          void row;
          await settle(s, 400);
        },
      );

      // ---- Frame: diagnostic logging (the About panel's diagnostics block) ----
      await frame(
        s,
        "diagnostic-logging",
        "settings-and-privacy/diagnostic-logging",
        "The About settings panel scrolled to the diagnostic log switch and the copyable diagnostics report.",
        async () => {
          await (await s.byTestId("settings.tab-about")).click();
          const logRow = await s.byTestId("about.diagnostic-log-row", { timeoutMs: 6000 });
          await safe("scroll diagnostics into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("about.diagnostic-log-row")],
            );
          });
          void logRow;
          await settle(s, 400);
        },
      );

      // ---- Frame: language (the Appearance panel's language selector) ----
      await frame(
        s,
        "language-settings",
        "settings-and-privacy/language",
        "The interface-language selector at the top of the Appearance settings panel.",
        async () => {
          await (await s.byTestId("settings.tab-appearance")).click();
          const sel = await s.byTestId("settings.language-select", { timeoutMs: 6000 });
          await safe("scroll language-select into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("settings.language-select")],
            );
          });
          void sel;
          await settle(s, 400);
        },
      );

      // ---- Frame: account (the account number, grouping, extensions) ----
      // The Account panel is the account grouping (`decisions/ui/0679`): the
      // person account number that now opens it (`decisions/ui/0728`, where the
      // account name used to be), the vaults it groups on this device, and the
      // extension pairing block the connected-extensions frame below covers in
      // detail.
      await frame(
        s,
        "account-panel",
        "settings-and-privacy/account",
        "The Account settings panel showing the account number, the vaults grouped under it, and the browser-extension pairing controls.",
        async () => {
          await (await s.byTestId("settings.tab-account")).click();
          await s.byTestId("settings.account-panel", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: vault (label + icon + actions) ----
      // The controls captured here moved out of the Account panel into the
      // Vault panel, and the website now carries a `vault` article of its own,
      // so the frame name and the slug below follow it.
      await frame(
        s,
        "vault-panel",
        "settings-and-privacy/vault",
        "The Vault settings panel showing the vault label and icon, and the change-password and delete-vault actions.",
        async () => {
          await (await s.byTestId("settings.tab-vault")).click();
          await s.byTestId("settings.icon-picker", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: connected extensions (browser-clipper pairings) ----
      // Lives in the Browser extensions panel since myne-md/myne#960, where the
      // clipper left Account; the capture vault has none paired, so the empty
      // state (settings.connected-extensions-empty) shows.
      await frame(
        s,
        "connected-extensions",
        "attachments-and-import/browser-clipper",
        "The Connected extensions section of the Browser extensions settings, where browsers paired with the clipper are listed and can be revoked.",
        async () => {
          await (await s.byTestId("settings.tab-extensions")).click();
          const ext = await s.byTestId("settings.connected-extensions", { timeoutMs: 6000 });
          await safe("scroll connected-extensions into view", async () => {
            await s.execute(
              "var el = document.querySelector(arguments[0]);" +
                "if (el) el.scrollIntoView({ block: 'center' });",
              [testIdSelector("settings.connected-extensions")],
            );
          });
          void ext;
          await settle(s, 500);
        },
      );

      // ---- Frame: change password (the Change password form, Vault panel) ----
      // VaultPanel: settings.change-password-cta reveals PasswordChangeForm
      // (change-password.submit). Cancel back to idle — never submit.
      await frame(
        s,
        "change-password",
        "settings-and-privacy/change-your-password",
        "The Change password form in Vault settings, with fields for the current password, the new password, and confirmation.",
        async () => {
          await (await s.byTestId("settings.tab-vault")).click();
          await (await s.byTestId("settings.change-password-cta")).click();
          await s.byTestId("change-password.submit", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      await safe("cancel change-password", async () => {
        await (await s.byTestId("change-password.cancel")).click();
      });

      // ---- Frame: delete a vault (the confirm form, Vault panel) ----
      // VaultPanel's danger topic carries `delete-vault.confirm-input` directly
      // since myne-md/myne#1020 (the reveal CTA it used to sit behind is gone).
      // Submit stays gated on the typed phrase, so capturing the empty form and
      // leaving the panel never deletes anything.
      await frame(
        s,
        "delete-a-vault",
        "settings-and-privacy/delete-a-vault",
        "The delete-vault confirmation form in Vault settings, which requires typing a confirmation phrase before the vault is erased.",
        async () => {
          await (await s.byTestId("settings.tab-vault")).click();
          // The erase is the Vault panel's `danger` topic (myne-md/myne#885).
          await (await s.byTestId("settings.vault-tab-danger")).click();
          await s.byTestId("delete-vault.confirm-input", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      // There is nothing to cancel: the field is part of the section rather than
      // a view that was opened, and the frame's own teardown is `closeSettings`.
      await safe("close settings", () => closeSettings(s));

      // =====================================================================
      // ATTACHMENTS
      // =====================================================================

      // ---- Frame: attachments library ----
      // attachments-library.e2e.ts: runPaletteAction("attachments.open"). The
      // capture vault has no imported attachments, so the empty state shows —
      // wait for either a tile or the surface settling. The center view swaps
      // away from the editor pane tree.
      await frame(
        s,
        "attachments-library",
        "attachments-and-import/attachments-library",
        "The attachments library, the central place where files added to the vault are listed.",
        async () => {
          await runPaletteAction(s, "attachments.open", "attach");
          // Either a populated tile or the empty-state surface confirms it
          // mounted; settle covers the thumbnail/empty-state render.
          await clickFirst(s, [testIdSelector("attachments.tile")], 3000).catch(() => {});
          await settle(s, 1200);
        },
      );
      // Leave the attachments library by reopening a note from the sidebar.
      await safe("leave attachments library", async () => {
        await openNoteByTitle(s, "Start here");
      });

      // ---- Frame: voice notes (the recording bar) ----
      // voice-notes.e2e.ts / slash/commands.ts: the "/record" slash command
      // (label "Voice note") arms startVoiceRecording, which mounts
      // voice-record-bar. A headless mic may surface a silence warning, but
      // the bar still mounts.
      await frame(
        s,
        "voice-notes",
        "attachments-and-import/voice-notes",
        "The voice-note recording bar shown while a voice note is being recorded into the editor.",
        async () => {
          await openNoteByTitle(s, "Friday log");
          await settle(s, 400);
          // Wait for the menu to open + filter to the Voice note command BEFORE
          // committing, else Enter fires on an unrendered/unfiltered menu.
          await typeSlashCommand(s, "/record");
          await settle(s, 300);
          // Commit the slash menu's top match (Enter) to fire the command.
          await (await s.waitForElement(CM_CONTENT)).sendKeys(ENTER);
          await s.waitForElement(testIdSelector("voice-record-bar"), { timeoutMs: 8000 });
          await settle(s, 600);
        },
      );
      // Cancel/stop the recording so the bar unmounts.
      await safe("cancel voice recording", async () => {
        await clickFirst(
          s,
          [testIdSelector("voice-record.cancel"), testIdSelector("voice-record.stop")],
          4000,
        );
        await s.waitForGone(testIdSelector("voice-record-bar"));
      });

      // =====================================================================
      // GRAPH — LAST (it occupies a workspace tab over the editor; nothing
      // runs after it but the manifest write + teardown).
      // =====================================================================
      // graph-tab.e2e.ts: the palette's `graph.show` opens the graph as a tab;
      // the body is editor.graph-pane. (The BottomBar launcher is gone,
      // myne-md/myne#727.)
      await frame(
        s,
        "graph-all",
        "find-and-connect/graph-view",
        "The graph view showing the vault's notes as connected nodes.",
        async () => {
          await pressKey(s, ESCAPE); // dismiss any lingering overlay first
          await runPaletteAction(s, "graph.show", "graph");
          await s.byTestId("editor.graph-pane", { timeoutMs: 12000 });
          await settle(s, 2800); // let the force-directed layout settle
        },
      );

      // =====================================================================
      // RESTORE-FROM-BACKUP — TERMINAL (it dispatches a Stage change that
      // unmounts the editor + settings modal, so nothing after it can touch the
      // editor; only the manifest write follows).
      // =====================================================================
      await frame(
        s,
        "restore-backup",
        "safety-and-recovery/restore-from-a-backup",
        "The Restore from backup screen, where a Myne backup file is chosen to rebuild a vault.",
        async () => {
          await pressKey(s, ESCAPE);
          await (await s.byTestId("editor.settings-cta")).click();
          await s.byTestId("settings.modal", { timeoutMs: 8000 });
          await (await s.byTestId("settings.tab-storage")).click();
          await (await s.byTestId("settings.restore-backup")).click(); // Stage change
          await s.byTestId("restore.root", { timeoutMs: 8000 });
          await settle(s, 500);
        },
      );

      // ---- Manifest ---- (written in `finally` below, not here)
    } finally {
      // Written here, not at the end of the body, because the body can ABORT
      // mid-walk: the pass runs long enough that a single hung wait trips the
      // 900 s test timeout, and when that happened the manifest was never
      // written at all. 32 PNGs then sat in the output directory with no record
      // of which frames they were, which frames were lost, or why. The manifest
      // is the only artefact that answers those questions, so it is the one
      // thing a failed run must still produce.
      writeFileSync(
        join(OUT_DIR, "manifest.json"),
        JSON.stringify(
          {
            generatedBy: "e2e/capture/userguide.capture.ts",
            window:
              process.env.GDK_SCALE === "2"
                ? `2200x1440 (@2x), ${captureTheme} theme`
                : `1100x720 (tauri.conf.json), ${captureTheme} theme`,
            frames,
          },
          null,
          2,
        ),
      );
      const ok = frames.filter((f) => f.ok).length;
      // eslint-disable-next-line no-console
      console.log(`[capture] done — ${ok}/${frames.length} frames captured -> ${OUT_DIR}`);
      await app.teardown();
    }
  },
  // Per-test timeout (this arg overrides .config/vitest/capture.config.ts's testTimeout
  // for THIS test). Keep in sync with the config's testTimeout: 30 min. The
  // pass is a best-effort walk that is SUPPOSED to survive slow frames, so the
  // timeout is not a quality budget — it is the point past which the run is
  // considered hung. 900 s was that point at 1x and stopped being it under load
  // (measured 583 s for a clean 65-frame pass on a busy host), which is how a
  // healthy run got reported as a failure and lost its manifest.
  1_800_000,
);
