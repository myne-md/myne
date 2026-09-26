#!/usr/bin/env node
// Guard: the motion canon, mechanised (epic myne-md/myne#772; the normative
// statement is `PRODUCT.md` principle 4 + `design-notes/ui/0618`).
//
// The failure this prevents: `0615` splits motion into a restrained default and
// an opt-in expressive tier, and a split held by intention alone regresses to
// whatever the last author felt like. Every rule below is invisible to the
// compiler, to eslint and to every test in this tree — a pulsing badge, an
// `ease-in` entrance and a 600ms hover all typecheck, render, and pass.
//
// The four rules, and why each is a rule rather than a preference:
//
//   1. `ease-in` as an entering/exiting curve. It is slow where the user is
//      watching hardest — the first frames — so the element reads as late even
//      when the duration is right. Measured at ZERO across every shared tree
//      when this guard landed, so it starts as a hard gate rather than a
//      ratchet: there is no debt to grandfather.
//
//   2. `infinite` outside a NAMED allowlist. This is principle 4's surviving
//      clause and the one the amendment deliberately did not widen: a repeal
//      broad enough to license a decorative loop is broad enough to license the
//      pulsing sync badge the principle was written against. Two kinds are
//      admitted and they are listed one by one, with the reason, below.
//
//   3. A raw duration literal above the 300ms UI ceiling. `--duration-slower`
//      (380ms) is the exemption and is a TOKEN precisely so that using it is a
//      visible act a reviewer can question, where `620ms` inline is not.
//
//   4. A transition on a layout-triggering property. `height`, `width`, `top`,
//      `left`, `margin` and `padding` lay out and paint on every frame;
//      `transform` and `opacity` are compositor-only. This is the rule that
//      turns a smooth animation on the maintainer's laptop into a stuttering
//      one on a five-year-old phone, and nothing else in the tree measures it.
//
// Scope is the shared-tree roster (`scripts/lib/shared-roots.mjs`), imported
// rather than copied — a private copy is how `check-prefs-nonce.mjs` came to
// print `ok` over a whole client it had never read.
//
// VERIFYING THIS GUARD MEANS BREAKING IT. Each rule's fixture lives in
// `tests/scripts/motionCanon.test.ts`, which injects the exact defect and
// asserts this file names it. A guard that has never failed is untested.
//
// Run by hand:   node scripts/check-motion-canon.mjs
// Wired into:    lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Animations permitted to run `infinite`, by keyframe name, each with the
 * reason it is not decoration.
 *
 * Compared BOTH ways: an entry whose animation no longer exists fails as stale,
 * so this list cannot outlive the thing it excuses. That direction is the one
 * nobody thinks to check, and it is how an allowlist quietly becomes a licence
 * for a name somebody reuses later.
 */
const INFINITE_ALLOWLIST = new Map([
  [
    "myne-spinner-rotate",
    "The <Spinner> primitive. Indeterminate progress: the motion IS the message, " +
      "and MYND-630 records that freezing it reads as hung rather than as calm.",
  ],
  [
    "cm-attachment-progress-indeterminate",
    "The attachment upload/download bar. A sweeping accent segment reporting that " +
      "work is in flight — indeterminate progress, not decoration.",
  ],
  [
    "myne-skeleton-sweep",
    "The loading skeleton's shimmer. Indeterminate progress in the same sense as the " +
      "three below: it reports that work is in flight and STOPS when the work does, " +
      "because the element is replaced by the content it was standing in for. Carries " +
      "data-motion=\"essential\", so reduced motion slows it rather than freezing a grey " +
      "box the user has no way to interpret.",
  ],
  [
    "cm-attachment-transcript-pulse",
    "The transcription busy meter. Same class as the two above; it animates " +
      "transform (not height, since myne-md/myne#773) and carries data-motion=\"essential\".",
  ],
]);

/**
 * One-shot animations permitted to run past the 300ms ceiling, keyed by
 * `<relative path>:<keyframe name>`, each with the reason.
 *
 * Deliberately NOT a place to park debt: an entry here says "this duration is
 * correct", not "we have not got to it yet". A slow transition that somebody
 * means to fix belongs in the issue that will fix it, because an excuse written
 * into a guard outlives every intention to remove it.
 */
const DURATION_EXEMPT = new Map([
  [
    "src/styles/tokens.css:settings-search-flash",
    "A locate flash, not a transition: Settings search scrolls a matched row into " +
      "view and flashes it so the eye can find where it landed. The duration has to " +
      "outlast the saccade to the target plus a beat to register it, which is why it " +
      "is ~4x a UI transition. It fires once, on an explicit user search, and its " +
      "reduced-motion arm removes it entirely rather than slowing it.",
  ],
]);

