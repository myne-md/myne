// The plan a capture run executes: which sets, which frames, where the bytes go.
//
// This module is the whole decision surface of a run, and it is deliberately
// pure: it reads the story, the slot table and the caption file, checks them
// against each other, and returns plain data. The browser half
// (`mobile/tests/store-shots/store-shots.spec.ts`) receives that data and makes
// no decision of its own beyond measuring the device frame it was pointed at.
//
// Every failure here fails BY NAME, before a browser is opened. The shapes worth
// naming, in the order they would otherwise bite:
//
//   - an unknown set or frame id, which would otherwise crash inside the
//     browser half and read as a Playwright problem rather than a typo;
//   - a frame with no caption, and a caption with no frame, checked BOTH ways,
//     because a missing caption writes a plate with a hole in it and an orphaned
//     caption is a frame somebody deleted without finishing the job;
//   - a slot claiming a story length its device class does not have, which is
//     how the two tablet sets would quietly start promising frames whose tablet
//     layout does not exist.

import { readFileSync } from "node:fs";
import { SLOTS, slotOf, assertSlotArithmetic, assertProducible, toggleLabelFor, frameFilename } from "./slots.mjs";
import { STORY, storyFor, deviceClassFor, resolveRequested } from "./story.mjs";

const CAPTIONS = JSON.parse(
  readFileSync(new URL("./captions.en.json", import.meta.url), "utf8"),
);

/** Caption copy for a frame, failing by name. */
export function captionFor(frameId) {
  const caption = CAPTIONS[frameId];
  const complete =
    caption &&
    caption.headline &&
    caption.sub &&
    caption.eyebrow &&
    Array.isArray(caption.cards) &&
    caption.cards.length > 0;
  if (!complete) {
    throw new Error(
      `no caption for frame "${frameId}" in captions.en.json. Frames: ${STORY.map((f) => f.id).join(", ")}`,
    );
  }
  return caption;
}

/** Captions with no frame behind them. The reverse direction of the check above. */
export function orphanedCaptions() {
  const known = new Set(STORY.map((f) => f.id));
  return Object.keys(CAPTIONS)
    .filter((k) => !k.startsWith("$"))
    .filter((k) => !known.has(k));
}

/**
 * Check the slot table against the story before anything runs.
 *
 * `slot.story` is a count, and a count is exactly the kind of claim that drifts:
 * adding a frame to the story without deciding whether the tablet sets carry it
 * would otherwise leave the tablet sets silently short.
 */
export function assertSlotsMatchStory() {
  const orphans = orphanedCaptions();
  if (orphans.length > 0) {
    throw new Error(
      `captions.en.json has entries with no frame in the story: ${orphans.join(", ")}`,
    );
  }
  for (const slot of Object.values(SLOTS)) {
    // The graphic is a one-frame landscape plate with its own layout, so the
    // device story's length is not a claim it makes.
    if (slot.layout === "graphic") continue;
    const deviceClass = deviceClassFor(slot);
    const available = storyFor(deviceClass).length;
    if (slot.story !== available) {
      throw new Error(
        `slot "${slot.id}" claims a ${slot.story}-frame story but the ${deviceClass} board carries ${available} frames`,
      );
    }
  }
}

/**
 * Build the run plan.
 *
 * `outDirFor(slot)` is injected rather than hard-coded so the default roots live
 * in the CLI (where the repository layout is known) and a test can point the
 * whole thing at a temporary directory.
 */
export function buildPlan({ sets, frames, outDirFor }) {
  assertSlotsMatchStory();

  const resolvedSets = (sets && sets.length > 0 ? sets : [Object.keys(SLOTS)[0]]).map((id) =>
    assertProducible(assertSlotArithmetic(slotOf(id))),
  );

  const slots = resolvedSets.map((slot) => {
    const deviceClass = deviceClassFor(slot);
    // Validates the requested frame ids against the story, failing by name. A
    // slot with its own frame list (the graphic) ignores `--frames`: it is one
    // frame by definition, and letting a flag change that would produce several
    // files fighting over one store-assigned name.
    const chosen = resolveRequested(deviceClass, slot.frames ?? frames);

    return {
      slot,
      deviceClass,
      /** Which board toggle shows this set's chrome. */
      toggle: toggleLabelFor(slot.frame),
      frames: chosen.map((f) => ({
        id: f.id,
        index: f.index,
        screenId: f.screenId,
        caption: captionFor(f.id),
        filename: frameFilename(slot, f.index, f.id),
        out: outDirFor(slot),
      })),
    };
  });

  return { slots };
}

/** A one-line summary for the CLI to print before it launches a browser. */
export function describePlan(plan) {
  const bits = plan.slots.map(
    (s) =>
      `${s.slot.id} (${s.slot.width}x${s.slot.height}, ${s.slot.frame} chrome): ${s.frames.length} frame(s)`,
  );
  return bits.join("\n");
}
