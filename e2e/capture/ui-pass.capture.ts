// Screenshot capture for the UI-pass branch (myne-md/myne#772 and its lanes,
// plus the AI surface of myne-md/myne#771).
//
// NOT a test — a CAPTURE tool, the same shape as `userguide.capture.ts` and
// riding the same real-IPC harness. It exists because a UI branch's review
// evidence is pixels, and the only automated seat that can produce them is
// the Linux/webkit2gtk container: tauri-driver has no macOS support
// (`agent-tooling/docs/dev/e2e.md`), and capturing on the developer's own machine would
// photograph their real vault.
//
// Scope: the surfaces THIS branch changed, one frame each, in the order a
// user meets them — the pre-unlock screens first, then the shell, then the
// tabs. Every frame is best-effort: a surface that cannot be reached is
// logged and skipped rather than aborting the pass, because a partial set of
// screenshots is still evidence and a crashed run is none.
//
// Run: `./scripts/capture-ui-pass.sh` (container). PNGs land in
// `e2e/artifacts/ui-pass/`, which is gitignored like every other artefact
// directory — they are attached to the PR, not committed.

import { it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { harnessSupported, launchApp, REPO_ROOT } from "./../support/session";
import { seedVault } from "./../support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  enableAi,
  enableDeveloperModeInSettings,
  openPalette,
  openSettings,
  runPaletteAction,
  selectSettingsTopic,
  typeIntoEditor,
  unlockToEditor,
} from "./../support/flows";
import { testIdSelector, type Session } from "./../support/webdriver";
import { KEY, pressKey } from "./../support/keyboard";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "ui-pass");
interface FrameRecord {
  name: string;
  what: string;
  ok: boolean;
  note?: string;
  /**
   * Set when the frame could not be photographed in THIS build for a reason that
   * is not a defect, and the reason is stated. It is deliberately not `ok: true`:
   * a pass whose summary claims a frame that does not exist is how a PR ends up
   * citing evidence nobody can open. `skipped` frames are named in the PR body
   * with their reason.
   */
  skipped?: string;
}

const frames: FrameRecord[] = [];

/**
 * Why the reviewed-vault seed frames (60 to 63) cannot be photographed in this
 * build, or `null` when they can. The card is gated on the same `ready` the chat
 * notice is (AI on and a model resolved), so a build with no inference stub
 * never draws it, and four red frames would say "broken" about a surface that is
 * correctly absent.
 */
let seedUnavailable: string | null = null;

/**
 * `MYNE_UI_PASS_FRAMES=70,71` runs only the frames whose name starts with one of
 * those tokens, and skips every other frame's SETUP too.
 *
 * It exists because iterating on one stubborn frame otherwise costs the whole
 * pass: the run is ~6 minutes of app driving before the frame under repair is
 * even reached, which turns a two-line fix into an afternoon. Empty (the
 * default, and what CI and a release run) means "every frame".
 */
// `process` is read through a narrow cast rather than typed: this file is inside
// `tsconfig.tests.json`'s trees, which carry no `@types/node`, and importing the
// node typings for one environment variable would move every other error in the
// tree with it (`scripts/check-test-typecheck.mjs` counts per file).
const RAW_FRAME_FILTER: string =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.MYNE_UI_PASS_FRAMES ?? "";
const ONLY: string[] = RAW_FRAME_FILTER.split(",")
  .map((t: string) => t.trim())
  .filter((t: string) => t.length > 0);
const wanted = (name: string): boolean =>
  ONLY.length === 0 || ONLY.some((prefix) => name.startsWith(prefix));

async function capture(session: Session, name: string, what: string): Promise<void> {
  const png = await session.screenshot();
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(png, "base64"));
  frames.push({ name, what, ok: true });
  // eslint-disable-next-line no-console
  console.log(`[ui-pass] OK ${name}.png — ${what}`);
}

