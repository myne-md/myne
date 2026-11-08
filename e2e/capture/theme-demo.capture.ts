// Theme-demo frame capture (the /themes hero carousel).
//
// NOT a test, a CAPTURE tool: the sibling of `theme-preview.capture.ts`, sharing
// its harness. Where that one writes the editor's DOM, this one writes a short
// sequence of REAL screenshots of the app changing its own accent colour and
// appearance, so the marketing site can show customisation instead of describing
// it. The frames become the carousel's images; see `scripts/build-theme-demo-stills.mjs`.
//
// WHY FRAMES AND NOT A RECORDING
// tauri-driver has no screen-recording primitive, and the desktop app is the only
// place this story is true (there is no browser seat for a settings modal backed
// by vault prefs). WebDriver DOES give one screenshot per step, so the carousel is
// composed from stills: real pixels, real repaints, and a duration decided at
// encode time rather than by how long a click took.
//
// WHAT IT DRIVES, AND WHY EACH STEP IS IN THE LOOP
// The point a reader has to be able to see is "pick a colour, the app follows".
// A settings-modal still proves nothing on its own, so every pick is followed by
// the editor with the result applied. Dark mode closes the loop: the same accent
// on a second appearance.
//
// Discipline, inherited from the E2E contract: zero test hooks, zero capability
// changes, no production edits. The app is driven through its own controls by
// testid, exactly as a user would, and the page is only read through
// `session.execute` for the applied `--accent` value.
//
// Run via `scripts/capture-theme-demo.sh` (Linux container; tauri-driver has no
// macOS support, `myne-agents/docs/dev/e2e.md`), which then turns the frames into the
// carousel's JPEGs on the host with `scripts/build-theme-demo-stills.mjs`.
// Self-skips off-platform.

