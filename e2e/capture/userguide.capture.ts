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
// accessible selectors (aria-label) — read-only, no production edits.
// Every frame is independent and best-effort: a frame that can't be
// reached is logged and skipped, never aborting the rest of the pass.
// The screenshot-freshness gate at golive re-runs this against the
// shipping build before publish.

import { it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { harnessSupported, launchApp, REPO_ROOT } from "./../support/session";
import { seedVault } from "./../support/fixtures";
import { closeSettings, dismissImporterOffer, unlockToEditor } from "./../support/flows";
import { testIdSelector, type Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "userguide");
const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const ENTER = String.fromCharCode(0xe007); // W3C key: commit inline rename
const CTRL = String.fromCharCode(0xe009); // W3C modifier (sticky until repeated)
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
  let rename = null;
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
async function createNoteWithBody(
  session: Session,
  title: string,
  body: string,
): Promise<void> {
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

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

runner(
  "captures user-guide frames",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    const app = await launchApp({ seed: (dir) => void (password = seedVault(dir).password) });
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

      // Hub note LAST so it stays open + selected for the first two frames.
      // Its wikilinks give the graph real edges (otherwise all nodes are
      // isolated and the graph reads as blank).
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

      // ---- Frame: interface tour (populated editor) ----
      await frame(
        s,
        "interface-tour",
        "getting-started/interface-tour",
        "The Myne editor with the note sidebar on the left, a note open in the centre, and the bottom bar.",
        async () => {
          await s.byTestId("editor.root");
        },
      );

      // ---- Frame: customized sidebar (favorites + folders + trash footer) ----
      await frame(
        s,
        "customized-sidebar",
        "notes-and-organization/sidebar-customization",
        "The note sidebar showing folders, loose notes, and the Trash footer.",
        async () => {
          await s.byTestId("editor.root");
        },
      );

      // ---- Markdown render frames (live CodeMirror preview) ----
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

      // ---- Settings frames FIRST (clean editor; the graph overlay would
      // otherwise intercept the gear click). Open the modal once, snap
      // Account, switch to Privacy, snap, then close before the graph. ----
      await frame(
        s,
        "settings-account-argon2id",
        "settings-and-privacy/privacy-model",
        "The Account settings panel showing the Argon2id key-derivation parameters.",
        async () => {
          await (await s.byTestId("editor.settings-cta")).click();
          await s.byTestId("settings.modal");
          await clickFirst(s, [testIdSelector("settings.tab-account")], 3000).catch(() => {});
          await settle(s, 400);
        },
      );
      await frame(
        s,
        "settings-privacy",
        "settings-and-privacy/auto-lock-and-screen-capture",
        "The Privacy settings panel showing the auto-lock duration and screen-capture protection toggle.",
        async () => {
          await (await s.byTestId("settings.tab-privacy")).click();
          await s.byTestId("settings.auto-lock-select");
          await settle(s, 400);
        },
      );
      await safe("close settings", () => closeSettings(s));

      // ---- Frame: graph (whole-vault "All" view) — LAST (it overlays the
      // editor; nothing runs after it but teardown). ----
      await frame(
        s,
        "graph-all",
        "find-and-connect/the-graph",
        "The graph view showing the vault's notes as connected nodes.",
        async () => {
          await clickFirst(s, ['[aria-label="Show graph view"]', '[title^="Graph"]']);
          await s.waitUntil(
            async () =>
              (await s.findElements("canvas, svg, [data-graph-canvas]")).length > 0 || null,
            { label: "graph canvas mounted", timeoutMs: 8000 },
          );
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