/** One frame, isolated: an unreachable surface never kills the pass. */
async function frame(
  session: Session,
  name: string,
  what: string,
  build: () => Promise<void>,
): Promise<void> {
  if (!wanted(name)) return;
  try {
    await build();
    await capture(session, name, what);
  } catch (e) {
    // A frame that already recorded itself as skipped (see `skipFrame`) must not
    // also land as a red entry: the summary would then claim a failure the run
    // explained.
    const message = String(e);
    if (message.startsWith("Error: skip:")) return;
    frames.push({ name, what, ok: false, note: message.slice(0, 200) });
    // eslint-disable-next-line no-console
    console.warn(`[ui-pass] FAIL ${name}: ${message.slice(0, 160)}`);
  }
}

/**
 * A frame the build cannot show, with the reason recorded rather than a failure.
 *
 * Only for a surface whose ABSENCE is a property of the capture build (a model
 * the build does not define, an AI opt-in the harness cannot perform), never for
 * a frame that is merely hard to reach, and those must stay red so somebody fixes
 * them.
 */
function skipFrame(name: string, what: string, reason: string): void {
  if (!wanted(name)) return;
  frames.push({ name, what, ok: false, skipped: reason });
  // eslint-disable-next-line no-console
  console.warn(`[ui-pass] SKIP ${name}: ${reason}`);
}

/**
 * Put the AI chat panel on screen, for real.
 *
 * The palette's `ai.open-chat` only sets the ACTIVE right-panel tab, so on a
 * collapsed rail it changes a preference nothing is drawing and the frame
 * photographs the editor with the panel's DOM still in the tree: the wait then
 * passes on a hidden element and the frame is a false pass (this happened, and
 * `72-ai-chat-notice` shipped a picture of the selection toolbar). So open the
 * rail through its own toggle first, then click the tab that only exists once the
 * rail is open, then wait for the panel's body.
 */
async function openAiChat(s: Session): Promise<void> {
  const toggle = await s.waitForElement(
    testIdSelector("editor.sidebar-toggle", { "data-side": "right" }),
    { timeoutMs: 15_000 },
  );
  if ((await toggle.attribute("data-collapsed")) === "true") await toggle.click();
  const tab = await s.waitForElement(
    testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "ai-chat" }),
    { timeoutMs: 15_000 },
  );
  await tab.click();
  await s.byTestId("ai.chat-tab", { timeoutMs: 20_000 });
}

