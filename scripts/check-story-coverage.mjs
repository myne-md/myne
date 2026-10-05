#!/usr/bin/env node
// check-story-coverage.mjs, a new component or screen may not land without a
// story in the catalogue (myne-md/myne#832).
//
// The failure this prevents: the catalogue exists to make "which screen, which
// state" answerable, and the moment it is allowed to fall behind the tree it
// stops being that. Nothing else would notice, a missing story breaks no
// build, fails no type, and renders nothing.
//
// It is a RATCHET, the shape `check-unwired.mjs` and `check-twin-drift-ratchet.mjs`
// already use: the surfaces without a story today are recorded as DEBT in
// `scripts/story-coverage.json`, and the set may only SHRINK. A new surface with
// no story fails by name. `--record` refuses to write a GROWN debt set, so the
// command the failure message recommends cannot be used to make the failure go
// away: the only way to accept a new surface is to write its story.
//
// Both directions are checked. A debt entry whose surface is now covered, or
// whose file is gone, is STALE and fails, so the record cannot outlive the gap
// it describes (the arm `check-ipc-binding-callers.mjs` learned the hard way).
// A story naming a surface that no longer exists fails too, which is how a
// rename leaves a story pointing at nothing.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The trees whose modules are user-visible surfaces. */
export const SURFACE_ROOTS = ["src/components", "src/screens"];

/** The directory the coverage scan reads story surfaces from. */
export const STORIES_DIR = "stories/src/stories";

/**
 * Modules under a surface root that are NOT surfaces, each with its reason
 * (compared both ways: an entry whose file is gone fails as stale).
 *
 * These are layout and presentation helpers that happen to be `.tsx`: they
 * render no user-facing surface of their own, so a story for them would be a
 * story for a padding constant.
 */
export const NON_SURFACE = Object.freeze({
  centerView:
    "layout helper: centres a child in the stage; renders no surface of its own",
  editorLayout:
    "layout helper: computes editor pane geometry; renders no surface of its own",
  "step-shell":
    "layout helper: the shared chrome around a wizard step, not a step itself",
});

/**
 * Surfaces a story covers that live OUTSIDE the coverage denominator, each with
 * its reason. They are not gated by the ratchet (they are not under a surface
 * root), but a story that declares them must not fail the "story names a surface
 * that does not exist" rule. Compared both ways: the guard fails if one of these
 * has no story any more.
 */
/**
 * @type {Readonly<Record<string, string>>}
 */
export const STORY_ONLY_SURFACES = Object.freeze({
  AiChatTab:
    "the desktop AI chat panel lives under src/notes/components, outside the surface roots; the screenshot harness shoots it from the catalogue (myne-md/myne#832 task 14)",
});

/** Walk a directory recursively for `.tsx` files. */
function walkTsx(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsx(full));
    else if (entry.endsWith(".tsx") && !entry.endsWith(".d.tsx")) out.push(full);
  }
  return out;
}

/** The surface name (module basename) of a `.tsx` path. */
function surfaceName(file) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.replace(/\.tsx$/, "");
}

/**
 * Every surface under the roots, as a Map of name -> first file seen.
 * `index.tsx` is skipped: it is a barrel, not a surface.
 */
export function enumerateSurfaces(rootDir = ROOT, roots = SURFACE_ROOTS) {
  const surfaces = new Map();
  for (const rel of roots) {
    for (const file of walkTsx(join(rootDir, rel))) {
      const name = surfaceName(file);
      if (name === "index") continue;
      if (!surfaces.has(name)) surfaces.set(name, relative(rootDir, file));
    }
  }
  for (const name of Object.keys(NON_SURFACE)) surfaces.delete(name);
  return surfaces;
}

/**
 * The surfaces exactly as the stories declare them, read from the `surface:`
 * field of every descriptor.
 *
 * A regex over the story sources rather than an import: this guard is zero-dep
 * Node and the registry is TSX. Comments are stripped first so an example in a
 * doc comment cannot count as a story.
 */
export function readStorySurfaces(storiesDir) {
  const found = new Map();
  const matches = (src, re) => {
    let m;
    while ((m = re.exec(src)) !== null) found.set(m[1], true);
  };
  for (const file of walkTsx(storiesDir)) {
    const src = stripComments(readFileSync(file, "utf8"));
    matches(src, /surface:\s*"([^"]+)"/g);
  }
  return found;
}