/**
 * Files permitted to run a CONTINUOUS `requestAnimationFrame` loop, each with
 * the reason it is not decoration.
 *
 * Rule 2 catches a CSS `animation: … infinite`. It cannot see a rAF loop, which
 * is the same thing written in JavaScript and is how the most expensive
 * animations in this tree are actually driven — so the canon's claim that no
 * unnamed loop survives was true of stylesheets and false of the code, until
 * this list existed.
 *
 * Compared both ways: an entry whose file no longer loops fails as stale.
 */
const RAF_LOOP_ALLOWLIST = new Map([
  [
    "client-core/src/binaryField.ts",
    "The brand 01 field behind an empty state (design-notes/ui/0616, named exemption). " +
      "Pauses on document.hidden and off-screen, paints one static frame under reduced " +
      "motion, and a process-wide budget caps concurrent instances.",
  ],
  [
    "src/notes/components/PaneView.tsx",
    "Scroll restoration after a pane swap: it waits for the editor's height to settle " +
      "across two equal frames, then applies and RETURNS. A 90-frame budget bounds the " +
      "case that never settles (a short note in a filling body), so it terminates either " +
      "way — a bounded computation being watched, not an animation.",
  ],
  [
    "src/notes/components/useDragAutoScroll.ts",
    "Drag auto-scroll: it runs only for the duration of a drag gesture and is cancelled " +
      "by `stop`, which is wired to `dragend` and `drop` on the window as well as to " +
      "unmount. Bounded by a gesture the user is actively performing, which is the " +
      "clearest case of motion the user is driving rather than motion playing at them.",
  ],
  [
    "editor/src/host/notes/GraphCanvas.tsx",
    "The knowledge-graph force simulation. It runs while the layout is settling and stops " +
      "itself when it does (design-notes/ui/0600) — a bounded computation being drawn, " +
      "not an animation being looped.",
  ],
]);

/** Properties whose transition lays out and paints on every frame. */
const LAYOUT_PROPS = [
  "height",
  "width",
  "top",
  "left",
  "right",
  "bottom",
  "margin",
  "padding",
];

/**
 * Sites where a layout-property transition is a deliberate, reasoned choice.
 * Key is `<relative path>:<property>`; the value is the reason.
 *
 * What this rule is really hunting is the HOT case — a property written many
 * times a second, where laying out the row on each write is the difference
 * between smooth on a laptop and stuttering on an old phone. It found exactly
 * one when it landed, and it was the worst one available: the voice-recording
 * waveform, whose `setLevel` runs at audio rate across every bar in the meter
 * (now `transform: scaleY`, myne-md/myne#773).
 *
 * Everything below is the COLD case: a value written a handful of times over a
 * whole interaction, where the layout cost is real but unmeasurable, and where
 * the transform rewrite would cost something visible. Each says which.
 *
 * The guard still asks the question at every site, which is the point — a new
 * `transition: width` has to be argued for rather than merely typed — and a
 * stale entry fails, so an exemption cannot outlive the line it excuses.
 */
const LAYOUT_EXEMPT = new Map([
  [
    "src/components/attachments/AttachmentSyncProgress.tsx:width",
    "A determinate progress fill, advanced from IO callbacks a few times a second " +
      "rather than per frame. `transform: scaleX` is the usual rewrite and is not free " +
      "here: the bar is pill-radiused, and scaling a pill horizontally stretches its " +
      "end caps into ellipses.",
  ],
  [
    "src/components/export/VaultExportModal.tsx:width",
    "Determinate export progress, same shape and same pill-radius caveat as the " +
      "attachment bar above. Advanced once per exported note, not per frame.",
  ],
  [
    "src/notes/import/ObsidianImportModal.tsx:width",
    "Determinate import progress, same shape as the two above. It also has an " +
      "indeterminate `preparing` state pinned at 30%, which is a single width change " +
      "rather than an animation.",
  ],
  [
    "src/components/primitives/ResizeHandle.tsx:width",
    "The handle's grab bar thickens on hover/drag. It is 2-4px wide, so `scaleX` from " +
      "such a small base visibly softens the edge, and the transition fires once per " +
      "pointer-enter rather than continuously.",
  ],
  [
    "mobile/src/app/flows/EditorFlow.tsx:width",
    "The sidebar collapse (248px <-> 0). This is the case a transform genuinely cannot " +
      "express: the editor beside it must REFLOW into the reclaimed space, and a " +
      "translated sidebar would slide over or under the editor instead of pushing it. " +
      "Fires once per collapse toggle. Covers both the outer width animation and the " +
      "inner pane's matching one, which must stay in lockstep or the divider detaches " +
      "from the edge mid-travel.",
  ],
]);

