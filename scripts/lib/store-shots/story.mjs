// The story, in the order it is uploaded.
//
// Frame 1 and frame 2 carry the set alone, because most people never scroll past
// the second frame; the continuity across the seams is a flourish for the reader
// who does. That is the discipline the current set's sibling in Teachfluence
// states outright, and it is why frame 1 is the product's strongest single claim
// rather than the widest overview.
//
// `screens` maps a device class to the design-board screen id that depicts the
// frame. The split is not cosmetic: the board's tablet family
// (`mobile/src/ipad/`, prefix `WS`) is a different set of layouts, so a tablet
// frame names a tablet screen and the four phone frames that have no tablet
// counterpart carry `tablet: null`, which is what keeps the two tablet sets at
// six frames instead of promising a layout that does not exist.
//
// Screen ids are checked against what the board ACTUALLY renders before anything
// is captured (`assertStoryResolvable`). A frame pointing at a screen that is not
// on the board is the failure this exists to make loud: it would otherwise write
// an empty plate, and an empty plate in a store listing is invisible until a
// reviewer sees it.
//
// The frame ids are deliberately not the screen ids. A frame is a claim about the
// product; a screen is an implementation of it, and one frame is expected to
// outlive several screens.

export const STORY = [
  { id: "notes", screens: { phone: "05", tablet: "WS-01" } },
  { id: "markdown", screens: { phone: "08", tablet: "ED-03" } },
  // Agent then collaboration, at pages three and four. Two moves landed them here
  // (2026-10-17): up from the end of the set, then in behind `markdown` so they sit
  // directly after it. They are the two claims a screenshot argues worst, so they go
  // early, while a reader is still deciding whether to keep swiping.
  // AG-02 rather than AG-03: the chat frame showed a completed exchange under a
  // `no provider set` header, which is a state the app refuses (with no provider
  // the path is unreachable) and the one privacy claim a phone with no local model
  // cannot make. The provider step is the honest claim, and its caption ("nothing
  // is sent anywhere until you do") is true of exactly this frame.
  { id: "agent", screens: { phone: "AG-02", tablet: null } },
  { id: "collab", screens: { phone: "MB-03", tablet: null } },
  // THE PORTABILITY FRAME IS RETIRED FROM THE SET, and the reason was a claim the
  // phone could not keep. `PT-01`/`PT-02` remain board screens for desktop parity,
  // but on Android the export landed in `Android/data/<pkg>/files/Documents`,
  // which the system Files app refuses to open since API 30, and the share sheet
  // was not implemented, so a frame captioned "a folder you can open in any
  // editor" promised the one thing the app could not do on the store it publishes
  // to. **myne-md/myne#505 removed that blocker** (the system save picker, and a
  // directory export arrives as a `.zip`), so restoring the frame is now a design
  // decision about what the caption should say for a zip rather than a blocked
  // one: the frame cannot show "a folder" on Android as shipped. Re-adding it
  // needs new phone/tablet renders, and the slot counts in `slots.mjs` are checked
  // against this array so the edit cannot be silent.
  { id: "find", screens: { phone: "09", tablet: "SC-02" } },
  { id: "privacy", screens: { phone: "ST-01", tablet: null } },
  { id: "server", screens: { phone: "SY-01", tablet: null } },
];

/**
 * Why the tablet sets carry three frames and not the phone story's full set.
 *
 * The tablet board is genuinely small: `mobile/src/ipad/` renders the three-pane
 * workspace shell (`WS-01`), four editor overlays, and three command overlays, all
 * landscape. It has no notes list of its own, no settings, no account screen, no
 * sync screen, no agent surface and no collaboration surface. So only three
 * frames of this story have a faithful tablet counterpart, and the other five are
 * null rather than pointed at whichever tablet screen looked closest. Pointing
 * `privacy` at a command palette because both are on a big screen would tell a
 * store reviewer that the tablet has an account screen, which it does not.
 *
 * When someone writes tablet variants of the agent and collaboration surfaces,
 * those frames join the tablet sets by filling their `tablet` field and bumping
 * the two tablet slots' `story` counts, and `assertSlotsMatchStory` fails until
 * both are done.
 */

/** Which screen-id key a device class reads. */
export function screenKeyFor(frameClass) {
  if (frameClass === "phone" || frameClass === "tablet") return frameClass;
  throw new Error(`unknown device class "${frameClass}" (expected "phone" or "tablet")`);
}

/** Frames a device class carries, in story order. */
export function storyFor(screenKey) {
  return STORY.map((frame, index) => ({
    id: frame.id,
    index,
    screenId: frame.screens[screenKey],
  })).filter((f) => f.screenId !== null && f.screenId !== undefined);
}

/**
 * Resolve the requested frame ids, defaulting to the whole story for the slot.
 *
 * Id validation lives here and the board check lives in `assertScreensPresent`,
 * because only the browser knows what the board renders. A pure module has no
 * business pretending to.
 */
export function resolveRequested(screenKey, requested) {
  const frames = storyFor(screenKey);
  if (!requested || requested.length === 0) return frames;

  const byId = new Map(frames.map((f) => [f.id, f]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown frame "${unknown[0]}". Frames in story order: ${frames.map((f) => f.id).join(", ")}`,
    );
  }
  return requested.map((id) => byId.get(id));
}

/**
 * Fail by name when a frame's screen is not something the board renders.
 *
 * `boardIds` is read out of the running page, so this catches a typo and a screen
 * that was renamed or removed underneath the story. The failure it prevents is an
 * empty plate: a capture that cannot find its screen would otherwise write a
 * correctly-sized PNG with nothing in it, which no store rejects and no test
 * notices.
 */
export function assertScreensPresent(frames, boardIds) {
  const known = new Set(boardIds);
  const missing = frames.filter((f) => !known.has(f.screenId));
  if (missing.length > 0) {
    throw new Error(
      "the board does not render a screen this story names: " +
        missing.map((f) => `"${f.id}" wants screen "${f.screenId}"`).join("; "),
    );
  }
  return frames;
}

/** The device class a slot renders from. */
export function deviceClassFor(slot) {
  return slot.frame === "ios" || slot.frame === "android" ? "phone" : "tablet";
}
