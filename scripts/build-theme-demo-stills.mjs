#!/usr/bin/env node
// Turn the captured theme-demo frames into the stills the /themes hero ships.
//
// The hero started as a video (a cross-faded loop of the same frames), and the
// video was replaced by a carousel: the same eight steps, but with a caption per
// step, segments you can click, and a progress line that says how long each step
// holds. A video can promise none of that, and it weighed ~560 KB for an
// autoplaying loop.
//
// So the encoder is now one JPEG per frame, at the hero column's 2x. It still
// lives here rather than in the website repo because the SOURCE is the app: a
// frame is only honest while it comes from a capture, and the capture is
// `e2e/capture/theme-demo.capture.ts`.
//
// JPEG rather than WebP because the ffmpeg this repo's tooling runs on ships no
// WebP encoder (measured: `-encoders` lists none), and adding a dependency to the
// website's build for eight stills would be the wrong trade. At 1040px and q=2 it
// is ~90 KB a frame.
//
// Run: node scripts/build-theme-demo-stills.mjs [--out <dir>]
// Requires ffmpeg on PATH with the mjpeg encoder (checked below: a missing
// encoder fails by name rather than shipping a directory of zero-byte images).

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES_DIR = join(REPO, "e2e", "artifacts", "theme-demo");

/** The hero column is capped at 520 css px; 1040 matches its 2x slot, but the
 *  frames are a 1x render, so the width is a slot match rather than retina. */
const WIDTH = 1040;
/** JPEG quality scale (2 = high, 31 = worst). */
const QUALITY = 2;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OUT_DIR = arg("--out", join(FRAMES_DIR, "out", "stills"));

/** Fail by NAME when the encoder is missing: an empty <img> is silent. */
function requireEncoder(name) {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (!out.includes(name)) {
    throw new Error(`ffmpeg has no ${name} encoder; refusing to write an empty still set`);
  }
}

const frames = readdirSync(FRAMES_DIR)
  .filter((f) => f.endsWith(".png"))
  .sort()
  .map((f) => join(FRAMES_DIR, f));

if (frames.length < 2) {
  throw new Error(
    `need at least two frames in ${FRAMES_DIR} (found ${frames.length}). Run scripts/capture-theme-demo.sh first.`,
  );
}

requireEncoder("mjpeg");
// Empty first: output names are frame POSITIONS, so a re-capture with fewer
// frames would otherwise leave the previous run's higher-numbered JPEGs behind
// and ship a still from an older UI as part of this set.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const written = [];
frames.forEach((frame, i) => {
  const name = `${String(i + 1).padStart(2, "0")}.jpg`;
  const out = join(OUT_DIR, name);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      // Width to 1040, height derived (even), so the aspect ratio cannot drift
      // between a capture whose window changed size and the page's frame box.
      "-i",
      frame,
      "-vf",
      `scale=${WIDTH}:-2:flags=lanczos`,
      "-c:v",
      "mjpeg",
      "-q:v",
      String(QUALITY),
      out,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  written.push({ name, bytes: statSync(out).size });
});

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(
  `[theme-demo] ${written.length} stills → ${OUT_DIR}\n` +
    written.map((w) => `  ${w.name}  ${kb(w.bytes)}`).join("\n") +
    "\n\nPromote into the site:\n" +
    `  cp ${OUT_DIR}/*.jpg ${REPO}/myne-website/public/themes/demo/`,
);
