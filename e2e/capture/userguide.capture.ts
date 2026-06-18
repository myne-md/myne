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
// support (docs/dev/e2e.md), and there is no mock layer (src/CLAUDE.md),
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
  closeSettings,
  dismissImporterOffer,
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
 *  so settle first and retry the click until the rename input appears.
 *  Enter commits the rename; waitForGone confirms the input closed. */
async function createNote(session: Session, title: string): Promise<void> {
  await sleep(500); // let any prior autosave/remount finish
  let rename: Element | null = null;
  for (let attempt = 0; attempt < 3 && !rename; attempt++) {
    await (await session.byTestId("notes.create")).click();
    try {
      rename = await session.byTestId("notes.rename-input", { timeoutMs: 4000 });
    } catch {
      await sleep(600);
    }
  }
  if (!rename) throw new Error("notes.rename-input never appeared after 3 create attempts");
  await rename.sendKeys(title + ENTER);
  await session.waitForGone(testIdSelector("notes.rename-input"));
}

/** Create a top-level folder named `name`. Enter commits the name input;
 *  then wait for at least one folder row to materialize. */
async function createFolder(session: Session, name: string): Promise<void> {
  await (await session.byTestId("notes.new-folder")).click();
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
 *  the callout never renders). A paste inserts verbatim, untouched by
 *  auto-close. After pasting, move the cursor to the document start so the
 *  live-preview widgets render (the block under the cursor shows source). */
async function typeBody(session: Session, text: string): Promise<void> {
  // Re-fetch the .cm-content handle right before each keystroke op: CM6
  // remounts on note-switch/focus, which staleness-invalidates a handle
  // held across awaits (observed as "stale element reference"). On a stale
  // throw, settle and retry once — the remount has finished by then.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (await session.waitForElement(CM_CONTENT)).click();
      // Move to document END first so the paste lands AFTER the managed
      // frontmatter (title/updated). Pasting at the top would displace it
      // below line 1, breaking title parsing ("Untitled") and dumping raw
      // frontmatter as a trailing code block.
      await (await session.waitForElement(CM_CONTENT)).sendKeys(CTRL + END + CTRL);
      // Synthetic paste (querySelector is always fresh — no stale handle).
      // Inserts verbatim, untouched by bracket auto-close.
      await session.execute(
        "var el = document.querySelector(arguments[0]);" +
          "el.focus();" +
          "var dt = new DataTransfer();" +
          "dt.setData('text/plain', arguments[1]);" +
          "el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));",
        [CM_CONTENT, text],
      );
      // Mod-Home → document start, off the pasted block so every
      // live-preview widget renders (the block under the cursor shows source).
      await (await session.waitForElement(CM_CONTENT)).sendKeys(CTRL + HOME + CTRL);
      await session.waitUntil(async () => (await editorText(session)).length > 5 || null, {
        label: "pasted body landed",
        timeoutMs: 5000,
      });
      return;
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(800); // CM remount settling; retry the whole sequence
    }
  }
}

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
    { label: `notes.row titled "${title}"`, timeoutMs: 12000 },
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
    { label: `notes.row titled "${title}" (no click)`, timeoutMs: 12000 },
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
        const rename = await s.byTestId("notes.rename-input", { timeoutMs: 6000 });
        await rename.sendKeys("Projects overview" + ENTER);
        await s.waitForGone(testIdSelector("notes.rename-input"));
        await sleep(500);
        const note = await noteRowByTitle(s, "Projects overview");
        await note.rightClick();
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "note.set-index" }),
            { timeoutMs: 6000 },
          )
        ).click();
        await s.byTestId("notes.row-folder-index-badge", { timeoutMs: 6000 });
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
          const editor = await s.waitForElement(CM_EDITOR);
          await editor.hover();
          await settle(s, 300);
          // The gutter fold marker is hover-revealed; WebDriver reports it
          // "not interactable", so wait for it to exist then fold via a
          // synthetic DOM click (bypasses the interactability check).
          await s.waitUntil(
            async () =>
              (await s.findElements(testIdSelector("editor.fold-gutter-marker"))).length > 0 || null,
            { label: "fold-gutter marker present", timeoutMs: 10000 },
          );
          await s.execute(
            "var el = document.querySelector(arguments[0]); if (el) el.click();",
            [testIdSelector("editor.fold-gutter-marker")],
          );
          await s.byTestId("editor.fold-placeholder", { timeoutMs: 8000 });
          await settle(s, 400);
        },
      );

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
      ];
      for (const m of mdSamples) {
        await frame(s, m.name, m.slug, m.alt, async () => {
          await createNoteWithBody(s, m.title, m.body);
          await settle(s, 1500); // lazy KaTeX / mermaid render
        });
      }

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

      // ---- Frame: folder notes (a folder index-note badge) ----
      // folder-notes.e2e.ts: the index note's row carries
      // notes.row-folder-index-badge (created in setup above, best-effort).
      await frame(
        s,
        "folder-notes",
        "notes-and-organization/folder-notes",
        "A note in the sidebar marked with a folder-note badge, showing it is its folder's index note.",
        async () => {
          await s.byTestId("notes.row-folder-index-badge", { timeoutMs: 8000 });
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
          await (await s.byTestId("views.new-button", { timeoutMs: 8000 })).click();
          // The "New view" builder dialog IS the saved-views illustration —
          // rendering a saved view would require saving it first. Capture the
          // dialog, then dismiss it below so it never blocks later frames.
          await settle(s, 900);
        },
      );
      // CRITICAL cleanup: the New view dialog is a modal overlay. If left open
      // it intercepts every later click (settings, graph). Dismiss it.
      await safe("close new-view dialog", () => pressKey(s, ESCAPE));

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

      // ---- Frame: account / Argon2id parameters ----
      await frame(
        s,
        "settings-account-argon2id",
        "settings-and-privacy/privacy-model",
        "The Account settings panel showing the Argon2id key-derivation parameters.",
        async () => {
          await clickFirst(s, [testIdSelector("settings.tab-account")], 4000).catch(() => {});
          await settle(s, 400);
        },
      );

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
      // graph-tab.e2e.ts: editor.graph-button opens the graph as a tab; the
      // body is editor.graph-pane.
      await frame(
        s,
        "graph-all",
        "find-and-connect/graph-view",
        "The graph view showing the vault's notes as connected nodes.",
        async () => {
          await pressKey(s, ESCAPE); // dismiss any lingering overlay first
          await (await s.byTestId("editor.graph-button")).click();
          await s.byTestId("editor.graph-pane", { timeoutMs: 12000 });
          await settle(s, 2800); // let the force-directed layout settle
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
  600_000,
);