import { it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { harnessSupported, launchApp, REPO_ROOT } from "./../support/session";
import { KEY, pressChord } from "./../support/keyboard";
import { seedVault } from "./../support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  pasteIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./../support/flows";
import type { Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "theme-demo");

// The note the frames are shot over. Short enough that the whole editor fits, rich
// enough (a callout, code, a quote, a task list) that a repaint is visible in
// four different roles at once. Nothing on screen may read as real content,
// because this frame ends up on a public page.
const NOTE_TITLE = "A quiet place";

const SAMPLE_BODY = `
A quiet place to think. Headings, body text, a link to the [[Reading list]] and
the ==occasional highlight== all take their colour from the palette.

> [!note] Your theme, not ours
> Frames, shadows and folds are chosen per role, so a callout can be dressed
> without naming a single element.

## Code, quotes and tasks

\`\`\`ts
export function palette(theme: Theme): Palette {
  return { ...resolve(theme.vars), accent: theme.vars.accent };
}
\`\`\`

> Pick a background, pick an accent, watch everything follow.

- [x] Choose a page colour
- [x] Choose an accent
- [ ] Try a second appearance
`;

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

/** `git rev-parse HEAD`, or `"unknown"` where git is not on PATH. */
function readGitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Snap the window to `<OUT_DIR>/<n>-<name>.png`.
 *
 * The ordinal prefix is what orders the sequence: the encoder sorts by filename,
 * so the story has to be in the names rather than in a list this file and the
 * encoder both have to keep in step.
 */
async function shot(session: Session, index: number, name: string): Promise<void> {
  // EVERY frame, not just the first. The gate exists because these bytes are
  // published on a public page, and a step added after the opening frame is
  // exactly the one a one-shot check would miss.
  await assertPublishable(session);
  const png = await session.screenshot();
  const file = `${String(index).padStart(2, "0")}-${name}.png`;
  writeFileSync(join(OUT_DIR, file), Buffer.from(png, "base64"));
  // eslint-disable-next-line no-console
  console.log(`[theme-demo] ${file}`);
}

/** The accent the app has applied to `:root`, lowercased. */
async function accent(session: Session): Promise<string> {
  const v = await session.execute<string>(
    "return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase();",
  );
  return v ?? "";
}

/**
 * Press the accent preset at `index` and wait until the app has applied it.
 *
 * The handles are re-queried every time: pressing a preset re-renders the
 * popover, which leaves a handle captured before the press pointing at a node
 * that no longer exists.
 */
async function pickPreset(session: Session, index: number): Promise<void> {
  const presets = await session.byTestIdAll("settings.accent-preset");
  const target = presets[index];
  if (!target) throw new Error(`no accent preset at index ${index} (found ${presets.length})`);
  const hex = ((await target.attribute("aria-label")) ?? "").toLowerCase();
  await target.click();
  await session.waitUntil(async () => ((await accent(session)) === hex ? true : null), {
    label: `accent becomes ${hex || "the pressed preset"}`,
    timeoutMs: 10_000,
  });
  // The repaint lands with the state change; this is for the frame, not for the
  // assertion, so it can be short.
  await sleep(400);
}

/**
 * Everything this capture frames is published on a public marketing page, so the
 * run has to prove it is looking at the SEEDED FIXTURE rather than at a real
 * vault. Two cheap checks, both from the page seat, before a single PNG is
 * written:
 *
 *  - the note we created is the one on screen;
 *  - nothing on screen matches the documented account-number display form
 *    (`MY-XXXX-...`, `myne-agents/docs/spec/account-number.md`).
 *
 * A future step that opened the Account pane or the vault picker would fail
 * here, by name, instead of publishing that frame.
 */
async function assertPublishable(session: Session): Promise<void> {
  const text = await session.execute<string>("return document.body ? document.body.innerText : '';");
  const visible = typeof text === "string" ? text : "";
  if (!visible.includes(NOTE_TITLE)) {
    throw new Error(
      `theme-demo: the seeded note "${NOTE_TITLE}" is not on screen, so this is not the fixture. ` +
        "Refusing to capture frames for a public page.",
    );
  }
  if (/MY-[A-Z0-9]{4}-/i.test(visible)) {
    throw new Error(
      "theme-demo: an account-number-shaped string is on screen. These frames are published on a public page, so the capture stops here.",
    );
  }
}

runner(
  "captures the theme-demo frames",
  async () => {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    const app = await launchApp({
      // Production KDF: the weak-KDF fixture is below `validate_kdf_params`' floor
      // and the production binary rejects it as corrupt (same reason the preview
      // capture does this).
      seed: (dir) => void (password = seedVault(dir, { kdf: "production" }).password),
    });
    const s = app.session;
    try {
      await unlockToEditor(s, password);
      await dismissImporterOffer(s);

      await createNote(s, NOTE_TITLE);
      await pasteIntoEditor(s, SAMPLE_BODY);
      await waitForSaved(s);
      // Live-preview widgets (callout, code highlighting, task chips) mount a
      // beat after the document settles; shooting before they land would put a
      // half-decorated editor in the frames.
      await s.waitForElement(".cm-content .cm-line");
      // Pasting leaves the caret at the end, so the editor scrolls to the bottom
      // of the note. Every frame in this loop is of an app window, and a window
      // that opens mid-sentence reads as a cropped screenshot; Mod-Home is the
      // app's own "go to the start" so the note is shown from its title.
      await pressChord(s, KEY.CONTROL, KEY.HOME);
      await sleep(1_800);

      await shot(s, 1, "editor");

      // Appearance, then the accent picker.
      await openSettings(s, "appearance");
      await sleep(700);
      await shot(s, 2, "settings");

      await (await s.byTestId("settings.accent-color")).click();
      await s.byTestId("settings.accent-popover");
      await sleep(350);
      await shot(s, 3, "palette");

      // One preset with the picker still open, so the popover's own swatches and
      // the app behind it change together.
      await pickPreset(s, 1);
      await shot(s, 4, "palette-picked");

      // …then the same accent across the whole editor.
      await closeSettings(s);
      await sleep(700);
      await shot(s, 5, "editor-accent-one");

      // A second accent, so the loop reads as "this is a control" rather than
      // "this is one theme".
      await openSettings(s, "appearance");
      await sleep(500);
      await (await s.byTestId("settings.accent-color")).click();
      await s.byTestId("settings.accent-popover");
      const count = (await s.byTestIdAll("settings.accent-preset")).length;
      await pickPreset(s, Math.min(3, count - 1));
      await closeSettings(s);
      await sleep(700);
      await shot(s, 6, "editor-accent-two");

      // Dark appearance, with the accent carried over.
      await openSettings(s, "appearance");
      await sleep(500);
      await (await s.byTestId("settings.theme-dark")).click();
      // Wait on the OBSERVABLE state, not on a sleep: the write is disk-first
      // (persist, then flip the attribute), so a refused or slow write would
      // otherwise shoot two light frames the carousel calls dark.
      await s.waitUntil(
        async () => {
          const theme = await s.execute<string>(
            "return document.documentElement.getAttribute('data-theme') ?? '';",
          );
          return theme === "dark" ? true : null;
        },
        { label: "the dark appearance is applied", timeoutMs: 10_000 },
      );
      await sleep(400);
      await shot(s, 7, "settings-dark");
      await closeSettings(s);
      await sleep(700);
      await shot(s, 8, "editor-dark");

      const commit = (process.env.MYNE_PREVIEW_COMMIT ?? "").trim() || readGitHead();
      writeFileSync(
        join(OUT_DIR, "meta.json"),
        `${JSON.stringify(
          {
            commit,
            capturedAt: new Date().toISOString(),
            frames: 8,
            note: "Captured from the running desktop app by e2e/capture/theme-demo.capture.ts. These are the raw PNGs; scripts/build-theme-demo-stills.mjs turns them into the carousel's JPEGs. Do not hand-edit.",
          },
          null,
          2,
        )}\n`,
      );
      // eslint-disable-next-line no-console
      console.log(`[theme-demo] ${OUT_DIR}: 8 frames @ ${commit.slice(0, 8)}`);
    } finally {
      await app.teardown();
    }
  },
  600_000,
);
