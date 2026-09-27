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
  clickNewItem,
  clickRibbonUntilVisible,
  clickUntilVisible,
  closeSettings,
  dismissImporterOffer,
  enableDeveloperModeInSettings,
  openExportSubmenuItem,
  pageSeatInvoke,
  pasteIntoEditor,
  runPaletteAction,
  unlockToEditor,
} from "./../support/flows";
import { testIdSelector, type Element, type Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "userguide");
const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const CM_EDITOR = '[data-testid="editor.content"] .cm-editor';
const ENTER = String.fromCharCode(0xe007); // W3C key: commit inline rename
const ESCAPE = String.fromCharCode(0xe00c); // W3C key: dismiss overlays/menus
const CTRL = String.fromCharCode(0xe009); // W3C modifier (sticky until repeated)
const ALT = String.fromCharCode(0xe00a); // W3C modifier (open-to-side / split)
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
    frames.push({ name, slug, alt, ok: false, note: String(e).slice(0, 200) });
    // eslint-disable-next-line no-console
    console.warn(`[capture] FAIL ${name} — ${String(e).slice(0, 160)}`);
  }
}

/** Create a note via the sidebar CTA and commit `title` (inline rename).
 *  The CTA can no-op when fired while the previous note is mid-autosave,
 *  so settle first and retry the click until the title field appears.
 *
 *  myne#653 moved naming out of the sidebar: creating a note no longer opens
 *  the inline-rename input, it opens the note with its own `title:` field
 *  focused. The retry loop is unchanged and still earns its place, since the
 *  create click itself is what can miss. */
async function createNote(session: Session, title: string): Promise<void> {
  await sleep(500); // let any prior autosave/remount finish
  let field: Element | null = null;
  for (let attempt = 0; attempt < 3 && !field; attempt++) {
    await clickNewItem(session, "notes.create");
    try {
      field = await session.byTestId("editor.frontmatter-title", { timeoutMs: 4000 });
    } catch {
      await sleep(600);
    }
  }
  if (!field) {
    throw new Error("editor.frontmatter-title never appeared after 3 create attempts");
  }
  await field.sendKeys(title + ENTER);
}

/** Create a top-level folder named `name`. Enter commits the name input;
 *  then wait for at least one folder row to materialize. */
async function createFolder(session: Session, name: string): Promise<void> {
  await clickNewItem(session, "notes.new-folder");
  await (await session.byTestId("notes.new-folder-input")).sendKeys(name + ENTER);
  await session.byTestId("notes.folder-row", { timeoutMs: 10000 });
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
  const row = await noteRowByTitle(session, title);
  await row.rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
      { timeoutMs: 6000 },
    )
  ).click();
}

/** Open the sidebar note titled `title` by matching the row textContent.
 *  Note rows share `data-testid="notes.row"`; there is no public
 *  title→id map, so scan the rows' text (the byTestIdAll idiom from
 *  saved-views-entry.e2e.ts `openRowMenu`). Returns the row Element. */
async function openNoteByTitle(session: Session, title: string): Promise<Element> {
  const row = await session.waitUntil(
    async () => {
      for (const r of await session.byTestIdAll("notes.row")) {
        if ((await r.textContent()).includes(title)) return r;
      }
      return null;
    },
    // 20s: the guide vault carries ~20 notes and byTestIdAll scans every row's
    // textContent per poll — under the @2x retina render that occasionally
    // exceeds the old 12s (best-effort frames then flaked "row timed out").
    { label: `notes.row titled "${title}"`, timeoutMs: 20000 },
  );
  await row.click();
  await sleep(500); // let the editor swap to the selected note
  return row;
}

/** The sidebar row Element titled `title` (no click) — for right-click /
 *  modifier-click flows that target a specific row. */
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

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

