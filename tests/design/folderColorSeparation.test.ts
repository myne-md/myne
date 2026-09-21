// Colour-group swatches are distinguishable — myne-md/myne#557, the
// `sidebar.notes-and-folders` bullet.
//
// The roster row said "the colours are distinguishable from each other", which
// reads like an eye judgement and is not one. It has a rule, and `tokens.css`
// states the rule in its own comment beside the palette: the hues are spaced on
// the wheel so a group can never read as an error/warning/success state, and
// their lightness ALTERNATES (34%/44% in light, mirrored in dark) "so two
// adjacent hues stay distinguishable under red-green colour-vision deficiency,
// not just by hue".
//
// Nothing checked either half. The check is CIEDE2000, the same class of colour
// rule `e2e/ornament.e2e.ts` already gates a palette on, and it runs over the
// token source rather than over a render, so it covers all three built-in themes
// including AMOLED — which no hand-walk on one machine does.
//
// # Where the floors come from
//
// ΔE2000 ≈ 2.3 is the just-noticeable difference for two large patches shown
// side by side under controlled light. A folder swatch is none of those things:
// it is small, it is read at a glance, and the two swatches being compared are
// usually several rows apart. So the bar has to sit well above JND, and the
// floors below are the ones the shipped palette already clears with the margins
// recorded next to them. They are a RATCHET: a palette edit may widen the
// separation freely and may not narrow it past these numbers.
//
// # What this cannot say
//
// It compares the token VALUES. Whether a theme's swatch is actually painted
// with its token is a render question and belongs to the e2e lanes; a custom
// theme's own palette is refused or accepted by `theme-validator`, not here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

// The sheet the app actually loads. `docs/design/colors_and_type.css` is a
// SUBSET of it (src/AGENTS.md): it carries no `:root[data-theme="amoled"]`
// block at all, so reading the canon copy here would silently drop a third of
// the matrix — the third with a pure-black background, which is the one most
// likely to lose a dark swatch.
// **Both sheets, concatenated.** myne-md/myne#478 moved the design TOKENS to
// `client-core/src/tokens.css` and left `src/styles/tokens.css` as this
// client's component layer; its own header says so. Reading one of them
// means a token that moves between them turns this into a test that fails
// about its own input, which is how this file came to report 167 missing
// tokens against a palette that was entirely present.
const CSS = [
  readFileSync(join(REPO_ROOT, "client-core/src/tokens.css"), "utf8"),
  readFileSync(join(REPO_ROOT, "src/styles/tokens.css"), "utf8"),
].join("\n");

/** The eight colour-group keys, in palette order. */
const GROUPS = [
  "olive",
  "fern",
  "teal",
  "denim",
  "indigo",
  "violet",
  "orchid",
  "rose",
] as const;

/**
 * Resolve one custom property to a literal hex, following at most a few `var()`
 * indirections (the amoled twins are declared as `var(--_group-x-dark)`).
 *
 * Throws rather than returning a default: a token this cannot find is a token
 * the palette no longer has, and answering "black" for it would let a deleted
 * swatch pass every assertion below.
 */
function resolveHex(token: string, depth = 0): string {
  if (depth > 4) throw new Error(`--${token}: var() chain too deep`);
  const m = CSS.match(new RegExp(`--${token}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${token} not found in src/styles/tokens.css`);
  const value = m[1].trim();
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const ref = value.match(/^var\(\s*--([a-zA-Z0-9_-]+)\s*\)$/);
  if (ref) return resolveHex(ref[1], depth + 1);
  throw new Error(`--${token} is neither a literal hex nor a single var(): ${value}`);
}

// ── CIEDE2000 ───────────────────────────────────────────────────────────────

type Lab = readonly [number, number, number];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB hex to CIE L*a*b* under the D65 white point. */
function labOf(hex: string): Lab {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16));
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16));
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16));
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const Xn = 0.95047;
  const Yn = 1;
  const Zn = 1.08883;
  const f = (t: number) =>
    t > Math.pow(6 / 29, 3) ? Math.cbrt(t) : t / (3 * Math.pow(6 / 29, 2)) + 4 / 29;
  const fx = f(X / Xn);
  const fy = f(Y / Yn);
  const fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** HSL lightness (0..100) — the axis the palette's own alternation rule is in. */
function hslLightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** CIEDE2000 colour difference. */
function deltaE2000(l1: Lab, l2: Lab): number {
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hueOf = (b: number, ap: number) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) * DEG;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hueOf(b1, ap1);
  const hp2 = hueOf(b2, ap2);
  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * RAD);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (Cp1 + Cp2) / 2;
  let hbp: number;
  if (Cp1 * Cp2 === 0) {
    hbp = hp1 + hp2;
  } else if (Math.abs(hp1 - hp2) <= 180) {
    hbp = (hp1 + hp2) / 2;
  } else {
    hbp = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * RAD) +
    0.24 * Math.cos(2 * hbp * RAD) +
    0.32 * Math.cos((3 * hbp + 6) * RAD) -
    0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) +
      Math.pow(dCp / Sc, 2) +
      Math.pow(dHp / Sh, 2) +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// ── The three built-in themes ───────────────────────────────────────────────