/** Best-effort setup step: richness, never a blocker. */
async function safe(label: string, run: () => Promise<void>): Promise<void> {
  // A setup step can be tagged with the frame it exists for (`"70: open a
  // note"`), and then it is skipped with that frame under MYNE_UI_PASS_FRAMES.
  const tag = label.split(":")[0].trim();
  if (ONLY.length > 0 && /^\d/.test(tag) && !wanted(tag)) return;
  try {
    await run();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[ui-pass] setup skipped: ${label} — ${String(e).slice(0, 120)}`);
  }
}

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

// The first run: a launch with NO vault on disk, which is what a new user sees
// before anything else. Its own launch because the pass below seeds a vault,
// and a session that has a vault cannot be shown the screen that says it has
// none.
runner(
  "captures the first-run frames",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const app = await launchApp({});
    const s = app.session;
    try {
      await frame(
        s,
        "00a-first-run",
        "First launch, no vault on disk: the welcome screen and its choices.",
        async () => {
          await s.byTestId("welcome.root", { timeoutMs: 45_000 });
          await sleep(600);
        },
      );
      await frame(
        s,
        "00b-first-run-create",
        "The first step behind 'create your identity and vault': one door, then the identity ceremony.",
        async () => {
          await (await s.byTestId("welcome.create-cta")).click();
          await sleep(900);
        },
      );
    } finally {
      await app.teardown();
    }
  },
  300_000,
);

runner(
  "captures the UI-pass frames",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    const app = await launchApp({
      // Production KDF for the same reason the guide pass uses it: the
      // weak-KDF fixture sits below the `validate_kdf_params` floor and the
      // binary rejects it as corrupt.
      seed: (dir) => void (password = seedVault(dir, { kdf: "production" }).password),
    });
    const s = app.session;
    try {
      // ── Pre-unlock ────────────────────────────────────────────────────
      // Captured BEFORE unlocking, because this is the one state that
      // cannot be returned to without tearing the session down.
      await frame(
        s,
        "01-unlock",
        "The unlock screen: named heading, the app's own Input and Button, " +
          "the two alternatives on one row and deleting the vault below a rule.",
        async () => {
          await s.waitForElement(testIdSelector("unlock.password-input"), {
            timeoutMs: 45_000,
          });
          await sleep(400);
        },
      );

      await unlockToEditor(s, password);

      await frame(
        s,
        "15-importer-offer",
        "The first-run importer offer overlay: what a new user meets when the " +
          "editor first opens.",
        async () => {
          await sleep(900);
        },
      );

      await dismissImporterOffer(s);

      // ── The sidebar's zero state (issue #970, item 4) ─────────────────
      // Seeded vault, nothing written yet: this is the one moment the list is
      // empty, and it is reachable only here, before any frame creates a note.
      await frame(
        s,
        "02a-sidebar-empty",
        "The notes sidebar on a vault with no notes: the icon, the accent wash " +
          "and two words, with no card, no paragraph and no button.",
        async () => {
          await sleep(900);
        },
      );

      // ── The shell ─────────────────────────────────────────────────────
      // Through the palette rather than the sidebar's create menu: the same
      // spec also captures the PR's BEFORE side from the merge base, where
      // `clickNewItem` does not exist yet, and `note.new` is on both.
      await safe("a note to look at", async () => {
        await runPaletteAction(s, "note.new", "new note");
        await sleep(800);
      });

      await frame(
        s,
        "02-shell",
        "The editor shell: the sidebar's search row taking the width the three " +
          "create buttons leave it, and the active tab breaking the strip's rule.",
        async () => {
          await sleep(500);
        },
      );

      // ── Attachments (lane 4: a surface you browse is a tab) ───────────
      await frame(
        s,
        "03-attachments",
        "The attachment library as a tab: the quiet search row, the create " +
          "buttons, and the list.",
        async () => {
          await runPaletteAction(s, "attachments.open", "attachment");
          // WAIT for the surface rather than sleeping at it. A palette pick
          // that misses leaves the palette open, and a sleep photographs the
          // palette — which is exactly what the first run of this spec did to
          // the agent frame.
          await s.byTestId("attachments.library", { timeoutMs: 15_000 });
          await sleep(500);
        },
      );

      // ── Settings (lane 1/2: primitives, tooltips, the unified lists) ──
      await frame(
        s,
        "04-settings-appearance",
        "Settings: the ribbon and bottom-bar customize lists, which are now one " +
          "component with a trailing slot rather than two different answers.",
        async () => {
          await openSettings(s, "appearance");
          await sleep(900);
        },
      );

      // ── Sync endpoint (design pass: the fields and their buttons are the
      //    Input/Button primitives rather than hand-rolled controls) ──────
      await frame(
        s,
        "09-sync-endpoint",
        "Settings → Sync: the server address and the invite-code fields with " +
          "their Connect / Change-invite-code controls.",
        async () => {
          await openSettings(s, "sync");
          await sleep(900);
        },
      );

      await frame(
        s,
        "10-settings-files",
        "Settings → Files: the plain-file editor settings.",
        async () => {
          await openSettings(s, "files");
          await sleep(900);
        },
      );

      // Developer mode, from INSIDE the open modal: `enableDeveloperMode`
      // reaches About by the gear, and clicking the gear again on an open
      // modal is a close rather than an open. The agent tab is behind this
      // switch by decision (`agent-tooling/design-notes/ai/0636`).
      await safe("developer mode", async () => {
        await enableDeveloperModeInSettings(s);
        await sleep(400);
      });
      await safe("close settings", async () => {
        await closeSettings(s);
        await sleep(500);
      });

      // **And the AI opt-in, which developer mode alone does not give.**
      // `ai.open-agent-vault`'s `visibility` is `disabled` — not `hidden` —
      // when `aiEnabled` is false, so the palette LISTS the verb and clicking
      // it does nothing. That is correct product behaviour and it is why two
      // runs of this spec waited out the pane's whole budget with the row
      // right there on screen: the capture was reading "the row exists" as
      // "the row works".
      let aiReady = false;
      await safe("ai opt-in", async () => {
        await enableAi(s);
        aiReady = true;
        await sleep(400);
        await closeSettings(s);
        await sleep(600);
      });

      await frame(
        s,
        "11-settings-ai",
        "Settings → Developer → AI: the model rows and their download / " +
          "choose / remove controls.",
        async () => {
          await openSettings(s, "ai");
          await sleep(1200);
        },
      );
      // The Limits topic, where the chat-history budget lives (issue #970,
      // item 3). Its own frame because the unset state of that field is the
      // whole complaint: a blank box with a native stepper and no reading.
      await frame(
        s,
        "11b-ai-limits",
        "Settings → AI → Limits: the chat-history budget field, whose unset " +
          "state names the number it stands for instead of rendering empty.",
        async () => {
          await selectSettingsTopic(s, "ai", "limits");
          await sleep(900);
        },
      );
      await safe("close settings", async () => {
        await closeSettings(s);
        await sleep(500);
      });

      await frame(
        s,
        "05-agent",
        "The agent tab: one screen with the conversation rail beside the " +
          "conversation, and the composer's scope and permission controls under " +
          "the input rather than above it.",
        async () => {
          // RE-RUN the palette action until the pane is up, rather than
          // running it once and waiting. `runPaletteAction` finds the row and
          // clicks it exactly once, and a click that misses leaves nothing to
          // retry — which is the single most common shape behind a timeout
          // that reads like a dead surface (`e2e/AGENTS.md` says so by name,
          // and the first run of this spec photographed the open palette).
          for (let attempt = 0; attempt < 3; attempt++) {
            await runPaletteAction(s, "ai.open-agent-vault", "agent");
            const [pane] = await s.byTestIdAll("agent.pane");
            if (pane !== undefined) break;
            await sleep(1500);
          }
          await s.byTestId("agent.pane", { timeoutMs: 20_000 });
          // The rail loads its roster over IPC after the pane mounts.
          await sleep(1200);
        },
      );

      // ── The graph (lane 0/1: toolbar density, shared Select) ──────────
      await frame(
        s,
        "06-graph",
        "The graph tab: the toolbar's shared Select and its softer edges.",
        async () => {
          // `graph.show`, not `graph.open` — the first run of this spec
          // guessed and the palette matched no row. And the canvas sits
          // behind the app's only `React.lazy` boundary, so the pane mounts
          // several hundred ms before anything is drawn in it.
          await runPaletteAction(s, "graph.show", "graph");
          await s.byTestId("editor.graph-pane", { timeoutMs: 20_000 });
          await sleep(1800);
        },
      );

      // ── A new tab (#772: the start page) ──────────────────────────────
      await frame(
        s,
        "07-new-tab",
        "An empty tab: what the '+' on the tab strip opens.",
        async () => {
          const [plus] = await s.findElements(
            testIdSelector("editor.tab-strip-button", { "aria-label": "New tab" }),
          );
          if (plus === undefined) throw new Error("no New tab button on the strip");
          await plus.click();
          await sleep(900);
        },
      );

      // ── The palette's operator strip (#772: arrows reach the results) ──
      await frame(
        s,
        "08-palette",
        "The command palette with a bare 's' typed: the operator suggestion " +
          "strip above the results.",
        async () => {
          await openPalette(s);
          await (await s.byTestId("palette.input")).sendKeys("s");
          await sleep(700);
        },
      );


      // ── The polish pass (myne-md/myne#970) ────────────────────────────
      //
      // What this section can and cannot photograph is stated here rather than
      // discovered in a PR body. Reachable in this container: the floating
      // toolbar, the customize list, the chat notice, the provider picker and
      // the diagnostics panel. NOT reachable, with the mechanism that blocks a
      // driver rather than an excuse: the Touch ID waiting state (no biometric
      // device in a headless WebKitGTK seat), the agent approval card's footer
      // (needs a model that proposes an edit), and the auto-tag toast (needs the
      // same model). Those three are covered by their unit specs and named in
      // the PR body as not photographed.
      // **The palette frame above leaves the palette OPEN**, and every click
      // below it would land on the overlay: the first run of this block timed
      // out on five frames in a row for exactly that reason, starting with
      // "no editor content node" on a tab that was there. Close it, then put a
      // real note on screen, because the tab left active is the empty start
      // page (frame 07).
      await safe("70: close the palette and open a note", async () => {
        await pressKey(s, KEY.ESCAPE);
        await sleep(300);
        await runPaletteAction(s, "note.new", "new note");
        await s.byTestId("editor.content", { timeoutMs: 15_000 });
        await sleep(600);
      });

      await frame(
        s,
        "70-selection-toolbar",
        "The floating selection toolbar as a fresh vault draws it: block type, the " +
          "four inline marks, highlight, link and export-as-image, grouped and icon-led. " +
          "The list and wikilink controls start switched OFF (they are addable in " +
          "Settings), which is what `71-settings-toolbar` is about.",
        async () => {
          // **`typeIntoEditor`, not a click plus `sendKeys`.** A note created by
          // `note.new` is empty, and since myne-md/myne#945 the promoted title is
          // a `<textarea>` that grows to the wrapped title, so the CENTRE of
          // `.cm-content` falls inside the title field on a short note: the raw
          // click focused the title, the payload became the note's NAME, the
          // body stayed empty, and the selection below was empty too. That is
          // why this frame waited out its budget for a `.cm-toolbar` that was
          // correctly absent. `typeIntoEditor` clicks a body LINE and probes the
          // keystroke pipeline, which is the same lesson its own header records.
          await typeIntoEditor(s, "Selected text for the toolbar.");
          const [content] = await s.findElements(
            testIdSelector("editor.content") + " .cm-content",
          );
          if (content === undefined) throw new Error("no editor content node");
          await content.sendKeys(KEY.HOME);
          await content.sendKeys(KEY.SHIFT + KEY.END);
          await s.waitForElement(".cm-toolbar", { timeoutMs: 20_000 });
          await sleep(600);
        },
      );

      await frame(
        s,
        "71-settings-toolbar",
        "Settings → Editor → Formatting toolbar: every control in the vocabulary " +
          "is a live toggle, and the last visible one refuses to switch off.",
        async () => {
          // **Escape FIRST, in the editor, and never inside the modal.** The
          // selection toolbar from frame 70 is still up and paints over the
          // settings modal, so it has to go; but Escape inside the modal closes
          // the MODAL, which is how the previous version of this frame left
          // `settings.toolbar-customize` stale and took frame 72 down with it.
          await pressKey(s, KEY.ESCAPE);
          await sleep(300);
          await openSettings(s, "editor");
          // The list lives in the panel's `editing` TOPIC, not on the tab's
          // default one, so a bare `openSettings("editor")` photographs a
          // different section entirely.
          await selectSettingsTopic(s, "editor", "editing");
          let list;
          try {
            list = await s.waitForElement(testIdSelector("settings.toolbar-customize"), {
              timeoutMs: 20_000,
            });
          } catch (e) {
            // The list is unconditional in `EditorPanel`'s `editing` topic, so
            // its absence means the topic body rendered something ELSE (or threw).
            // Dump what the modal actually holds rather than re-running blind.
            const ids = await s.execute<string>(
              "return JSON.stringify(Array.from(document.querySelectorAll('[data-testid]'))" +
                ".map(function (n) { return n.getAttribute('data-testid'); })" +
                ".filter(function (v) { return v.indexOf('settings.') === 0; }));",
            );
            console.log(`[ui-pass] 71 settings testids: ${ids}`);
            throw e;
          }
          // **The list sits far below the fold on this topic**, so the frame used
          // to photograph Vim mode and the preview while its caption described a
          // list that was not in the picture. Centring it is what makes the
          // picture match the caption.
          await list.scrollIntoView();
          await sleep(700);
        },
      );

      await frame(
        s,
        "72-ai-chat-notice",
        "The chat panel's privacy notice as one line plus a link to the full text.",
        async () => {
          await closeSettings(s);
          // The palette action, not the right-panel tab. The tab only exists
          // while the rail is OPEN and AI is enabled, and the frame before this
          // one left Settings over the editor: clicking a tab the rail has not
          // drawn is what timed out here, twice, while the panel was fine.
          // `ai.open-chat` is the route `e2e/ai-chat.e2e.ts` takes.
          await openAiChat(s);
          // The notice and its CTA are gated on `ready` (AI on AND a model
          // resolved), which this capture build does not reach: it defines no
          // `local-inference-stub` and has no real model, so the panel opens in
          // its degraded state and the sentence is correctly absent. Recorded as
          // skipped with that reason rather than as a red frame, because the
          // product is behaving and the evidence is what is unavailable here.
          try {
            await s.waitForElement(testIdSelector("ai.honesty-note"), { timeoutMs: 8_000 });
          } catch {
            skipFrame(
              "72-ai-chat-notice",
              "The chat panel's privacy notice as one line plus a link to the full text.",
              "the notice renders only when AI is enabled and no model is degraded; " +
                "this capture build defines no inference stub, so the panel is in its degraded state",
            );
            throw new Error("skip: no ready AI surface in this build");
          }
          await sleep(600);
        },
      );

      await frame(
        s,
        "73-ai-providers",
        "Settings → AI: the provider picker open, showing all four rows, two of " +
          "them the OpenCode products that share one host.",
        async () => {
          await openSettings(s, "ai");
          const trigger = await s.waitForElement(testIdSelector("ai.provider-choice"), {
            timeoutMs: 20_000,
          });
          await trigger.scrollIntoView();
          await trigger.click();
          await s.waitForElement(
            testIdSelector("ai.provider-choice-option", { "data-value": "opencode-go" }),
            { timeoutMs: 10_000 },
          );
          await sleep(400);
        },
      );

      await frame(
        s,
        "74-diagnostics",
        "Settings → Diagnostics: the engine label resolved from the real user agent, " +
          "and the desktop caveat on the storage figures.",
        async () => {
          await openSettings(s, "diagnostics");
          await sleep(1200);
        },
      );
      await safe("close settings", async () => {
        await closeSettings(s);
        await sleep(400);
      });

      // ── The reviewed vault seed (myne-md/myne#915) ────────────────────
      // The card needs the floor of ten live notes, so the frames come last.
      // They are gated on the earlier AI opt-in because the card's own gate
      // reads it: a pass where that step did not land would otherwise report
      // four timeouts for a surface that is correctly absent.
      // The generation frames are best-effort: this capture build does not
      // define `local-inference-stub`, so a run without a real model stops at
      // the scope screen and the candidate frame is skipped rather than
      // failing the pass. The E2E suite runs the same path against the stub.
      if (aiReady) {
      // **Titled, not just created.** `createNote` (the E2E helper) is not
      // available to this spec: it goes through `clickNewItem`, which the merge
      // base this pass also photographs does not have. The palette verb exists on
      // both. Each note then gets a body line, so the note is real content rather
      // than an empty tab and its title is not "Untitled" ten times over. The
      // sidebar collapses identical titles into one row, and a vault whose ten
      // notes render as one row reads as one note to anything counting them.
      await safe("60: ten notes for the card's floor", async () => {
        for (let i = 0; i < 10; i += 1) {
          await runPaletteAction(s, "note.new", "new note");
          await sleep(300);
          await typeIntoEditor(s, `seed note ${i} alpha7k2m9qx4w8e5rj0`);
          await sleep(200);
        }
      });

      await frame(
        s,
        "60-seed-card",
        "The chat zero state's once-only offer: AI on, memory empty, enough notes to distil.",
        async () => {
          await openAiChat(s);
          // Measure the floor rather than assume it: the card's gate is AI on, no
          // degraded model, memory empty AND at least ten live notes, and three of
          // those four are the pass's own doing. A skip that says "the build" when
          // the pass created nine notes sends the next reader to the wrong file.
          const notes = (await s.byTestIdAll("notes.row")).length;
          try {
            await s.byTestId("ai.seed-card", { timeoutMs: 25_000 });
          } catch {
            seedUnavailable =
              `the seed card renders only when AI is on, no model is degraded, memory is ` +
              `empty and the vault holds at least ten live notes; this pass left ${notes} ` +
              `note row(s) on screen and the card did not appear`;
            skipFrame(
              "60-seed-card",
              "The chat zero state's once-only offer: AI on, memory empty, enough notes to distil.",
              seedUnavailable,
            );
            throw new Error("skip: seed card unavailable in this build");
          }
          await sleep(500);
        },
      );

      await frame(
        s,
        "61-seed-scope",
        "Teach Myne your vault, step one: provider, counts, excluded notes and the real payload.",
        async () => {
          // **The Settings door, not the once-only card.** Both open the same
          // wizard, and the card is gated on four things at once (AI on, no
          // degraded model, memory empty, ten live notes) of which the pass only
          // controls two. These three frames are the evidence for the wizard's own
          // surfaces, so they enter through the door that has no such gate:
          // Settings → AI → Advanced → "Teach Myne your vault".
          await openSettings(s, "ai");
          await selectSettingsTopic(s, "ai", "advanced");
          await (await s.byTestId("settings.memory.seed.open", { timeoutMs: 20_000 })).click();
          await s.byTestId("settings.memory.seed.scope", { timeoutMs: 20_000 });
          await (await s.byTestId("settings.memory.seed.toggle-payload")).click();
          await sleep(600);
        },
      );

      await frame(
        s,
        "62-seed-candidates",
        "Step two: the model's three entries, each editable and counted before anything is saved.",
        async () => {
          await (await s.byTestId("settings.memory.seed.continue")).click();
          await s.byTestId("settings.memory.seed.candidate-list", { timeoutMs: 60_000 });
          await sleep(600);
        },
      );

      await frame(
        s,
        "63-seed-memory",
        "The Memory panel after a reviewed seed: the From your vault group and its date, " +
          "with the count reported by a toast instead of a Saved step.",
        async () => {
          await (await s.byTestId("settings.memory.seed.apply")).click();
          // myne-md/myne#970 item 11: the wizard closes on apply and the count
          // is a toast, so the frame waits for the wizard to be GONE rather
          // than for a `done` step that no longer exists.
          await s.waitUntil(
            async () => ((await s.byTestIdAll("settings.memory.seed.scope")).length === 0 ? true : null),
            { label: "the seed wizard to close on apply", timeoutMs: 30_000 },
          );
          await openSettings(s, "ai");
          await selectSettingsTopic(s, "ai", "advanced");
          const group = await s.waitForElement(testIdSelector("settings.memory.seed-group"), {
            timeoutMs: 20_000,
          });
          // The Memory group sits below the fold on this topic, so the frame
          // photographed the toast and left the thing the frame is ABOUT off
          // screen. Centring it is what makes the picture match its caption: the
          // toast is transient, the group and its date are the evidence.
          await group.scrollIntoView();
          await sleep(600);
        },
      );
      }

    } finally {
      // eslint-disable-next-line no-console
      console.log("\n[ui-pass] " + JSON.stringify(frames, null, 2));
      writeFileSync(join(OUT_DIR, "frames.json"), JSON.stringify(frames, null, 2));
      await app.teardown();
    }
  },
  900_000,
);
