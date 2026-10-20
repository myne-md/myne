// App Store / Play / F-Droid slot geometry.
//
// One entry per output set. `width`/`height` are the PIXELS the store reads;
// `viewport` is the same area in CSS pixels and `scale` is the device scale
// factor that multiplies one into the other. They are not free choices: a store
// rejects a screenshot whose pixel size is wrong, and the two Apple sizes are
// read off `myne-branding/app-store/README.md`'s slot table, which is where the
// current set's provenance lives.
//
// `frame` names the device chrome the set must be rendered in. It is a property
// of the SET rather than of a screen, which is what makes it impossible for one
// screen to land in the wrong chrome: `fastlane/metadata/android/en-US/images/
// phoneScreenshots/` held iPhone chrome until 2026-10, and a per-set frame is
// the fix rather than a per-screen convention somebody has to remember.
//
// `story` records how many of the agreed frames this set carries, and the number
// is checked against the story rather than trusted here. The two phone sets carry
// seven: the portability frame is retired from the set until the phone can open
// what it exports (`story.mjs` records why). The two tablet sets carry THREE,
// because the board's
// tablet layout is a separate family (`mobile/src/ipad/`) of nine screens of
// which only three depict a frame this story claims. Rendering a phone-shaped
// screen inside a tablet frame would tell a store reviewer that the tablet UI is
// a stretched phone, which it is not.

export const SLOTS = {
  "iphone-6.9": {
    id: "iphone-6.9",
    label: 'iPhone 6.9"',
    width: 1320,
    height: 2868,
    scale: 3,
    viewport: { width: 440, height: 956 },
    frame: "ios",
    story: 7,
    root: "staged",
  },
  "ipad-13": {
    id: "ipad-13",
    label: 'iPad 13"',
    width: 2048,
    height: 2732,
    scale: 2,
    viewport: { width: 1024, height: 1366 },
    frame: "ipad",
    story: 3,
    root: "staged",
  },
  "android-phone": {
    id: "android-phone",
    label: "Android phone",
    width: 1080,
    height: 1920,
    scale: 3,
    viewport: { width: 360, height: 640 },
    frame: "android",
    story: 7,
    root: "fastlane",
  },
  "android-10": {
    id: "android-10",
    label: 'Android 10"',
    width: 2560,
    height: 1600,
    scale: 2,
    viewport: { width: 1280, height: 800 },
    frame: "android-tablet",
    story: 3,
    root: "fastlane",
    // NOT PRODUCIBLE YET, and named rather than approximated. The board renders
    // Android chrome only at `AndroidFrame`'s phone defaults (412x892): its
    // `DeviceFrame` takes no size, and the tablet layout family declares
    // `platforms: ["ipad"]` so it does not render under the Android toggle at
    // all. Rendering this slot from the iPad frame would put iPad chrome in an
    // Android slot, which is the exact defect this feature exists to retire, and
    // rendering it from the phone frame would show a 412pt phone as a 10-inch
    // tablet. So it fails by name until the gallery can present an Android
    // tablet, which is its own task.
    blocked:
      "the gallery cannot render Android chrome at tablet size: DeviceFrame takes no size and the tablet layout family is iPad-only, so this slot would show iPad chrome or a phone-sized frame",
  },
};

/**
 * The file name a set writes per frame.
 *
 * Two conventions, and the difference is the store's rather than ours. The Apple
 * sets carry the frame id (`01-notes.png`), which is what the hand-set they
 * replace used and what makes a diff readable. The F-Droid directory keeps bare
 * numbers, because that is the shape it ships today and
 * `scripts/check-fdroid-metadata.mjs` reads that directory by count.
 */
