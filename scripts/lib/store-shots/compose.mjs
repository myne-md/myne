// Composition geometry: where the plate, the caption band, the clause bar and
// the captured device frame sit inside one store image.
//
// Pure numbers and nothing else, on purpose. The browser half of the capture
// (`mobile/tests/store-shots/`) receives this as data and applies it; it makes no
// layout decision of its own, so every number a reviewer could argue about lives
// in a module a unit test can read. The alternative, geometry computed inside a
// `page.evaluate`, is untestable without a browser and invisible in a diff.
//
// The plate is ARTWORK and may author its own colour (`decisions/ui/0714`); the
// device frame is a real render of the app and is bound by the tokens. Nothing
// in this module paints: it returns values the caller turns into CSS.
//
// Everything is expressed in the slot's CSS pixels, which is what the browser
// lays out in. The device scale factor multiplies at screenshot time, so a
// number here is 3x smaller than the pixel in the delivered PNG and there is
// exactly one place, `slots.mjs`, where that arithmetic is written down.

/**
 * The banner: the headline's new home.
 *
 * It sits at the BOTTOM and the device runs UNDER it, so the type is in front of
 * the image rather than stacked above it. Drawn once across the whole canvas with
 * one cell per frame, so while the reader swipes the strip continues and only its
 * colour and its words change: that is the cross-page continuity being asked for,
 * and it is why the band is a single element rather than one per frame.
 *
 * The colours are a rotation rather than one value, because a band of one colour
 * across ten thousand pixels reads as a mistake in the export. Every pair below is
 * asserted to clear 4.5:1 by the unit spec, so a rotation cannot quietly produce an
 * unreadable cell.
 */
export const BANNER_COLOURS = [
  { bg: "#f7f6ee", fg: "#1a1a17" },
  { bg: "#1a1a17", fg: "#f7f6ee" },
  { bg: "#e9e8e4", fg: "#1a1a17" },
  { bg: "#2c4a7a", fg: "#f7f6ee" },
];

/** The small glyph a card carries, as a 24x24 path. Data, so a test can read it. */
export const CARD_GLYPHS = {
  spark: "M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5L3.5 12 10 10z",
  link: "M9.5 14.5l5-5M8 12l-1.8 1.8a3 3 0 004.2 4.2L12 16.2M16 12l1.8-1.8a3 3 0 00-4.2-4.2L12 7.8",
  file: "M7.5 4h6l3.5 3.5V20h-9.5zM13.5 4v3.5H17",
  server: "M5 7.5h14M5 12h14M5 16.5h9",
  people: "M9 11.5a3 3 0 100-6 3 3 0 000 6zM3.5 20c0-3 2.3-5 5.5-5s5.5 2 5.5 5M17.5 20c0-2.2-1-3.7-3-4.4",
};

/** Where the banner sits, and how big its two type layers are. */
export function bannerGeometry(slot) {
  const w = slot.viewport.width;
  const h = slot.viewport.height;
  const height = Math.round(h * 0.235);
  return {
    top: h - height,
    height,
    headlineSize: Math.round(w * 0.072),
    eyebrowSize: Math.round(w * 0.024),
    gap: Math.round(h * 0.012),
    padX: Math.round(w * 0.073),
  };
}

/**
 * The banner's top edge: a TORN EDGE, continuous across the whole set.
 *
 * This is the answer to "a wave would continue, so find something of ours that
 * does the same". Myne already owns this shape: `ornaments/` carries `torn edge`
 * and `perforation` as first-class ornament primitives, so a ripped paper top is
 * the brand's own vocabulary rather than a generic sine wave, and it says
 * something the wave does not: paper, torn by hand, is what a notebook is.
 *
 * CONTINUOUS BY CONSTRUCTION rather than by hope. The tear is ONE sequence of
 * samples spanning the whole canvas, eight per frame, and each frame's cell takes
 * the samples from its own span INCLUDING BOTH BOUNDARY SAMPLES. Two neighbouring
 * cells therefore share the exact point they meet at, so the edge cannot step at a
 * seam even by a pixel, and the amplitude is bounded so the tear can never reach
 * into the headline.
 */
