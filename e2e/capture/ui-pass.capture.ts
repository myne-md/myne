// Screenshot capture for the UI-pass branch (myne-md/myne#772 and its lanes,
// plus the AI surface of myne-md/myne#771).
//
// NOT a test — a CAPTURE tool, the same shape as `userguide.capture.ts` and
// riding the same real-IPC harness. It exists because a UI branch's review
// evidence is pixels, and the only automated seat that can produce them is
// the Linux/webkit2gtk container: tauri-driver has no macOS support
// (`docs/dev/e2e.md`), and capturing on the developer's own machine would
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
  unlockToEditor,
} from "./../support/flows";
import { testIdSelector, type Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "ui-pass");
interface FrameRecord {
  name: string;
  what: string;
  ok: boolean;
  note?: string;
}

const frames: FrameRecord[] = [];

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
  try {
    await build();
    await capture(session, name, what);
  } catch (e) {
    frames.push({ name, what, ok: false, note: String(e).slice(0, 200) });
    // eslint-disable-next-line no-console
    console.warn(`[ui-pass] FAIL ${name} — ${String(e).slice(0, 160)}`);
  }
}

/** Best-effort setup step: richness, never a blocker. */
async function safe(label: string, run: () => Promise<void>): Promise<void> {
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
        "The first step behind 'create a vault'.",
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
      await dismissImporterOffer(s);

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

      // Developer mode, from INSIDE the open modal: `enableDeveloperMode`
      // reaches About by the gear, and clicking the gear again on an open
      // modal is a close rather than an open. The agent tab is behind this
      // switch by decision (`design-notes/ai/0636`).
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
      await safe("ai opt-in", async () => {
        await enableAi(s);
        await sleep(400);
        await closeSettings(s);
        await sleep(600);
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
            '[data-testid="editor.tab-strip-button"][aria-label="New tab"]',
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

    } finally {
      // eslint-disable-next-line no-console
      console.log("\n[ui-pass] " + JSON.stringify(frames, null, 2));
      writeFileSync(join(OUT_DIR, "frames.json"), JSON.stringify(frames, null, 2));
      await app.teardown();
    }
  },
  900_000,
);
