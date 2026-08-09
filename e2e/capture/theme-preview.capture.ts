// Theme-preview snapshot capture (deep-customization, myne#394).
//
// NOT a test — a CAPTURE tool, the sibling of `userguide.capture.ts` and sharing
// its harness, its helpers and its constraints. Where that one writes PNGs, this
// writes the editor's LIVE DOM plus every CSS rule the app has loaded, so a
// theme preview can be the real interface instead of a hand-written imitation
// of it.
//
// WHY THIS EXISTS
// Three separate mock Myne UIs had grown — the theme gallery's PNG renderer
// (`myne-themes/tools/render-preview.mjs`), the website builder's `tb-pv-*`
// markup, and the card images the first one produced. Each was written by hand,
// each drifted from the app on its own schedule, and none of them knew ornament
// existed: a theme selecting `frame: thick` previewed as a plain rectangle
// everywhere a user could look at it before installing. A snapshot taken FROM
// the app cannot drift on its own, because nobody writes it.
//
// WHAT MAKES THE SNAPSHOT STAY ALIVE
// It is captured under the DEFAULT theme with NO ornament selected, and a theme
// is applied to it exactly the way the app applies one: custom properties on the
// root plus `data-o-*` attributes. Those resolve at paint time, so a static
// document still re-themes completely. What does NOT re-theme is a hardcoded
// literal in an inline style — and that is the honest part: the preview shows a
// theme changing precisely what it can change in the real app, including the
// places it still cannot reach (the token-adoption debt the ratchet tracks).
//
// Discipline, inherited from the E2E contract: zero test hooks, zero capability
// changes, no production edits. The page is read through `session.execute` only.
//
// Run via `scripts/capture-theme-preview.sh` (Linux container — tauri-driver has
// no macOS support, `docs/dev/e2e.md`). Self-skips off-platform.

import { it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { harnessSupported, launchApp, REPO_ROOT } from "./../support/session";
import { seedVault } from "./../support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pasteIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./../support/flows";
import type { Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "theme-preview");

// The sample note. Every construct here exists to give a theme something to
// change: a callout and a code block and a quote are the `box` ornament role, the
// page is `surface`, the sidebar and buttons are `chrome`. Mundane on purpose —
// a preview is looked at by people deciding whether they like a colour, and it
// appears in a public gallery, so nothing on screen may read as real content.
const SAMPLE_BODY = `
A preview note, so a theme has something to be a theme *of*. Headings, body text,
a link to the [[Reading list]], and the ==occasional highlight== all take their
colour from the palette rather than from this note.

> [!note] What ornament changes
> Frames, shadows, textures and folds are chosen per role — surfaces, boxes, and
> controls — so a theme dresses this callout without naming it.

## Code, quoted text, and tasks

\`\`\`ts
export function palette(theme: Theme): Palette {
  const tokens = resolve(theme.vars);
  return { ...tokens, accent: tokens.accent ?? DEFAULT_ACCENT };
}
\`\`\`

> A blockquote sits in the same ornament role as a callout, which is why the two
> pick up a frame together.

- [ ] Pick a background and an accent
- [ ] Try a texture behind the page
- [x] Decide it looks better than the last one

Tagged #themes #design
`;

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

/** `git rev-parse HEAD`, or `"unknown"` where git is not on PATH. */
function readGitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** The page's own DOM, stripped of everything a static copy must not carry. */
async function captureDom(session: Session): Promise<string> {
  return session.execute<string>(
    // Clone first: this must not mutate the running app, which is still under
    // capture and may be read again.
    "var root = document.documentElement.cloneNode(true);" +
      // Scripts would execute in the consuming page; module preloads would 404
      // there. Inline <style> is dropped because the CSS is captured separately
      // and completely — keeping both would ship every rule twice.
      "root.querySelectorAll('script, style, link[rel=modulepreload], link[rel=stylesheet]')" +
      "  .forEach(function (n) { n.remove(); });" +
      // The caret and selection are a moment in time, not part of the interface.
      "root.querySelectorAll('[contenteditable]')" +
      "  .forEach(function (n) { n.setAttribute('contenteditable', 'false'); });" +
      "return root.outerHTML;",
  );
}

/** Every CSS rule the app has loaded, in cascade order. */
async function captureCss(session: Session): Promise<string> {
  return session.execute<string>(
    "var out = [];" +
      "for (var i = 0; i < document.styleSheets.length; i++) {" +
      "  var sheet = document.styleSheets[i];" +
      "  try {" +
      "    var rules = sheet.cssRules;" +
      "    for (var j = 0; j < rules.length; j++) out.push(rules[j].cssText);" +
      "  } catch (e) {" +
      // A sheet whose rules cannot be read is recorded rather than skipped: a
      // silent gap here shows up much later as "the preview looks wrong" with
      // nothing pointing at the cause.
      "    out.push('/* UNREADABLE SHEET: ' + (sheet.href || 'inline') + ' */');" +
      "  }" +
      "}" +
      "return out.join('\\n');",
  );
}

runner(
  "captures the theme-preview snapshot",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    const app = await launchApp({
      // Production KDF, for the same reason the user-guide pass uses it: the
      // weak-KDF fixture's m_kib=8 is below the `validate_kdf_params` floor and
      // the production binary rejects it as corrupt.
      seed: (dir) => void (password = seedVault(dir, { kdf: "production" }).password),
    });
    const s = app.session;
    try {
      await unlockToEditor(s, password);
      await dismissImporterOffer(s);

      await createNote(s, "A theme, previewed");
      await pasteIntoEditor(s, SAMPLE_BODY);
      await waitForSaved(s);
      // Live-preview widgets (callout container, code highlighting, task chips,
      // tag pills) mount asynchronously after the document settles. Capturing
      // before they land would freeze a half-decorated document — the one defect
      // this snapshot could carry into every consumer at once.
      await s.waitForElement(".cm-content .cm-line");
      await sleep(2_000);

      const html = await captureDom(s);
      const css = await captureCss(s);

      // The provenance the freshness guard reads.
      //
      // The runner passes it in, because the E2E container has no `git` — the
      // repo is a bind mount, not a checkout, and adding git to the image to
      // read one string would be the wrong trade. `git rev-parse` stays as the
      // fallback for a capture run outside the container, and an unreadable
      // provenance degrades to "unknown" rather than throwing away a capture
      // that otherwise succeeded.
      const commit = (process.env.MYNE_PREVIEW_COMMIT ?? "").trim() || readGitHead();

      writeFileSync(join(OUT_DIR, "preview.html"), `${html}\n`);
      writeFileSync(join(OUT_DIR, "preview.css"), `${css}\n`);
      writeFileSync(
        join(OUT_DIR, "meta.json"),
        `${JSON.stringify(
          {
            commit,
            capturedAt: new Date().toISOString(),
            htmlBytes: html.length,
            cssBytes: css.length,
            note: "Captured from the running desktop app by e2e/capture/theme-preview.capture.ts. Do not hand-edit — re-run the capture.",
          },
          null,
          2,
        )}\n`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[theme-preview] ${OUT_DIR}: ${html.length} B html, ${css.length} B css @ ${commit.slice(0, 8)}`,
      );
    } finally {
      await app.teardown();
    }
  },
  600_000,
);