const SCAN_EXT = new Set([".ts", ".tsx", ".css"]);

/**
 * Strip comments so prose about a rule never trips the rule — while PRESERVING
 * the line count, which is not a detail. Replacing a block comment with a
 * single space collapses it, and every line number after it in the file shifts
 * up by however many lines that comment was. The first version of this guard
 * did exactly that and reported four findings at four line numbers, none of
 * which pointed at the code it had found: in a repo whose comment blocks
 * routinely run twenty lines, the offsets were enormous. A guard that names the
 * wrong line sends the reader to innocent code and costs more than saying
 * nothing.
 */
function scrub(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (SCAN_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
      // Test files are skipped: a fixture asserting a violation is not one.
      if (/\.(test|spec)\.[tj]sx?$/.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out every `@media (prefers-reduced-motion: reduce) { … }` block,
 * preserving line count (see {@link scrub}). Brace-counting rather than a
 * regex, because these blocks nest rule bodies inside them.
 */
function maskReducedMotionBlocks(src) {
  const open = /@media[^{]*prefers-reduced-motion[^{]*\{/g;
  let out = src;
  let m;
  while ((m = open.exec(out)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < out.length && depth > 0) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      i++;
    }
    const start = m.index;
    const blanked = out.slice(start, i).replace(/[^\n]/g, " ");
    out = out.slice(0, start) + blanked + out.slice(i);
    open.lastIndex = i;
  }
  return out;
}


/**
 * Read the VALUE of a `transition:` / `animation:` declaration starting just
 * after its colon, in either syntax this repo writes motion in.
 *
 * This exists because the first version of the guard used one character class
 * (`[^;"'`\n]*`) for both, and a class that excludes quotes stops dead at the
 * opening quote of `{ transition: "opacity 620ms ease" }`. The captured value
 * was therefore EMPTY for every inline style object in the tree — which is how
 * most of this codebase writes motion — so rules 3 and 4 were scanning CSS
 * files only while the success line claimed eight shared trees. Injection
 * caught it; running the guard never would have, because a guard reading an
 * empty string finds nothing wrong with it.
 *
 * CSS:  `transition: opacity 200ms ease;`   -> ends at `;`, `}` or newline.
 * JS:   `transition: "opacity 200ms ease",` -> ends at the matching quote, so a
 *       trailing `, nextProp: 400` cannot be swallowed and reported as part of
 *       this declaration.
 */
function declValue(src, start) {
  let i = start;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  const q = src[i];
  if (q === '"' || q === "'" || q === "`") {
    const end = src.indexOf(q, i + 1);
    return end === -1 ? "" : src.slice(i + 1, end);
  }
  let end = i;
  while (end < src.length && !";}\n".includes(src[end])) end++;
  return src.slice(i, end);
}

const findings = [];
const seenInfinite = new Set();
const usedDurationExempt = new Set();
const usedLayoutExempt = new Set();
const seenRafLoop = new Set();

const { present, missing } = presentSharedRoots(ROOT);
if (missing.length > 0) {
  console.error(
    `motion-canon: shared root(s) on the roster but absent from this checkout: ${missing.join(", ")}\n` +
      "  That is a broken checkout, not a smaller walk. Refusing to report ok over a tree I could not read.",
  );
  process.exit(1);
}

for (const root of present) {
  const files = await walk(join(ROOT, root), []);
  for (const file of files) {
    const rel = relative(ROOT, file);
    const src = scrub(readFileSync(file, "utf8"));

    // -- Rule 1: ease-in as a curve -----------------------------------------
    // `(?!-out)` is the whole subtlety: `ease-in-out` is a legitimate curve for
    // a looping indicator that returns to where it started.
    for (const m of src.matchAll(/\bease-in\b(?!-out)/g)) {
      findings.push({
        rel,
        rule: "ease-in",
        detail:
          "`ease-in` on a UI entrance or exit. It is slowest in the first frames, " +
          "which is exactly when the user is watching, so the element reads as late. " +
          "Use `--ease-out`, `--ease-standard` or `--ease-emphasized`.",
        line: lineOf(src, m.index),
      });
    }

    // -- Rule 2: infinite outside the allowlist -----------------------------
    const flaggedInfinite = new Set();
    for (const m of src.matchAll(
      /animation(?:-name)?\s*:\s*["'`]?\s*([A-Za-z_][\w-]*)[^;}\n]*?\binfinite\b/g,
    )) {
      const name = m[1];
      seenInfinite.add(name);
      if (!INFINITE_ALLOWLIST.has(name)) {
        // Rule 3 skips this declaration: a non-allowlisted loop is already one
        // finding, and reporting its period as a second "over the ceiling" sends
        // the reader to fix a duration on an animation that should not exist.
        flaggedInfinite.add(name);
        findings.push({
          rel,
          rule: "infinite",
          detail:
            `\`${name}\` loops forever and is not on the allowlist in this guard. ` +
            "PRODUCT.md principle 4 admits no pulsing state indicator, no marching ants " +
            "and no looping decoration, in EITHER motion tier. If this reports work in " +
            "flight it is indeterminate progress: add it to INFINITE_ALLOWLIST with the " +
            "reason, and give the element `data-motion=\"essential\"` so reduced motion " +
            "slows it rather than freezing it (MYND-630).",
          line: lineOf(src, m.index),
        });
      }
    }

    // -- Rule 3: a raw duration above the 300ms ceiling ---------------------
    // A `prefers-reduced-motion` block is masked out first, and that is a
    // correctness fix rather than a convenience. Durations inside one are
    // SLOW-DOWNS — MYND-630's 1600ms spinner and the 2.4s progress sweep exist
    // precisely so state-carrying motion stays legible without flickering. They
    // are the canon being kept, so flagging them had the guard pointing at its
    // own rule as a violation of itself.
    const noReduced = maskReducedMotionBlocks(src);
    // Only inside an `animation`/`transition` declaration; a `setTimeout(600)`
    // is not motion. An allowlisted infinite animation states its own period
    // (a 2.4s sweep is a slow sweep, not a slow transition), so those lines are
    // exempt by construction.
    for (const m of noReduced.matchAll(
      /\b(?:transition|animation)(?:-duration)?\s*:/g,
    )) {
      const decl = declValue(noReduced, m.index + m[0].length);
      if ([...INFINITE_ALLOWLIST.keys()].some((n) => decl.includes(n))) continue;
      if ([...flaggedInfinite].some((n) => decl.includes(n))) continue;
      const exemptKey = [...DURATION_EXEMPT.keys()].find(
        (k) => k.startsWith(`${rel}:`) && decl.includes(k.slice(rel.length + 1)),
      );
      if (exemptKey !== undefined) {
        usedDurationExempt.add(exemptKey);
        continue;
      }
      for (const d of decl.matchAll(/(\d+(?:\.\d+)?)m?s\b/g)) {
        const ms = d[0].endsWith("ms") ? parseFloat(d[1]) : parseFloat(d[1]) * 1000;
        if (ms > 300) {
          findings.push({
            rel,
            rule: "duration",
            detail:
              `${d[0]} exceeds the 300ms UI ceiling. If this is a large surface or a ` +
              "shared-element travel, use `var(--duration-slower)` (380ms) — it is a " +
              "token so that reaching for it is a visible act. Anything longer needs a " +
              "reason in `design-notes/ui/`.",
            line: lineOf(src, m.index),
          });
        }
      }
    }

    // -- Rule 5: a self-rescheduling requestAnimationFrame loop -------------
    // The tell is a rAF whose callback re-schedules ITSELF: the call sits
    // INSIDE the scheduled function's own body. That last clause is the whole
    // rule and the first version of it was missing — it only checked that the
    // function was declared earlier in the file, which made every
    // schedule-once-from-a-handler shape a false positive. Two shipped
    // examples: `image-zoom-controller.ts`'s `render`, which sets `raf = 0` and
    // returns, scheduled from a separate `schedule()`; and `widgets.ts`'s
    // `paint`, scheduled from a pointermove handler. Both are one-shot
    // coalescers, the opposite of a loop, and a guard that flags them teaches
    // people to allowlist reflexively.
    const rafLoopsHere = new Set();
    for (const m of src.matchAll(/requestAnimationFrame\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const fn = m[1];
      const decl = new RegExp(
        `(?:function\\s+${fn}\\s*\\(|(?:const|let|var)\\s+${fn}\\s*(?::[^=]*)?=)`,
      ).exec(src);
      if (decl === null) continue;
      const open = src.indexOf("{", decl.index);
      if (open === -1) continue;
      // Brace-match the body so "inside" means inside, not merely after.
      let depth = 1;
      let i = open + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      if (m.index < open || m.index > i) continue;
      if (rafLoopsHere.has(fn)) continue; // one finding per function, not per call
      rafLoopsHere.add(fn);
      seenRafLoop.add(rel);
      if (RAF_LOOP_ALLOWLIST.has(rel)) continue;
      findings.push({
        rel,
        rule: "raf-loop",
        detail:
          `\`${fn}\` re-schedules itself through requestAnimationFrame — a continuous ` +
          "loop, which PRODUCT.md principle 4 forbids as decoration in either motion tier. " +
          "If it reports work in flight, or stops itself when a bounded computation or a " +
          "gesture ends, add it to RAF_LOOP_ALLOWLIST with the reason — and make sure it " +
          "pauses on document.hidden and off-screen and does not loop under " +
          "prefers-reduced-motion (design-notes/ui/0616).",
        line: lineOf(src, m.index),
      });
    }

    // -- Rule 4: transitioning a layout property ----------------------------
    for (const m of src.matchAll(/\btransition(?:-property)?\s*:/g)) {
      const decl = declValue(src, m.index + m[0].length);
      for (const prop of LAYOUT_PROPS) {
        const re = new RegExp(`(^|[\\s,"'\`])${prop}(\\s|,|$)`);
        if (!re.test(decl)) continue;
        if (LAYOUT_EXEMPT.has(`${rel}:${prop}`)) {
          usedLayoutExempt.add(`${rel}:${prop}`);
          continue;
        }
        findings.push({
          rel,
          rule: "layout-property",
          detail:
            `transitions \`${prop}\`, which lays out and paints every frame. Use ` +
            "`transform` (translate/scale) or `opacity`, which the compositor can run " +
            "off the main thread. Where the surrounding rows genuinely must move and " +
            "there is no transform equivalent, record it in LAYOUT_EXEMPT with the reason.",
          line: lineOf(src, m.index),
        });
      }
    }
  }
}

// -- Stale allowlist entries -------------------------------------------------
for (const [name, reason] of INFINITE_ALLOWLIST) {
  if (!seenInfinite.has(name)) {
    findings.push({
      rel: "scripts/check-motion-canon.mjs",
      rule: "stale-allowlist",
      detail:
        `INFINITE_ALLOWLIST excuses \`${name}\`, which no longer runs infinite anywhere ` +
        `in the scanned trees. Remove the entry — an allowlist that outlives what it ` +
        `excused is a licence waiting for somebody to reuse the name. (Reason on file: ${reason})`,
      line: 0,
    });
  }
}

for (const [key, reason] of DURATION_EXEMPT) {
  if (!usedDurationExempt.has(key)) {
    findings.push({
      rel: "scripts/check-motion-canon.mjs",
      rule: "stale-exempt",
      detail:
        `DURATION_EXEMPT excuses \`${key}\`, which no longer exceeds the ceiling (or ` +
        `no longer exists). Remove the entry, for the reason the infinite allowlist ` +
        `states: an excuse that outlives what it excused is a licence nobody audited. ` +
        `(Reason on file: ${reason})`,
      line: 0,
    });
  }
}

for (const [rel, reason] of RAF_LOOP_ALLOWLIST) {
  if (!seenRafLoop.has(rel)) {
    findings.push({
      rel: "scripts/check-motion-canon.mjs",
      rule: "stale-allowlist",
      detail:
        `RAF_LOOP_ALLOWLIST excuses \`${rel}\`, which no longer runs a self-rescheduling ` +
        `requestAnimationFrame loop (or no longer exists). Remove the entry. ` +
        `(Reason on file: ${reason})`,
      line: 0,
    });
  }
}

for (const [key, reason] of LAYOUT_EXEMPT) {
  if (!usedLayoutExempt.has(key)) {
    findings.push({
      rel: "scripts/check-motion-canon.mjs",
      rule: "stale-exempt",
      detail:
        `LAYOUT_EXEMPT excuses \`${key}\`, which no longer transitions that property ` +
        `(or no longer exists). Remove the entry. This arm was itself missing until an ` +
        `injection went looking for it, while the list's own doc already claimed a stale ` +
        `entry would fail — which is the shape of every exemption that quietly becomes a ` +
        `licence. (Reason on file: ${reason})`,
      line: 0,
    });
  }
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

if (findings.length > 0) {
  console.error("motion-canon: the canon is not being kept.\n");
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}  [${f.rule}]`);
    console.error(`      ${f.detail}\n`);
  }
  console.error(
    "  Normative: PRODUCT.md principle 4 and design-notes/ui/0618.\n" +
      "  These are not style preferences; each one is a defect a user can feel.\n",
  );
  process.exit(1);
}

console.error(
  `motion-canon: ok (${present.length} shared tree(s); ` +
    `${INFINITE_ALLOWLIST.size} reasoned infinite animation(s), ` +
    `${RAF_LOOP_ALLOWLIST.size} reasoned rAF loop(s))`,
);