interface Theme {
  name: string;
  /** Token name per group key. */
  group: (key: string) => string;
  /** The surface tokens a swatch is ever drawn on. */
  backgrounds: readonly string[];
}

const THEMES: readonly Theme[] = [
  {
    name: "light",
    group: (k) => `group-${k}`,
    backgrounds: ["paper", "paper-2", "paper-3"],
  },
  {
    name: "dark",
    group: (k) => `_group-${k}-dark`,
    backgrounds: ["_paper-dark", "_paper-2-dark", "_paper-3-dark"],
  },
  {
    name: "amoled",
    group: (k) => `_group-${k}-amoled`,
    backgrounds: ["_paper-amoled", "_paper-2-amoled", "_paper-3-amoled"],
  },
];

/**
 * Floors, in ΔE2000. Both are ratchets: widen freely, never narrow.
 *
 * PAIR = 8. About 3.5x the ~2.3 JND, and the margin the shipped palette
 * delivers (tightest today: violet/orchid at 8.06 in light, olive/fern at 8.58
 * in dark and amoled). A pair that fell below this would be two swatches a user
 * has to compare side by side to tell apart, which is not what a folder colour
 * is for.
 *
 * BACKGROUND = 25. A swatch has to be visible, not merely different: the
 * shipped minimum is 34.78 (light fern on --paper-3) and 51.05 (dark violet on
 * --paper-3-dark), so this floor is loose enough that a legitimate palette edit
 * never trips it and tight enough that a swatch nearly the colour of its own
 * surface fails.
 */
const PAIR_FLOOR = 8;
const BACKGROUND_FLOOR = 25;

describe("the colour-group palette exists in all three built-in themes", () => {
  it.each(THEMES.map((t) => [t.name, t] as const))("%s declares all eight groups", (_n, theme) => {
    for (const key of GROUPS) {
      const hex = resolveHex(theme.group(key));
      expect(hex, `--${theme.group(key)} did not resolve to a hex`).toMatch(
        /^#[0-9a-f]{6}$/,
      );
    }
  });

  it("amoled reuses the dark values rather than inventing a third palette", () => {
    // The palette comment says so; if amoled ever grows its own hues the
    // separation numbers below stop describing it and this fails first.
    for (const key of GROUPS) {
      expect(resolveHex(`_group-${key}-amoled`)).toBe(resolveHex(`_group-${key}-dark`));
    }
  });

  it("no two groups share a value in any theme", () => {
    for (const theme of THEMES) {
      const hexes = GROUPS.map((k) => resolveHex(theme.group(k)));
      expect(new Set(hexes).size, `${theme.name} has a duplicated group colour`).toBe(
        GROUPS.length,
      );
    }
  });
});

describe("every pair of colour-group swatches is separable", () => {
  for (const theme of THEMES) {
    for (let i = 0; i < GROUPS.length; i++) {
      for (let j = i + 1; j < GROUPS.length; j++) {
        const a = GROUPS[i];
        const b = GROUPS[j];
        it(`${theme.name}: ${a} vs ${b}`, () => {
          const d = deltaE2000(
            labOf(resolveHex(theme.group(a))),
            labOf(resolveHex(theme.group(b))),
          );
          expect(
            d,
            `${theme.name} ${a} (${resolveHex(theme.group(a))}) and ${b} ` +
              `(${resolveHex(theme.group(b))}) are ${d.toFixed(2)} apart in ` +
              `ΔE2000, under the ${PAIR_FLOOR} floor. Two folder colours a ` +
              `user has to compare side by side to tell apart are not two ` +
              `folder colours.`,
          ).toBeGreaterThanOrEqual(PAIR_FLOOR);
        });
      }
    }
  }
});

describe("every colour-group swatch is visible on every surface it lands on", () => {
  for (const theme of THEMES) {
    for (const key of GROUPS) {
      for (const bg of theme.backgrounds) {
        it(`${theme.name}: ${key} on --${bg}`, () => {
          const fg = resolveHex(theme.group(key));
          const back = resolveHex(bg);
          const d = deltaE2000(labOf(fg), labOf(back));
          expect(
            d,
            `${theme.name} ${key} (${fg}) is ${d.toFixed(2)} from --${bg} ` +
              `(${back}) in ΔE2000, under the ${BACKGROUND_FLOOR} floor — the ` +
              `swatch would be near-invisible on that surface.`,
          ).toBeGreaterThanOrEqual(BACKGROUND_FLOOR);
        });
      }
    }
  }
});

