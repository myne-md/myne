#!/usr/bin/env node
// Capture the story catalogue as PNGs, one per story × palette × viewport.
//
// **Why this exists, and why it is not the user-guide pass.** `e2e/capture/*`
// rides tauri-driver, which has no macOS support, so on this machine every
// screenshot of a changed surface had to be taken by hand or not at all. The
// story catalogue renders the same components from the same `src/` tree with
// fixture data and no vault, and it runs in a browser, so it captures anywhere.
// That makes it the lane for a PULL REQUEST's evidence: every changed surface,
// in both palettes, at a desktop and a phone width (myne-md/myne#1073).
//
// It is a capture and not a test. It asserts nothing about what it saw, so it
// never goes red on a design change; the gates that judge a story are
// `pnpm stories:test` and `check-story-*`.
//
// Usage:
//   node scripts/capture-stories.mjs --stories attachments/library,home/home
//   node scripts/capture-stories.mjs --all --themes light,dark --viewports desktop-1280,mobile-390
//   node scripts/capture-stories.mjs --list          # every id this build offers
//
// Everything it writes goes to `--out` (default `dist-stories/`, gitignored) and
// it prints the manifest path. A story id is the fragment the catalogue uses, so
// a link from an issue and a capture of it name the same thing.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// **Playwright is resolved from the mobile client, which is its only owner.**
// Adding a second copy at the root would give the repository two versions to
// keep in step for one script, and the version that matters here is the one the
// `mobile-flow-logic` lane already pins.
const requireFromMobile = createRequire(join(repoRoot, "mobile/package.json"));
const { chromium } = requireFromMobile("@playwright/test");

const PORT = 1423;
const BASE = `http://localhost:${PORT}`;
const DEFAULT_THEMES = ["light", "dark"];
const DEFAULT_VIEWPORTS = ["desktop-1280", "mobile-390"];

function parseArgs(argv) {
  const out = {
    stories: null,
    themes: DEFAULT_THEMES,
    viewports: DEFAULT_VIEWPORTS,
    out: join(repoRoot, "dist-stories"),
    server: true,
    list: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1];
    if (arg === "--all") out.stories = "all";
    else if (arg === "--stories") out.stories = next().split(",").map((s) => s.trim()).filter(Boolean), (i += 1);
    else if (arg === "--themes") out.themes = next().split(","), (i += 1);
    else if (arg === "--viewports") out.viewports = next().split(","), (i += 1);
    else if (arg === "--out") out.out = resolve(next()), (i += 1);
    else if (arg === "--no-server") out.server = false;
    else if (arg === "--list") out.list = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "capture-stories: --stories <id,id> | --all [--themes light,dark] " +
          "[--viewports desktop-1280,mobile-390] [--out DIR] [--no-server]",
      );
      process.exit(0);
    }
  }
  return out;
}

async function waitForServer(url, timeoutMs = 120_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`the story catalogue did not answer on ${url} within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function startServer() {
  // The catalogue's own dev server. `--strictPort` would refuse to start rather
  // than silently capture a DIFFERENT app that happens to hold the port, which
  // is the failure mode that would make every image a picture of the wrong tree.
  const child = spawn(
    "node_modules/.bin/vite",
    ["--config", "stories/vite.config.ts", "--port", String(PORT), "--strictPort"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) process.stderr.write(log);
  });
  return child;
}

/** Every story id the rail offers, read from the DOM rather than a second registry. */
async function allStoryIds(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-story-id]", { timeout: 60_000 });
  const ids = await page.$$eval("[data-story-id]", (els) =>
    [...new Set(els.map((el) => el.getAttribute("data-story-id")))].filter(Boolean),
  );
  return ids.sort();
}

/**
 * The fragment for one combination.
 *
 * `viewport` is the catalogue's own axis: it pins the story's width to that
 * device's, which is what makes a phone image comparable across stories instead
 * of whatever the browser window happened to be.
 */
function fragmentFor(storyId, theme, viewport) {
  return `#${storyId}?theme=${theme}&viewport=${viewport}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    const server = args.server ? startServer() : null;
    try {
      await waitForServer(BASE);
      const browser = await chromium.launch();
      const page = await browser.newPage();
      for (const id of await allStoryIds(page)) console.log(id);
      await browser.close();
    } finally {
      if (server) server.kill("SIGTERM");
    }
    return;
  }
  if (args.stories === null) {
    console.error("capture-stories: name the surfaces with --stories <id,id>, or --all");
    process.exit(2);
  }

  const server = args.server ? startServer() : null;
  let browser = null;
  try {
    await waitForServer(BASE);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

    const ids = args.stories === "all" ? await allStoryIds(page) : args.stories;
    const written = [];
    for (const storyId of ids) {
      for (const theme of args.themes) {
        for (const viewport of args.viewports) {
          await page.goto(`${BASE}/${fragmentFor(storyId, theme, viewport)}`, {
            waitUntil: "networkidle",
          });
          // The stage carries the id it is showing, so a fragment that failed to
          // resolve is caught here rather than captured as somebody else's story.
          const stage = page.locator(
            `[data-testid="stories.stage"][data-story-id="${storyId}"]`,
          );
          await stage.waitFor({ timeout: 30_000 });
          // **The story's own box, not the stage's.** The stage is as wide as the
          // window, so a `mobile-390` capture of it was a 1300-pixel image with a
          // 360-pixel column in it: the frame a reviewer compares across stories
          // is the story's, and the axis applies to that.
          const frame = stage.locator('[data-testid="stories.story"]');
          const name = `${storyId.replace(/\//g, "__")}--${theme}--${viewport}.png`;
          const path = join(args.out, name);
          await mkdir(dirname(path), { recursive: true });
          await frame.screenshot({ path });
          written.push({ storyId, theme, viewport, path });
          console.log(`captured ${storyId} ${theme} ${viewport}`);
        }
      }
    }

    const manifest = join(args.out, "manifest.json");
    await writeFile(
      manifest,
      `${JSON.stringify({ capturedAt: new Date().toISOString(), images: written }, null, 2)}\n`,
    );
    console.log(`\n${written.length} image(s) in ${args.out}\nmanifest: ${manifest}`);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill("SIGTERM");
  }
}

await main();
