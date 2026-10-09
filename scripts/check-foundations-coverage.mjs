#!/usr/bin/env node
// check-foundations-coverage.mjs, every token and every icon has a specimen
// (myne-md/myne#845).
//
// The failure this prevents: the Foundations group is generated from its
// sources, so a new token or icon appears in the sheet or the registry and
// nowhere in the catalogue, silently. Nothing else notices, a token with no
// specimen breaks no build and renders nothing wrong, and the catalogue keeps
// claiming to cover the design system while a whole family of values is
// invisible.
//
// Two ratchets, each compared in ONE direction on purpose:
//   - a token declared by the sheet that no specimen group classifies fails,
//     naming the token;
//   - the icon registry having zero readable keys fails, because a scan that
//     finds nothing is a broken scan rather than a pass.
//
// The group patterns MIRROR `stories/src/foundations.tsx` by CONVENTION, and the
// direction is worth stating because a review caught this header claiming more.
// The guard does not read `foundations.tsx`: it classifies every token the sheet
// declares against its own `GROUPS` table. So a token with no group fails, while
// deleting a group from the COMPONENT (leaving the guard's table intact) does
// not, because the guard never sees the component. The specimen side is checked
// only in the direction that has a machine behind it, and saying so is the point.
//
// The icon half is a non-vacuity floor rather than a specimen check, and that is
// complete rather than partial: `IconsSpecimen` iterates `ICON_PATHS`, so every
// icon in the registry has a specimen by construction, and the only way to break
// that is to empty the registry, which is what the floor catches.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SHEET = join(ROOT, "client-core/src/tokens.css");
const ICONS = join(ROOT, "editor/src/host/lib/icons.ts");

/** The specimen groups, mirroring `TOKEN_GROUPS` in foundations.tsx. */
export const GROUPS = Object.freeze({
  type: /^--(text|font|weight|tracking|leading)-/,
  spacing: /^--space-/,
  radii: /^--radius-/,
  shadows: /^--(shadow|ring)/,
  motion: /^--(duration|ease|stagger)-/,
  metrics: /^--(target|field|control|icon|cover-banner|hairline|segment|content-max-w)(-|$)/,
  zIndex: /^--z-/,
});

/** A token whose value reads as a colour, which is the seventh group. */
export function isColour(name, value) {
  if (
    /^--(space|text|radius|shadow|ring|duration|ease|weight|tracking|leading|stagger|target|field|control|icon|cover-banner|hairline|segment)(-|$)/.test(
      name,
    )
  ) {
    return false;
  }
  return /^(#|rgb|hsl|color-mix|var\(--)/.test(value);
}

/** Every `--name: value;` declaration in the sheet, unique, first value wins. */
export function declaredTokens(css) {
  const out = new Map();
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    if (!out.has(match[1])) out.set(match[1], match[2].trim());
  }
  return out;
}

/** Which group classifies a token, or null when none does. */
export function classify(name, value) {
  if (isColour(name, value)) return "colours";
  for (const [group, pattern] of Object.entries(GROUPS)) {
    if (pattern.test(name)) return group;
  }
  return null;
}

if (!existsSync(SHEET)) {
  console.error(`check-foundations-coverage: FAIL: token sheet not found at ${SHEET}`);
  process.exit(1);
}

const tokens = declaredTokens(readFileSync(SHEET, "utf8"));
if (tokens.size === 0) {
  console.error("check-foundations-coverage: FAIL: no tokens read from the sheet; the scan is broken");
  process.exit(1);
}

const uncovered = [];
for (const [name, value] of tokens) {
  if (classify(name, value) === null) uncovered.push(name);
}

if (!existsSync(ICONS)) {
  console.error(`check-foundations-coverage: FAIL: icon registry not found at ${ICONS}`);
  process.exit(1);
}
const iconSource = readFileSync(ICONS, "utf8");
const iconKeys = iconSource.match(/^\s*"?[A-Za-z0-9-]+"?\s*:/gm) ?? [];
if (iconKeys.length === 0) {
  console.error("check-foundations-coverage: FAIL: no icons read from the registry; the scan is broken");
  process.exit(1);
}

if (uncovered.length > 0) {
  console.error(`check-foundations-coverage: ${uncovered.length} token(s) with no specimen group`);
  for (const name of uncovered) console.error(`  ${name}`);
  console.error(
    "  Add the token to a specimen group in stories/src/foundations.tsx (and to GROUPS here if it opens a new family).",
  );
  process.exit(1);
}

console.log(
  `check-foundations-coverage: ok (${tokens.size} token(s) classified across ${Object.keys(GROUPS).length + 1} specimen group(s); icon registry readable)`,
);