runner(
  "captures user-guide frames",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    const app = await launchApp({
      // Production KDF: the weak-KDF fixture's m_kib=8 is below the
      // validate_kdf_params 8 MiB floor (protocol, 2026-06-17) and the binary
      // rejects it as corrupt. Production params are valid + honest for a
      // real-looking vault. Slower unlock (~1-2s Argon2), fine for capture.
      seed: (dir) => void (password = seedVault(dir, { kdf: "production" }).password),
    });
    const s = app.session;
    try {
      await unlockToEditor(s, password);
      await dismissImporterOffer(s);

      // ---- Build a realistic, non-sensitive vault through the UI ----
      // All content is English (the guide is English) and mundane (no
      // secrets appear on screen). Each step is best-effort: a finicky
      // affordance degrades richness but never blocks the capture phase.
      // Every note gets a real body so no frame shows an empty pane.
      await safe("folder Projects", () => createFolder(s, "Projects"));
      await safe("folder Research", () => createFolder(s, "Research"));

      await safe("note Roadmap", () =>
        createNoteWithBody(
          s,
          "Roadmap",
          "\nThings we want to ship next:\n\n" +
            "- [ ] Encrypted attachments\n" +
            "- [ ] Full-text search across the vault\n" +
            "- [x] Markdown editor with live preview\n\n" +
            "Tagged #planning #shipping\n\n" +
            "Background reading lives in the [[Reading list]].\n",
        ),
      );
      await safe("note Reading list", () =>
        createNoteWithBody(
          s,
          "Reading list",
          "\nArticles and papers to get through:\n\n" +
            "1. End-to-end encryption for everyone\n" +
            "2. Designing for local-first software\n" +
            "3. The case against cloud lock-in\n",
        ),
      );
      await safe("note Weekly review", () =>
        createNoteWithBody(
          s,
          "Weekly review",
          "\nWhat went well this week:\n\n" +
            "- Shipped the new editor\n" +
            "- Cleaned up the sidebar\n\n" +
            "Next week: focus on backups. See the [[Roadmap]].\n",
        ),
      );

      // Spell / comment / folding sample notes — small, single-purpose
      // bodies so the matching frames have an unambiguous subject.
      await safe("note Spelling sample", () =>
        createNoteWithBody(
          s,
          "Spelling sample",
          "\nThis sentance has a few mispelled wrods to triger the checker.\n",
        ),
      );
      await safe("note Comment sample", () =>
        createNoteWithBody(
          s,
          "Comment sample",
          "\nVisible text %%this is an editor comment%% more visible text.\n",
        ),
      );
      await safe("note Folding sample", () =>
        createNoteWithBody(
          s,
          "Folding sample",
          "\n## Project notes\n\n" +
            "First detail under the heading.\n" +
            "Second detail under the heading.\n" +
            "Third detail under the heading.\n" +
            "Fourth detail under the heading.\n",
        ),
      );

      // Outline sample — several headings (one nested) so the Outline tab in
      // the right panel has a legible heading structure to render.
      await safe("note Outline sample", () =>
        createNoteWithBody(
          s,
          "Outline sample",
          "\n## Introduction\n\nWhy this note exists.\n\n" +
            "## Background\n\nThe context behind the work.\n\n" +
            "### Prior art\n\nWhat came before.\n\n" +
            "## Plan\n\nWhat we will do next.\n\n" +
            "## Conclusion\n\nWrapping up.\n",
        ),
      );

      // Unlinked-mention seed: a note that names "Roadmap" in PLAIN TEXT (not a
      // [[wikilink]]) so the Unlinked mentions panel has a candidate to surface.
      await safe("note Meeting notes", () =>
        createNoteWithBody(
          s,
          "Meeting notes",
          "\nWe walked through the Roadmap at standup and agreed on the next milestone.\n",
        ),
      );

      // Hub note LAST so it stays open + selected for the first frames.
      // Its wikilinks give the graph real edges (otherwise all nodes are
      // isolated and the graph reads as blank) and seed Roadmap's backlinks.
      await safe("note Welcome to Myne", () =>
        createNoteWithBody(
          s,
          "Welcome to Myne",
          "\nMyne keeps your notes encrypted on your device. This vault is " +
            "just a folder of encrypted files; nothing leaves your computer.\n\n" +
            "Start here:\n\n" +
            "- [[Roadmap]] — what we're shipping next\n" +
            "- [[Reading list]] — articles to get through\n" +
            "- [[Weekly review]] — notes from the last review\n\n" +
            "Everything you type is saved automatically and encrypted at rest.\n",
        ),
      );

      // Best-effort: create a note inside the Projects folder and set it as
      // the folder index (folder-notes.e2e.ts: right-click the folder row →
      // "new-note", then right-click the note → "note.set-index").
      await safe("folder index note", async () => {
        const folder = await s.waitForElement(testIdSelector("notes.folder-row"), {
          timeoutMs: 10000,
        });
        await folder.rightClick();
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "new-note" }),
            { timeoutMs: 6000 },
          )
        ).click();
        // myne#653: a folder create names the note in the note, not in the
        // sidebar (the rename input is not opened any more).
        const titleField = await s.byTestId("editor.frontmatter-title", {
          timeoutMs: 6000,
        });
        await titleField.sendKeys("Projects overview" + ENTER);
        await sleep(500);
        const note = await noteRowByTitle(s, "Projects overview");
        await note.rightClick();
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "note.set-index" }),
            { timeoutMs: 6000 },
          )
        ).click();
        // MYND-370: setting a folder note now HIDES the note from the tree and
        // surfaces an "Open folder note" affordance on the folder's own row
        // (the old per-note index badge is gone). Wait for that affordance.
        await s.byTestId("notes.folder-index-affordance", { timeoutMs: 6000 });
      });

      // =====================================================================
      // CLEAN SINGLE-PANE EDITOR FRAMES (every transient state toggled off
      // after capture so the next editor frame starts from Live + one pane).
      // =====================================================================

      // ---- Frame: interface tour (populated editor) ----
      await frame(
        s,
        "interface-tour",
        "getting-started/interface-tour",
        "The Myne editor with the note sidebar on the left, a note open in the centre, and the bottom bar.",
        async () => {
          await openNoteByTitle(s, "Welcome to Myne");
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
          await openNoteByTitle(s, "Reading list");
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
          await openNoteByTitle(s, "Weekly review");
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
      // heading-list-folding.e2e.ts: hover the editor to reveal the gutter
      // fold markers, click one, wait for the fold placeholder.
      await frame(
        s,
        "folding",
        "editor-and-writing/folding",
        "A note with a heading section folded, showing the collapsed placeholder where the hidden lines were.",
        async () => {
          await pressKey(s, ESCAPE); // ensure no lingering focus mode / overlay
          await settle(s, 300);
          await openNoteByTitle(s, "Folding sample");
          await settle(s, 600);
          // Fold via the palette action (heading-list-folding.e2e.ts hlf2) —
          // robust and coordinate-free. The prior synthetic `.click()` fired at
          // (0,0), which CM6's foldGutter mapped to the non-foldable frontmatter
          // line, so nothing folded and the placeholder never appeared (ok:false).
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
          await openNoteByTitle(s, "Reading list");
          await settle(s, 400);
          await ctrlChord(s, "f");
          await (await s.byTestId("find.input", { timeoutMs: 10000 })).sendKeys("encryption");
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
          await openNoteByTitle(s, "Weekly review");
          await settle(s, 400);
          await keyTypeIntoEditor(s, "/");
          await s.waitForElement(".cm-slash-menu", { timeoutMs: 8000 });
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
          await openNoteByTitle(s, "Comment sample");
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
          await openNoteByTitle(s, "Welcome to Myne");
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
          await openNoteByTitle(s, "Spelling sample");
          const squiggle = await s.waitUntil(
            async () => {
              for (const el of await s.byTestIdAll("editor.spell-error")) {
                if ((await el.textContent()).trim() === "sentance") return el;
              }
              return null;
            },
            { label: 'squiggle for "sentance"', timeoutMs: 15000 },
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
          await openNoteByTitle(s, "Welcome to Myne");
          await s.waitForElement(".cm-fm-properties", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: wikilinks (rendered [[wikilink]] pills) ----
      // wikilink/chip-widget.ts renders .cm-wikilink-chip when the caret is off
      // that line. "Welcome to Myne" already contains three wikilinks.
      await frame(
        s,
        "wikilinks",
        "find-and-connect/wikilinks",
        "A note with rendered wikilink pills that link to other notes in the vault.",
        async () => {
          await openNoteByTitle(s, "Welcome to Myne");
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
          const row = await noteRowByTitle(s, "Welcome to Myne");
          await row.rightClick();
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
          const row = await openNoteByTitle(s, "Roadmap");
          const noteId = await row.attribute("data-note-id");
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
          await openNoteByTitle(s, "Welcome to Myne");
          await s.byTestId("editor.root");
          await settle(s, 400);
        },
      );

      // ---- Frame: daily notes (today's dated note opened from the palette) ----
      // daily.open-today is an idempotent open-or-create in the Daily/ folder.
      await frame(
        s,
        "daily-notes",
        "notes-and-organization/daily-notes",
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
          await rowContextAction(s, "Welcome to Myne", "favorite");
          await s.waitUntil(
            async () => {
              let n = 0;
              for (const r of await s.byTestIdAll("notes.row"))
                if ((await r.textContent()).includes("Welcome to Myne")) n++;
              return n >= 2 ? true : null;
            },
            { label: "note shown in Favorites + tree", timeoutMs: 8000 },
          );
          await settle(s, 400);
        },
      );
      // Un-favourite so the sidebar returns to its plain shape for later frames.
      await safe("un-favourite", () => rowContextAction(s, "Welcome to Myne", "favorite"));

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
          await rowContextAction(s, "Welcome to Myne", "color");
          await s.byTestId("notes.decoration-popover", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      await safe("close colour popover", () => pressKey(s, ESCAPE));

      // ---- Frame: templates (the Manage templates modal) ----
      // templates.manage → TemplatesManager (ModalShell, aria-labelledby). The
      // capture vault has no templates, so the first-run empty state shows.
      await frame(
        s,
        "templates",
        "notes-and-organization/templates",
        "The Manage templates modal, where note templates are created, renamed, and removed.",
        async () => {
          await runPaletteAction(s, "templates.manage", "template");
          await s.waitForElement('[aria-labelledby="templates-modal-title"]', { timeoutMs: 8000 });
          await settle(s, 500);
        },
      );
      await safe("close templates modal", async () => {
        await pressKey(s, ESCAPE);
        await s.waitForGone('[aria-labelledby="templates-modal-title"]');
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
      // notes.e2e.ts: click one row, Ctrl-click another (multi-select toggles
      // since MYND-367), then right-click for the bulk context menu.
      await frame(
        s,
        "bulk-note-actions",
        "notes-and-organization/bulk-note-actions",
        "Several note rows selected together in the sidebar with the bulk-actions context menu open.",
        async () => {
          const first = await noteRowByTitle(s, "Reading list");
          await first.click();
          const second = await noteRowByTitle(s, "Weekly review");
          await second.modifierClick(CTRL);
          await s.waitUntil(
            async () =>
              (await s.findElements(testIdSelector("notes.row", { "data-multiselected": "true" })))
                .length >= 2 || null,
            { label: "two rows multi-selected", timeoutMs: 8000 },
          );
          await second.rightClick();
          await s.waitForElement(testIdSelector("notes.context-menu-item"), { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      // Dismiss the context menu and clear the multi-selection.
      await safe("clear bulk selection", async () => {
        await pressKey(s, ESCAPE);
        await openNoteByTitle(s, "Welcome to Myne");
      });

      // ---- Frame: pinned and stacked tabs (a pinned tab + multiple tabs) ----
      // tab-modes.e2e.ts: middle-click rows to open extra tabs, then
      // right-click a tab → tab.pin.
      await frame(
        s,
        "pinned-and-stacked-tabs",
        "notes-and-organization/pinned-and-stacked-tabs",
        "The editor tab strip with several note tabs open and one tab pinned.",
        async () => {
          await openNoteByTitle(s, "Roadmap");
          await safe("open extra tabs via middle-click", async () => {
            await (await noteRowByTitle(s, "Reading list")).middleClick();
            await sleep(400);
            await (await noteRowByTitle(s, "Weekly review")).middleClick();
            await sleep(400);
          });
          await s.byTestId("editor.tab-strip", { timeoutMs: 8000 });
          // Best-effort: pin the first tab via its context menu.
          await safe("pin a tab", async () => {
            const tabs = await s.byTestIdAll("editor.tab");
            if (tabs.length === 0) throw new Error("no tabs to pin");
            await tabs[0].rightClick();
            await (
              await s.waitForElement(
                testIdSelector("notes.context-menu-item", { "data-item-id": "tab.pin" }),
              )
            ).click();
          });
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
      // workspace-state.e2e.ts: Alt-click a row opens it to the side (split);
      // confirm two editor.pane elements. Done AFTER single-pane frames.
      await frame(
        s,
        "tabs-and-split-view",
        "notes-and-organization/tabs-and-split-view",
        "Two notes open side by side in a split editor, each in its own pane.",
        async () => {
          await openNoteByTitle(s, "Roadmap");
          await (await noteRowByTitle(s, "Reading list")).modifierClick(ALT);
          await s.waitUntil(
            async () => ((await s.byTestIdAll("editor.pane")).length >= 2 ? true : null),
            { label: "two editor panes after split", timeoutMs: 10000 },
          );
          await settle(s, 600);
        },
      );

      // =====================================================================
      // FIND-AND-CONNECT FRAMES
      // =====================================================================

      // ---- Frame: backlinks (the right-sidebar backlinks for Roadmap) ----
      // search-palette.e2e.ts: backlink rows are editor.backlink-row.
      // Open in a single pane first so the layout is clean.
      await frame(
        s,
        "backlinks",
        "find-and-connect/backlinks",
        "A note's backlinks panel listing the other notes that link to it.",
        async () => {
          await openNoteByTitle(s, "Roadmap");
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
          await openNoteByTitle(s, "Outline sample");
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
      // Same right-panel-tab idiom as outline (tab id "unlinked"). Open Roadmap,
      // which "Meeting notes" names in plain text (an unlinked mention). Rows
      // carry no testid, so gate on the tab + a settle (best-effort).
      await frame(
        s,
        "unlinked-mentions",
        "find-and-connect/unlinked-mentions",
        "The Unlinked mentions tab listing other notes that name this note without linking it.",
        async () => {
          await openNoteByTitle(s, "Roadmap");
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
          await (await s.byTestId("palette.input", { timeoutMs: 10000 })).sendKeys("road");
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
          await openNoteByTitle(s, "Welcome to Myne");
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
      await frame(
        s,
        "settings-privacy",
        "settings-and-privacy/auto-lock-and-screen-capture",
        "The Privacy settings panel showing the auto-lock duration and screen-capture protection toggle.",
        async () => {
          await (await s.byTestId("settings.tab-privacy")).click();
          await s.byTestId("settings.auto-lock-select", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: quick unlock (the Privacy panel's Quick unlock block) ----
      // quick-unlock.e2e.ts: settings.quick-unlock lives on the Privacy tab.
      await frame(
        s,
        "quick-unlock",
        "settings-and-privacy/quick-unlock",
        "The Quick unlock section of the Privacy settings, where a device PIN can be set up.",
        async () => {
          await safe("ensure privacy tab", async () => {
            await (await s.byTestId("settings.tab-privacy")).click();
          });
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
      // reading-source-modes.e2e.ts / TypographySettings.tsx:
      // settings.tab-editor → settings.editor-text-size.
      await frame(
        s,
        "editor-display",
        "editor-and-writing/editor-display",
        "The Editor settings panel with the text-size and display options.",
        async () => {
          await (await s.byTestId("settings.tab-editor")).click();
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
              ['[data-testid="settings.sync-panel"] [data-testid="sync.status-indicator"]'],
            );
          });
          await settle(s, 400);
        },
      );

      // ---- Frame: add a device (the enroll form, best-effort empty state) ----
      await frame(
        s,
        "add-a-device",
        "sync-and-devices/add-a-device",
        "The Add a device form in Sync settings, where you sign a new device in to your account.",
        async () => {
          await (await s.byTestId("settings.tab-sync")).click();
          await s.byTestId("settings.sync-panel", { timeoutMs: 6000 });
          const enroll = await s.byTestId("sync.enroll", { timeoutMs: 6000 });
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
      // `ai` now sits in the Developer group (developer-mode feature, MYND-593
      // — supersedes the earlier always-visible Labs framing this comment used
      // to describe) and the tab only renders once Developer mode is on. This
      // capture currently relies on `settings.tab-ai` being reachable
      // unconditionally, which is no longer true — it needs an
      // enable-Developer-mode step from the About panel before this frame,
      // once that toggle lands (developer-mode feature task 6). Flagging
      // rather than silently leaving a capture step that will fail once this
      // TODO is addressed.
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

      // ---- Frame: account (label + icon + actions) ----
      await frame(
        s,
        "account-panel",
        "settings-and-privacy/account",
        "The Account settings panel showing the vault label and icon, and the change-password and delete-vault actions.",
        async () => {
          await (await s.byTestId("settings.tab-account")).click();
          await s.byTestId("settings.icon-picker", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );

      // ---- Frame: connected extensions (browser-clipper pairings) ----
      // Lives in the Account panel; the capture vault has none paired, so the
      // empty state (settings.connected-extensions-empty) shows.
      await frame(
        s,
        "connected-extensions",
        "attachments-and-import/browser-clipper",
        "The Connected extensions section of the Account settings, where browsers paired with the clipper are listed and can be revoked.",
        async () => {
          await (await s.byTestId("settings.tab-account")).click();
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

      // ---- Frame: change password (the Change password form, Account tab) ----
      // AccountPanel: settings.change-password-cta reveals PasswordChangeForm
      // (change-password.submit). Cancel back to idle — never submit.
      await frame(
        s,
        "change-password",
        "settings-and-privacy/change-your-password",
        "The Change password form in Account settings, with fields for the current password, the new password, and confirmation.",
        async () => {
          await (await s.byTestId("settings.tab-account")).click();
          await (await s.byTestId("settings.change-password-cta")).click();
          await s.byTestId("change-password.submit", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      await safe("cancel change-password", async () => {
        await (await s.byTestId("change-password.cancel")).click();
      });

      // ---- Frame: delete a vault (the confirm form, Account tab) ----
      // AccountPanel: settings.delete-vault-cta reveals DeleteVaultConfirmForm
      // (delete-vault.confirm-input). Submit is gated on the typed phrase, so
      // capturing the empty form + cancelling never deletes anything.
      await frame(
        s,
        "delete-a-vault",
        "settings-and-privacy/delete-a-vault",
        "The delete-vault confirmation form in Account settings, which requires typing a confirmation phrase before the vault is erased.",
        async () => {
          await (await s.byTestId("settings.tab-account")).click();
          await (await s.byTestId("settings.delete-vault-cta")).click();
          await s.byTestId("delete-vault.confirm-input", { timeoutMs: 6000 });
          await settle(s, 400);
        },
      );
      await safe("cancel delete-vault", async () => {
        await (await s.byTestId("delete-vault.cancel")).click();
      });

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
        await openNoteByTitle(s, "Welcome to Myne");
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
          await openNoteByTitle(s, "Weekly review");
          await settle(s, 400);
          await keyTypeIntoEditor(s, "/record");
          // Wait for the slash menu to open + filter to the Voice note command
          // BEFORE committing, else Enter fires on an unrendered/unfiltered menu.
          await s.waitForElement(".cm-slash-menu", { timeoutMs: 8000 });
          await settle(s, 300);
          // Commit the slash menu's top match (Enter) to fire the command.
          await (await s.waitForElement(CM_CONTENT)).sendKeys(ENTER);
          await s.waitForElement('[data-testid="voice-record-bar"]', { timeoutMs: 8000 });
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
        await s.waitForGone('[data-testid="voice-record-bar"]');
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

      // ---- Manifest ----
      writeFileSync(
        join(OUT_DIR, "manifest.json"),
        JSON.stringify(
          {
            generatedBy: "e2e/capture/userguide.capture.ts",
            window: "1100x720 (tauri.conf.json), light theme",
            frames,
          },
          null,
          2,
        ),
      );
      const ok = frames.filter((f) => f.ok).length;
      // eslint-disable-next-line no-console
      console.log(`[capture] done — ${ok}/${frames.length} frames captured -> ${OUT_DIR}`);
    } finally {
      await app.teardown();
    }
  },
  // Per-test timeout (this arg overrides vitest.capture.config.ts's testTimeout
  // for THIS test). The expanded ~60-frame pass at @2x runs ~10-14 min — the
  // original 600s aborted it mid-pass (manifest never written). Keep in sync
  // with the config's testTimeout.
  900_000,
);