// ── The lightness alternation, and what it does and does not deliver ────────
//
// `tokens.css` states the mechanism: the hues "alternate lightness (34%/44% in
// light, mirrored in dark) so two adjacent hues stay distinguishable under
// red-green colour-vision deficiency, not just by hue".
//
// The first half is true and is pinned below: the alternation is exactly the
// stated 34/44 in light and 78/70 in dark, in HSL.
//
// **The second half does not follow from it, and measuring found where.** HSL
// lightness is not perceptual lightness. In the light palette `teal` (#32647b)
// and `denim` (#415c9f) alternate correctly in HSL — 33.9 % against 43.9 % — and
// land on L* = 40.0 and L* = 40.0, identical to one decimal. They are adjacent
// in the palette, they are 199° and 223° on the wheel, and under deuteranopia
// two blues that close collapse toward each other with no lightness step left to
// separate them. In the dark palette `fern` and `teal` sit 0.67 L* apart for the
// same reason.
//
// That is a design-canon question — the palette lives in `docs/design/` and
// `src/styles/tokens.css`, and changing it is a decision with a `decisions.md`
// entry behind it, not a test edit. So this file does the one thing a test
// honestly can: it RECORDS the measurement, both directions, so the numbers
// cannot move without somebody saying why. A palette edit that improves the
// separation fails here too, which is correct — the record is what gets
// re-argued, and improving it is exactly when the finding above gets closed.

/**
 * The measured minimum |ΔL*| between palette-ADJACENT groups, per theme.
 *
 * Recorded, not floored. A floor at today's value would be `0.0` in light, which
 * asserts nothing; an exact record fails on any change in either direction and
 * so cannot silently stop describing the palette.
 */
const ADJACENT_LIGHTNESS_RECORD: ReadonlyArray<{
  theme: string;
  minDeltaL: number;
  at: string;
  note: string;
}> = [
  {
    theme: "light",
    minDeltaL: 0.097,
    at: "teal/denim",
    note:
      "both resolve to L* 40.0. The HSL alternation is present (33.9 % vs " +
      "43.9 %) and delivers no perceptual lightness step, so these two blues " +
      "are separated by hue alone — the case the palette comment says the " +
      "alternation prevents.",
  },
  {
    theme: "dark",
    minDeltaL: 0.668,
    at: "fern/teal",
    note: "L* 81.1 against 81.7 — the same HSL-is-not-L* gap, one theme down.",
  },
  {
    theme: "amoled",
    minDeltaL: 0.668,
    at: "fern/teal",
    note: "amoled reuses the dark values verbatim, so it inherits the dark gap.",
  },
];

describe("the lightness alternation the palette comment claims", () => {
  it.each(THEMES.map((t) => [t.name, t] as const))(
    "%s: HSL lightness alternates between exactly two levels",
    (_n, theme) => {
      // The stated rule, checked as stated. A palette edit that kept every hue
      // and flattened the alternation would satisfy every ΔE assertion above
      // through hue alone and quietly delete the mechanism.
      const ls = GROUPS.map((k) => hslLightness(resolveHex(theme.group(k))));
      const levels = [...new Set(ls.map((l) => l.toFixed(1)))];
      expect(
        levels.length,
        `${theme.name} uses ${levels.length} HSL lightness levels ` +
          `(${levels.join(", ")}); the palette rule is two, alternating`,
      ).toBe(2);
      for (let i = 1; i < ls.length; i++) {
        expect(
          ls[i].toFixed(1),
          `${theme.name}: ${GROUPS[i - 1]} and ${GROUPS[i]} sit on the same ` +
            `HSL lightness level, so the alternation is broken at that step`,
        ).not.toBe(ls[i - 1].toFixed(1));
      }
    },
  );

  it.each(ADJACENT_LIGHTNESS_RECORD)(
    "$theme: the perceptual lightness step is still $minDeltaL at $at",
    (record) => {
      const theme = THEMES.find((t) => t.name === record.theme)!;
      const ls = GROUPS.map((k) => labOf(resolveHex(theme.group(k)))[0]);
      let min = Infinity;
      let at = "";
      for (let i = 1; i < ls.length; i++) {
        const d = Math.abs(ls[i] - ls[i - 1]);
        if (d < min) {
          min = d;
          at = `${GROUPS[i - 1]}/${GROUPS[i]}`;
        }
      }
      expect(record.note.length, "every record needs a stated reason").toBeGreaterThan(30);
      expect(at, `the tightest adjacent pair moved to ${at}`).toBe(record.at);
      expect(
        min,
        `${record.theme}'s tightest adjacent perceptual lightness step is now ` +
          `${min.toFixed(2)}, recorded as ${record.minDeltaL}. Moving it in ` +
          `either direction is a design-canon change: re-record here and say ` +
          `why. Improving it is how the finding in this file's header closes.`,
      ).toBeCloseTo(record.minDeltaL, 2);
    },
  );
});

describe("the measurement is not vacuous", () => {
  it("reports a small difference as small", () => {
    // Two colours one step apart must not clear an 8 ΔE floor, or every
    // assertion above passes on a broken metric.
    expect(deltaE2000(labOf("#5d7b32"), labOf("#5e7b32"))).toBeLessThan(1);
  });

  it("agrees with the published CIEDE2000 reference pairs", () => {
    // Sharma/Wu/Dalal's test data, the standard implementation check. Without
    // it, a transposed term in the formula produces plausible-looking numbers
    // and every threshold above is measuring the wrong thing.
    const cases: Array<[Lab, Lab, number]> = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
      [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
      [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, expected] of cases) {
      expect(deltaE2000(a, b)).toBeCloseTo(expected, 3);
    }
  });
});