export const BANNER_EDGE_SAMPLES_PER_FRAME = 8;
const BANNER_EDGE_AMPLITUDE_RATIO = 0.16;

export function bannerEdge(slot, frameCount) {
  const w = slot.viewport.width;
  const { height } = bannerGeometry(slot);
  const amplitude = Math.round(height * BANNER_EDGE_AMPLITUDE_RATIO);
  const step = w / BANNER_EDGE_SAMPLES_PER_FRAME;
  const points = [];
  for (let i = 0; i <= frameCount * BANNER_EDGE_SAMPLES_PER_FRAME; i += 1) {
    const rnd = lcg(0x2545f491 + i * 40503);
    // Two overlapping scales: long tears with small chips between them, so it reads
    // as paper rather than as noise.
    // Scaled so the sum can never exceed 1: an earlier version added 0.5 + 0.45 +
    // 0.35 and the tear ran past its own amplitude, which a test caught.
    const long = Math.sin(i * 0.7) * 0.5;
    points.push({ x: Math.round(i * step), y: Math.round(amplitude * (0.5 + long * 0.45 + rnd() * 0.25)) });
  }
  return { points, amplitude, step };
}

/** One frame's fill, from the shared samples. Both ends are shared with a neighbour. */
export function bannerCellPath(edge, frameIndex, frameCount, bandHeight) {
  const per = BANNER_EDGE_SAMPLES_PER_FRAME;
  const from = frameIndex * per;
  const to = Math.min(from + per, edge.points.length - 1);
  const span = edge.points.slice(from, to + 1);
  if (span.length < 2) throw new Error(`frame ${frameIndex} has no edge samples to draw`);
  const head = span.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x} ${pt.y}`).join(" ");
  const last = span[span.length - 1];
  const first = span[0];
  void frameCount;
  return `${head} L${last.x} ${bandHeight} L${first.x} ${bandHeight} Z`;
}

/** Plate colour for the default composition. Artwork, not a brand token. */
export const PLATE_BACKGROUND = "#141412";

/**
 * The plate's own palette, authored rather than bound to a token.
 *
 * This is what `decisions/ui/0714` permits for a listing image's BACKDROP and
 * forbids for a device frame: the plate is artwork, so it carries its colours the
 * way a `wallpapers/` plate does. It is not decoration. The first version of this
 * composition used `var(--fg-1)` for the headline, which is dark ink in the light
 * theme, and the headline rendered dark-on-near-black and effectively vanished.
 * The pixels caught it, the typecheck and every guard did not, which is why the
 * palette lives here with a contrast assertion in the unit spec rather than being
 * resolved in the page against whatever theme happened to be active.
 */
export const PLATE_PALETTE = {
  background: PLATE_BACKGROUND,
  /** Headline. Must clear a 4.5:1 contrast ratio against `background`. */
  ink: "#f7f6ee",
  /** Sub-line and the clause bar. Clears 4.5:1 too, at its smaller size. */
  muted: "#b9b7ad",
  /** The cipher field's base ink. Faint by design: it is a ground, not copy. */
  plateLine: "#2b2b26",
  /** The rows that "catch the light". This is the glow the field varies with. */
  cipherBright: "#6f6d62",
  /** What the field glows from. Behind the device, not over it. */
  glow: "rgba(247,246,238,0.16)",
};

/** Canvas geometry for a whole set: one plate, one clause bar, N frames wide. */
export function canvasGeometry(slot, frameCount) {
  const w = slot.viewport.width;
  const h = slot.viewport.height;
  if (frameCount < 1) throw new Error(`a canvas needs at least one frame, got ${frameCount}`);
  return { width: w * frameCount, height: h, frameWidth: w };
}

/**
 * Where a frame's glow sits.
 *
 * A soft radial wash behind the device, so the plate is not one flat field and the
 * phone reads as lit from behind rather than pasted on. Six discrete stops rather
 * than a gradient across the whole canvas on purpose: the field has to stay a set
 * of objects the reader's eye can move through, not a smooth ramp that turns the
 * panorama into a single gradient.
 */
export function glowFor(slot, geom) {
  const w = slot.viewport.width;
  return {
    x: Math.round(geom.device.left + geom.device.width / 2),
    y: Math.round(geom.device.top + geom.device.height * 0.42),
    radius: Math.round(w * 0.66),
    color: PLATE_PALETTE.glow,
  };
}

/** Fraction of plate width the caption band keeps as side margin. */
const MARGIN_RATIO = 0.073;
/** Caption band top, as a fraction of plate height. */
const CAPTION_TOP_RATIO = 0.075;
/** Headline cap size, as a fraction of plate width. */
const HEADLINE_RATIO = 0.077;
/** Sub-line size, as a fraction of plate width. */
const SUB_RATIO = 0.034;
/** Widest the device may be drawn, as a fraction of plate width. */
const DEVICE_WIDTH_RATIO = 0.78;
/** Plate left under the device, so a taller device is cropped rather than floating. */
const DEVICE_BOTTOM_INSET_RATIO = 0.042;
/** Space between the caption block and the top of the device. */
const CAPTION_GAP_RATIO = 0.042;
/** Eyebrow cap size, as a fraction of plate width. Small, mono, tracked. */
const EYEBROW_RATIO = 0.023;
/** Space under the eyebrow, before the headline. */
const EYEBROW_GAP_RATIO = 0.017;

/**
 * Floating card geometry.
 *
 * These are the objects parked on the plate, replacing the clause bar that used to
 * run along the bottom. Each card is placed so its WHOLE rectangle lies inside its
 * own frame, because a store carousel shows ONE image at a time: a card that
 * crossed the seam was cut mid-word in every frame it spanned, which stopped a
 * frame standing on its own. The jitter is deliberate and asymmetric (an even band
 * reads as a toolbar, while alternating high and low reads as objects parked on a
 * surface), and the widths and rotations vary per card, so a set stops reading as
 * one repeated example.
 *
 * WHAT CARRIES CONTINUITY, now that a card no longer crosses a seam: the banner
 * strip, the cipher field and the torn edge, each drawn ONCE across the whole
 * canvas. That is the part of the composition that is genuinely continuous, and it
 * is what the feature is for.
 */
export function cardLayout(slot, frameIndex, cardIndex, frameCount) {
  const w = slot.viewport.width;
  const h = slot.viewport.height;
  // The frame's own span, in canvas coordinates. Every card is clamped into it
  // with a margin, since a five-degree rotation reaches a little past a card's own
  // rectangle and a card flush to the edge would still be cut.
  const frameLeft = frameIndex * w;
  const margin = Math.round(w * 0.03);
  const rnd = lcg(0x51ed270b + frameIndex * 7919 + cardIndex * 104729);
  const width = Math.round(w * (0.42 + rnd() * 0.18));
  const left = Math.max(
    frameLeft + margin,
    Math.min(
      Math.round(frameLeft + (0.06 + rnd() * 0.5) * w - cardIndex * Math.round(w * 0.11)),
      frameLeft + w - width - margin,
    ),
  );
  const band = frameIndex % 2 === 0 ? 0.24 : 0.44;
  void frameCount;
  return {
    left,
    top: Math.round(h * (band + cardIndex * 0.11 + rnd() * 0.06)),
    width,
    /** Up to about five degrees either way. More reads as scrapbook, not as a UI. */
    rotate: Math.round((rnd() * 10 - 5) * 10) / 10,
  };
}

/**
 * Geometry for one frame at one slot.
 *
 * `frameBox` is the device frame's own laid-out size, read from the page rather
 * than assumed: the iOS, Android and iPad frames are different sizes and the
 * phone frames have been resized once already. Reading it means a frame that
 * changes size changes this composition instead of silently rendering a
 * three-quarter-empty plate.
 *
 * The device is scaled to fit BOTH the width budget and the height left under the
 * caption, whichever binds first, and is centred horizontally. It is never
 * cropped: the current hand-set crops the phone at the bottom edge, and that is
 * a taste call for the design task rather than something this module should
 * decide for every set.
 */
export function plateGeometry(slot, frameBox) {
  if (!frameBox || !(frameBox.width > 0) || !(frameBox.height > 0)) {
    throw new Error(
      `plateGeometry needs a positive device frame box, got ${JSON.stringify(frameBox)}`,
    );
  }

  const w = slot.viewport.width;
  const h = slot.viewport.height;
  const banner = bannerGeometry(slot);

  const topSpace = Math.round(h * 0.05);
  // The device runs UNDER the banner by this much, so the type is in front of the
  // image. Bounded rather than unbounded: past roughly a sixth of the plate the
  // phone stops reading as a phone.
  const overlap = Math.round(h * 0.1);
  const budget = banner.top + overlap - topSpace;

  const scale = Math.min((w * 0.86) / frameBox.width, budget / frameBox.height);
  const deviceWidth = Math.round(frameBox.width * scale);
  const deviceHeight = Math.round(frameBox.height * scale);

  return {
    plate: { width: w, height: h, background: PLATE_PALETTE.background },
    palette: PLATE_PALETTE,
    banner,
    device: {
      top: topSpace,
      left: Math.round((w - deviceWidth) / 2),
      scale,
      width: deviceWidth,
      height: deviceHeight,
      /** How much of the device the banner covers. Asserted, never guessed. */
      coveredByBanner: Math.max(0, topSpace + deviceHeight - banner.top),
    },
  };
}

/**
 * The cipher field: the plate's ground texture.
 *
 * WHAT IT IS. Rows of pseudo-ciphertext in the mono face at very low contrast,
 * drawn ONCE across the whole canvas so the field slides with the panorama. The
 * devices and the cards occlude most of it and it is glimpsed from the edges, the
 * corners and the gaps between objects, which is the effect being asked for: a flat
 * field of one colour looked like nothing, and a surface with something faintly
 * printed on it reads as an object.
 *
 * WHAT IT IS NOT, and this is the honest part: it is not readable. The alphabet
 * excludes I, O, 0 and 1 (Crockford's exclusions, so a glyph can never be
 * mistaken for another and no row can be read as a word), the strings are drawn
 * from a FIXED SEED so every render is byte-identical, and the opacity is capped
 * below the point where it competes with the copy. Nothing here is a real key, a
 * real identifier or a real note.
 *
 * THE TENSION, recorded rather than hidden: `PRODUCT.md` design principle 4
 * withdrew the `01` binary field from the empty states on the grounds that it
 * "read as developer and privacy iconography on surfaces a general user meets
 * every day". A cipher field is that iconography's cousin. What makes it
 * acceptable HERE and nowhere else is the scope `decisions/ui/0714` draws: this is
 * the artwork plate of a listing image, seen once by a stranger deciding whether
 * to install, and never a surface inside the product. If that line ever blurs, the
 * field is what should go first.
 */
const CIPHER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/**
 * Above this the field starts competing with the headline. Raised once, from
 * 0.12, because the first version was invisible on the plate at any reasonable
 * screen brightness: the maintainer's report was "the cipher work is not done",
 * and it was not, it was simply too faint to exist. Enforced by a test.
 */
export const CIPHER_OPACITY_CAP = 0.8;

/** A tiny deterministic PRNG, so a row's glyphs are identical on every render. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function cipherField(slot, frameCount) {
  const w = slot.viewport.width;
  const h = slot.viewport.height;
  const canvasWidth = w * frameCount;
  const size = Math.round(w * 0.019);
  const lineHeight = Math.round(h * 0.0305);
  const rows = [];
  const count = Math.floor(h / lineHeight);
  for (let i = 0; i < count; i += 1) {
    const rnd = lcg(0x9e3779b9 + i * 2654435761);
    // Long enough to cross several frames, so a row is one object sliding rather
    // than eight separate ones that happen to line up.
    const span = canvasWidth / (size * 0.62);
    const chars = Math.max(8, Math.round(span * (0.45 + rnd() * 0.55)));
    let text = "";
    for (let c = 0; c < chars; c += 1) text += CIPHER_ALPHABET[Math.floor(rnd() * CIPHER_ALPHABET.length)];
    // Rows vary between "catching the light" and "sinking into the plate", which is
    // what makes the field read as depth rather than as a watermark.
    const bright = rnd() > 0.68;
    rows.push({
      top: Math.round((i + 0.6) * lineHeight),
      size,
      text,
      left: Math.round(rnd() * w * 0.42),
      opacity: Number(((bright ? 0.10 : 0.035) + rnd() * 0.11).toFixed(3)),
      bright,
    });
  }
  return { rows, canvasWidth, color: PLATE_PALETTE.plateLine };
}

/**
 * The cipher field as SEGMENTS, so brightness can vary inside a row.
 *
 * The row-per-element version could only be uniformly faint or uniformly bright,
 * which is why the glow had to be faked with a spotlight behind the phone. The
 * maintainer's correction was to point at the website hero, where hovering makes
 * the cipher itself catch the light: static, irregular, in PLACES. So brightness
 * is now a function of position, not of a row or of the device's location.
 *
 * TWO SCALES, because one is noise and two is texture. A smooth field gives broad
 * patches that span several rows, and a handful of fixed centres add the hotspots
 * that make it read as glare on a surface rather than as a gradient. Both come from
 * fixed constants, so every render is identical, and each segment's world x means a
 * segment straddling a seam is drawn once and continues.
 */
const CIPHER_SEGMENT_CHARS = 5;
const CIPHER_SMOOTH_X = 0.0125;
const CIPHER_SMOOTH_Y = 0.055;
// TIGHT, and that is the whole point: with radii a fifth of a frame the five
// circles overlapped and the field was uniformly bright, which is the flatness the
// change was meant to remove. A glare is small and local.
// fy values sit in the BANNER's band of the plate (0.765 to 1.0), because that is
// the only place the field is drawn now. The previous set was spread over the whole
// plate, so the band had no hotspot in it and the field came out uniform: measured,
// max was not even 2.5x the tenth percentile, which is the assertion that caught it.
const CIPHER_HOTSPOTS = [
  { fx: 0.07, fy: 0.8, r: 0.15 },
  { fx: 0.3, fy: 0.9, r: 0.18 },
  { fx: 0.54, fy: 0.82, r: 0.14 },
  { fx: 0.71, fy: 0.94, r: 0.19 },
  { fx: 0.92, fy: 0.86, r: 0.16 },
];

/** The brightness of the field at a point, in units of the frame's width. */
export function cipherAlphaAt(slot, frameCount, x, y) {
  const canvasWidth = slot.viewport.width * frameCount;
  const h = slot.viewport.height;
  const smooth =
    0.5 +
    0.5 *
      Math.sin(x * CIPHER_SMOOTH_X + Math.sin(y * CIPHER_SMOOTH_Y) * 1.4) *
      Math.sin(y * CIPHER_SMOOTH_Y * 0.7 + Math.cos(x * CIPHER_SMOOTH_X * 1.7));
  let hot = 0;
  for (const c of CIPHER_HOTSPOTS) {
    const cx = c.fx * canvasWidth;
    const cy = c.fy * h;
    const r = c.r * slot.viewport.width;
    const d = Math.hypot(x - cx, y - cy) / r;
    // Cubic, not square: a wide circle with a small hot core, so the patches are large enough to read while the field between them stays dark. The square falloff gave a 0.2% bright share, which is a handful of glyphs rather than a glow.
    if (d < 1) hot += (1 - d) ** 3;
  }
  const jitter = lcg(0x1b873593 + Math.round(x) * 7919 + Math.round(y) * 104729)() * 0.09;
  // Weighted towards the hotspots rather than towards a floor: an earlier version
  // had a base of 0.05 plus a smooth term the same size as the hot one, so the whole
  // field sat in a narrow band and "glowing in places" was not what it looked like.
  const raw = 0.16 + smooth * 0.22 + hot * 0.62 + jitter;
  return Number(Math.min(raw, CIPHER_OPACITY_CAP).toFixed(3));
}

export function cipherSegments(slot, frameCount) {
  const canvasWidth = slot.viewport.width * frameCount;
  const h = slot.viewport.height;
  const size = Math.round(slot.viewport.width * 0.02);
  const lineHeight = Math.round(h * 0.0295);
  const charAdvance = size * 0.66;
  const rows = Math.floor(h / lineHeight);
  const segments = [];
  for (let r = 0; r < rows; r += 1) {
    const y = Math.round((r + 0.6) * lineHeight);
    const rnd = lcg(0x9e3779b9 + r * 2654435761);
    const start = -Math.round(rnd() * size * 4);
    for (let x = start; x < canvasWidth; x += size * CIPHER_SEGMENT_CHARS * 0.66) {
      let text = "";
      for (let c = 0; c < CIPHER_SEGMENT_CHARS; c += 1) {
        text += CIPHER_ALPHABET[Math.floor(rnd() * CIPHER_ALPHABET.length)];
      }
      const alpha = cipherAlphaAt(slot, frameCount, x + charAdvance, y);
      if (alpha < 0.055) continue;
      segments.push({ x: Math.round(x), y, size, text, alpha });
    }
  }
  return { segments, size };
}

/**
 * There is deliberately no clause bar. It is drawn, removed at the maintainer's
 * request on 2026-10-17, and what it carried now rides on the floating cards: the
 * bar made the privacy lane legible but it also flattened the bottom of every
 * frame into a footer, and it stopped nothing from being read once the reader
 * swiped past it. `cardLayout` is its replacement, and the tests that used to hold
 * the bar's geometry hold the cards' containment in their frame instead.
 */

/**
 * Layout for the one-frame landscape feature graphic.
 *
 * A different shape from a frame, and deliberately not a crop of frame 1: at
 * 1024x500 a portrait frame's rhythm reads as a mistake, so the device sits right
 * at about three-quarters of the plate's height and the headline sits left. The
 * punctuation is one line and no sub-line, because the plate has no room for a
 * second and a store graphic is not a headline surface.
 */
export function graphicLayout(slot, frameBox) {
  if (!frameBox || !(frameBox.width > 0) || !(frameBox.height > 0)) {
    throw new Error(`graphicLayout needs a positive device frame box, got ${JSON.stringify(frameBox)}`);
  }
  const w = slot.viewport.width;
  const h = slot.viewport.height;

  const margin = Math.round(w * 0.055);
  const captionWidth = Math.round(w * 0.46);
  const headlineSize = Math.round(w * 0.052);
  const eyebrowSize = Math.round(w * 0.017);

  const scale = (h * 0.78) / frameBox.height;
  const width = Math.round(frameBox.width * scale);
  const height = Math.round(frameBox.height * scale);

  return {
    plate: { width: w, height: h, background: PLATE_PALETTE.background },
    palette: PLATE_PALETTE,
    caption: {
      left: margin,
      top: Math.round((h - headlineSize * 1.16) / 2),
      width: captionWidth,
      headlineSize,
      eyebrowSize,
      eyebrowGap: Math.round(h * 0.024),
    },
    device: {
      left: w - width - margin,
      top: Math.round((h - height) / 2),
      scale,
      width,
      height,
    },
  };
}