/** Remove line and block comments. String-blind, on purpose: a comment-aware scanner is a scanner with a bypass. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function loadRoster(path) {
  if (!existsSync(path)) return { floor: 0, debt: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The comparison, as a pure function over already-read inputs, so the test can
 * drive it without a real tree.
 */
export function compare({ surfaces, storySurfaces, roster, storyOnly }) {
  const only = storyOnly ?? STORY_ONLY_SURFACES;
  const problems = [];
  const debt = new Set(roster.debt ?? []);

  for (const [name, file] of surfaces) {
    if (storySurfaces.has(name)) {
      if (debt.has(name)) {
        problems.push(
          `"${name}" (${file}) has a story now, but is still recorded as debt in scripts/story-coverage.json. Remove it from "debt".`,
        );
      }
    } else if (!debt.has(name)) {
      problems.push(
        `"${name}" (${file}) has no story and is not recorded as debt. Add a story under ${STORIES_DIR}/, or record it with \`node scripts/check-story-coverage.mjs --record\` if you are baselining an existing gap.`,
      );
    }
  }

  for (const name of debt) {
    if (!surfaces.has(name)) {
      problems.push(
        `scripts/story-coverage.json records debt for "${name}", but no such surface exists under ${SURFACE_ROOTS.join(" or ")}. Remove the stale entry.`,
      );
    }
  }

  for (const name of storySurfaces.keys()) {
    if (!surfaces.has(name) && !(name in only)) {
      problems.push(
        `A story declares surface "${name}", but no such surface exists under ${SURFACE_ROOTS.join(" or ")}. Fix the surface name or the file it refers to.`,
      );
    }
  }

  for (const name of Object.keys(only)) {
    if (!storySurfaces.has(name)) {
      problems.push(
        `story-only surfaces records "${name}" as covered by a story outside the surface roots, but no story declares it. Remove the stale entry.`,
      );
    }
  }

  const floor = roster.floor ?? 0;
  if (surfaces.size < floor) {
    problems.push(
      `Only ${surfaces.size} surfaces were enumerated, below the recorded floor of ${floor}. A scan that covers less than it claims is the failure this guard exists to catch.`,
    );
  }

  return problems;
}

/**
 * What `--record` would write, as a pure function so the spec can drive the
 * refusal without touching a real tree. `refuse` is true when the record exists
 * and the uncovered set has GROWN: the debt may only shrink, so a new surface
 * needs a story rather than a record entry.
 */
export function planRecord({ surfaces, storySurfaces, roster, priorExists }) {
  const uncovered = [...surfaces.keys()].filter((n) => !storySurfaces.has(n)).sort();
  const prior = new Set(roster.debt ?? []);
  const grown = uncovered.filter((n) => !prior.has(n));
  return { uncovered, grown, refuse: priorExists && grown.length > 0 };
}

function main(argv) {
  const rootDir = ROOT;
  const rosterPath = join(rootDir, "scripts/story-coverage.json");
  const record = argv.includes("--record");

  const surfaces = enumerateSurfaces(rootDir);
  const storySurfaces = readStorySurfaces(join(rootDir, STORIES_DIR));
  const roster = loadRoster(rosterPath);

  if (record) {
    const priorExists = existsSync(rosterPath);
    const { uncovered, grown, refuse } = planRecord({
      surfaces,
      storySurfaces,
      roster,
      priorExists,
    });
    if (refuse) {
      console.error(
        `refusing to record a GROWN debt set: ${grown.join(", ")}.\n` +
          `The debt may only shrink. A new surface needs a story, not a record entry.`,
      );
      process.exit(1);
    }
    const next = {
      $comment:
        "Surfaces with no story yet (myne-md/myne#832). DEBT: this set may only SHRINK. Do not add an entry by hand; write the story. `node scripts/check-story-coverage.mjs --record` refuses to grow it.",
      floor: surfaces.size,
      debt: uncovered,
    };
    writeFileSync(rosterPath, JSON.stringify(next, null, 2) + "\n");
    console.log(
      `recorded ${uncovered.length} uncovered of ${surfaces.size} surfaces as debt.`,
    );
    return;
  }

  const problems = compare({ surfaces, storySurfaces, roster });
  const covered = surfaces.size - (roster.debt ?? []).length;
  if (problems.length > 0) {
    console.error("check-story-coverage: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `check-story-coverage: ok (${covered} covered, ${(roster.debt ?? []).length} recorded as debt, ${surfaces.size} surfaces).`,
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) main(process.argv.slice(2));