/**
 * The Play feature graphic: a landscape plate, not a device set.
 *
 * Play reads exactly `1024x500`, under the exact name `images/featureGraphic.png`,
 * and `scripts/check-fdroid-metadata.mjs` lists that name among the ones F-Droid
 * looks for while warning that a misspelling is ignored in silence. So it is a
 * "slot" here only in the sense of having a pixel size and an output path: it
 * renders one frame, in a layout branch of its own (`layout: "graphic"`), and it
 * carries a headline and NO sub-line, because the plate has no room for one and
 * a store graphic is not a headline surface.
 *
 * It reuses the frame-1 screen rather than inventing a composition from nothing:
 * the device is the same real render, placed right and smaller, which is why the
 * graphic cannot show the app doing something the app does not do either.
 */
export const FEATURE_GRAPHIC = {
  id: "play-feature-graphic",
  label: "Play feature graphic",
  width: 1024,
  height: 500,
  scale: 1,
  viewport: { width: 1024, height: 500 },
  // NOT "ios". The graphic sits in the Android images root and is read by Play and
  // F-Droid, so iPhone chrome on it reproduces the exact defect this issue was filed
  // about, one file over. Caught by `/pr-review`.
  frame: "android",
  layout: "graphic",
  story: 1,
  root: "fastlane",
  filename: "featureGraphic.png",
  frames: ["notes"],
};

/**
 * Everything a full run writes, in order.
 *
 * A BLOCKED set is excluded rather than included and failing, because `--sets all`
 * is the command a maintainer runs to refresh the listing: aborting it on a set
 * that cannot be produced yet would make the working sets unproducible too. The
 * exclusion is loud instead (`BLOCKED_SET_IDS` is printed with its reason at the
 * start of every run), and asking for the blocked set BY NAME still fails by name.
 */
export const ALL_SET_IDS = [
  ...Object.keys(SLOTS).filter((id) => !SLOTS[id].blocked),
  FEATURE_GRAPHIC.id,
];

/** Sets that are declared and cannot be rendered yet, with their reasons. */
export const BLOCKED_SET_IDS = Object.keys(SLOTS).filter((id) => SLOTS[id].blocked);

export function frameFilename(slot, index, frameId) {
  // One output per set, named by the store rather than by us.
  if (slot.filename) return slot.filename;
  if (slot.root === "fastlane") return `${index + 1}.png`;
  return `${String(index + 1).padStart(2, "0")}-${frameId}.png`;
}

/** Which platform toggle on the board shows a set's chrome. */
export function toggleLabelFor(frame) {
  if (frame === "ios") return "iOS";
  if (frame === "ipad") return "iPad";
  if (frame === "android" || frame === "android-tablet") return "Android";
  throw new Error(`slot frame "${frame}" has no board toggle`);
}

/** Slot ids that are declared but cannot be rendered yet, with the reason. */
export function assertProducible(slot) {
  if (slot.blocked) {
    throw new Error(`set "${slot.id}" cannot be rendered yet: ${slot.blocked}`);
  }
  return slot;
}

/**
 * Resolve a slot by id, failing BY NAME.
 *
 * A silent `undefined` here would surface as a crash somewhere in the browser
 * half, which reads as a Playwright problem rather than as a typo in `--sets`.
 */
export function slotOf(id) {
  const slot = id === FEATURE_GRAPHIC.id ? FEATURE_GRAPHIC : SLOTS[id];
  if (!slot) {
    throw new Error(`unknown set "${id}". Known sets: ${ALL_SET_IDS.join(", ")}`);
  }
  return slot;
}

/**
 * The scale factor a set must be rendered at, and the check that it is an
 * integer. A fractional device scale factor produces a screenshot one pixel off
 * the slot on some rows, which no store accepts and nothing else here notices.
 */
export function assertSlotArithmetic(slot) {
  const { width, height, viewport, scale } = slot;
  if (width !== viewport.width * scale || height !== viewport.height * scale) {
    throw new Error(
      `slot "${slot.id}" is inconsistent: ${viewport.width}x${viewport.height} at ${scale}x is ` +
        `${viewport.width * scale}x${viewport.height * scale}, not ${width}x${height}`,
    );
  }
  return slot;
}
