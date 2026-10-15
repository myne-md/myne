// Foundations: specimens for the token layer, generated from their sources
// (myne-md/myne#845).
//
// Every value here is READ from the sheet that ships, so a specimen cannot drift
// from what a component uses. `scripts/check-foundations-coverage.mjs` holds the
// SHEET side: a token the sheet declares that no specimen group classifies fails,
// naming the token. The other direction is convention rather than a machine
// check, because the guard does not read this file: deleting a group from
// `TOKEN_GROUPS` below leaves the guard green. The guard's header says so.
//
// The sheet is read with Vite's `?raw`, which is a build-time string, so there is
// no runtime fetch and the catalogue stays a static bundle (which is what lets it
// deploy as a served SPA).

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { interactiveSurface } from "../../../src/components/primitives/interactiveSurface";
import tokensCss from "../../../client-core/src/tokens.css?raw";
// The component sheet, read only for the `.t-*` role pairing (myne-md/myne#847
// task 13): the values stay the token sheet's, this is where the three
// properties that make a step on the scale are declared together.
import stylesCss from "../../../src/styles/tokens.css?raw";
import { Button } from "@app/components/primitives/Button";
import { Icon } from "@app/components/primitives/Icon";
import { Input } from "@app/components/primitives/Input";
import { ICON_PATHS } from "@app/lib/icons";
import type { IconName } from "@app/lib/icons";
import type { StoryDescriptor } from "../types";

/** One `--name: value;` run inside a block. */
interface TokenBlock {
  selector: string;
  tokens: Array<{ name: string; value: string }>;
}

/**
 * Split a token sheet into its blocks and the declarations each carries.
 *
 * Deliberately a small regex parser rather than a CSS library: the sheet is one
 * file of `--name: value;` lines in blocks, the repo forbids a new dependency,
 * and a parser that only has to be right about this shape is easier to trust
 * than one that is right about every shape.
 */
export function parseTokenBlocks(css: string): TokenBlock[] {
  const blocks: TokenBlock[] = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(css)) !== null) {
    const selector = block[1].trim().replace(/\s+/g, " ");
    const body = block[2];
    const tokens: Array<{ name: string; value: string }> = [];
    const declRe = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(body)) !== null) {
      tokens.push({ name: decl[1], value: decl[2].trim() });
    }
    if (tokens.length > 0) blocks.push({ selector, tokens });
  }
  return blocks;
}

/** The first block that declares `name`, which is the light/default value. */
function defaultValue(blocks: TokenBlock[], name: string): string | undefined {
  for (const block of blocks) {
    const hit = block.tokens.find((token) => token.name === name);
    if (hit) return hit.value;
  }
  return undefined;
}

/** Every declared token name, once, in first-seen order. */
export function tokenNames(blocks: TokenBlock[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    for (const token of block.tokens) {
      if (!seen.has(token.name)) {
        seen.add(token.name);
        out.push(token.name);
      }
    }
  }
  return out;
}

/** Tokens whose value reads as a colour rather than a size or a keyword. */
const COLOUR_VALUE = /^(#|rgb|hsl|color-mix|var\(--)/;

const isColour = (token: { name: string; value: string }): boolean =>
  COLOUR_VALUE.test(token.value) &&
  !/^(--space|--text|--radius|--shadow|--duration|--ease|--weight|--tracking|--target|--field|--control|--icon)/.test(
    token.name,
  );

const SHEET = parseTokenBlocks(tokensCss);
const NAMES = tokenNames(SHEET);

/** The token groups a specimen covers, keyed by the guard's expectations. */
export const TOKEN_GROUPS = {
  colours: NAMES.filter((name) => {
    const value = defaultValue(SHEET, name) ?? "";
    return isColour({ name, value });
  }),
  type: NAMES.filter((name) => /^--(text|font|weight|tracking|leading)-/.test(name)),
  spacing: NAMES.filter((name) => /^--space-/.test(name)),
  radii: NAMES.filter((name) => /^--radius-/.test(name)),
  shadows: NAMES.filter((name) => /^--(shadow|ring)/.test(name)),
  motion: NAMES.filter((name) => /^--(duration|ease|stagger)-/.test(name)),
  metrics: NAMES.filter((name) =>
    /^--(target|field|control|icon|cover-banner|hairline|segment|content-max-w)(-|$)/.test(name),
  ),
  zIndex: NAMES.filter((name) => /^--z-/.test(name)),
} as const;

const SPECIMEN_STYLE: CSSProperties = {
  padding: "var(--space-4)",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
};

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "var(--space-3)",
};

const CELL_STYLE: CSSProperties = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
};

const CAPTION_STYLE: CSSProperties = {
  padding: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  wordBreak: "break-all",
};

const LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: "var(--space-3) 0 var(--space-2)",
};

/** A swatch per colour token. The background is the parsed value, not a literal. */
export function ColoursSpecimen(): ReactNode {
  const tokens = TOKEN_GROUPS.colours;
  return (
    <div style={SPECIMEN_STYLE}>
      <div style={LABEL_STYLE}>{tokens.length} colour tokens, read from the sheet</div>
      <div style={GRID_STYLE}>
        {tokens.map((name) => (
          <div key={name} style={CELL_STYLE}>
            <div
              style={{
                height: "var(--space-7)",
                background: `var(${name})`,
                borderBlockEnd: "1px solid var(--line-1)",
              }}
            />
            <div style={CAPTION_STYLE}>
              {name}
              <br />
              {defaultValue(SHEET, name)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One `.t-*` role: the three properties that only mean something together. */
export interface TypeRole {
  role: string;
  size: string;
  leading: string;
  weight: string;
  tracking: string;
  transform: string;
}

/**
 * The type roles, read from the component sheet that ships (myne-md/myne#847
 * task 13).
 *
 * A size on its own is half a specimen: `--text-3xl` at `--leading-tight` is a
 * heading, the same size at `--leading-relaxed` is a pull quote, and a reader
 * shown only the size learns neither. So the page reads the pairing from
 * `src/styles/tokens.css`'s `.t-*` blocks rather than from a second table here,
 * because a hand-copied pairing is a pairing that drifts and the drift is
 * invisible: both values still resolve.
 *
 * Pure and exported, so the pairing is asserted rather than eyeballed.
 */
export function parseTypeRoles(css: string): TypeRole[] {
  const out: TypeRole[] = [];
  const blockRe = /\.(t-[a-z0-9-]+)\s*\{([^}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(css)) !== null) {
    const decls = new Map<string, string>();
    const declRe = /([a-z-]+)\s*:\s*([^;]+);/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(block[2])) !== null) decls.set(decl[1], decl[2].trim());
    const size = decls.get("font-size");
    // A role with no size is a family or a colour variant, not a step on the
    // scale, and rendering it would put a duplicate line in the specimen.
    if (size === undefined) continue;
    out.push({
      role: block[1],
      size,
      leading: decls.get("line-height") ?? "",
      weight: decls.get("font-weight") ?? "",
      tracking: decls.get("letter-spacing") ?? "",
      transform: decls.get("text-transform") ?? "",
    });
  }
  return out;
}

const SAMPLE_INPUT_STYLE: CSSProperties = {
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
};

export function TypeSpecimen(): ReactNode {
  const [sample, setSample] = useState("The quick brown fox jumps over the lazy dog");
  const roles = parseTypeRoles(stylesCss);
  const sizes = TOKEN_GROUPS.type.filter((name) => name.startsWith("--text-"));

  return (
    <div style={SPECIMEN_STYLE}>
      {/* The sample is the reviewer's own text, because a fixed sentence hides
          the thing type is judged on: the letters they actually read. */}
      <label style={LABEL_STYLE} htmlFor="stories.type.sample">
        Sample text, applied to every role below
      </label>
      <Input
        id="stories.type.sample"
        data-testid="stories.type.sample"
        value={sample}
        onChange={(event) => setSample(event.target.value)}
        style={SAMPLE_INPUT_STYLE}
      />

      <div style={LABEL_STYLE}>
        The roles: size, line-height and weight together, read from the component sheet
      </div>
      {roles.map((role) => (
        <div key={role.role} style={{ marginBlockEnd: "var(--space-4)" }}>
          <div style={CAPTION_STYLE}>
            .{role.role} · {role.size} · {role.leading || "inherited"} ·{" "}
            {role.weight || "inherited"}
          </div>
          <div
            style={{
              fontSize: role.size,
              lineHeight: role.leading,
              fontWeight: role.weight,
              letterSpacing: role.tracking,
              textTransform: role.transform as CSSProperties["textTransform"],
              color: "var(--fg-1)",
            }}
          >
            {sample}
          </div>
        </div>
      ))}

      <div style={LABEL_STYLE}>Every size token, on its own</div>
      {sizes.map((name) => (
        <div key={name} style={{ marginBlockEnd: "var(--space-3)" }}>
          <div style={CAPTION_STYLE}>
            {name} {defaultValue(SHEET, name)}
          </div>
          <div style={{ fontSize: `var(${name})`, color: "var(--fg-1)" }}>{sample}</div>
        </div>
      ))}
    </div>
  );
}

export function SpacingSpecimen(): ReactNode {
  return (
    <div style={SPECIMEN_STYLE}>
      {TOKEN_GROUPS.spacing.map((name) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span style={{ ...CAPTION_STYLE, width: "var(--space-8)" }}>{name}</span>
          <span
            style={{
              display: "inline-block",
              width: `var(${name})`,
              height: "var(--space-3)",
              background: "var(--accent)",
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function RadiiSpecimen(): ReactNode {
  return (
    <div style={{ ...SPECIMEN_STYLE, ...GRID_STYLE }}>
      {TOKEN_GROUPS.radii.map((name) => (
        <div key={name}>
          <div
            style={{
              height: "var(--space-7)",
              background: "var(--bg-3)",
              border: "1px solid var(--line-2)",
              borderRadius: `var(${name})`,
            }}
          />
          <div style={CAPTION_STYLE}>
            {name} {defaultValue(SHEET, name)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ShadowsSpecimen(): ReactNode {
  return (
    <div style={{ ...SPECIMEN_STYLE, ...GRID_STYLE }}>
      {TOKEN_GROUPS.shadows.map((name) => (
        <div key={name}>
          <div
            style={{
              height: "var(--space-7)",
              background: "var(--bg-2)",
              borderRadius: "var(--radius-2)",
              boxShadow: `var(${name})`,
            }}
          />
          <div style={CAPTION_STYLE}>{name}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * An easing token's `cubic-bezier(a, b, c, d)` as an SVG path (myne-md/myne#847
 * task 12).
 *
 * Four numbers are not a shape: the whole point of an easing curve is how it
 * leaves and arrives, and reading `0.2, 0, 0, 1` tells a reviewer nothing about
 * that. Pure, so it is asserted rather than eyeballed.
 *
 * The path is drawn in a 100x100 box with the y-axis flipped, because SVG grows
 * downward and an easing curve is plotted upward.
 */
export function curvePath(value: string): string | null {
  const match = value.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  if (match === null) return null;
  const [x1, y1, x2, y2] = match.slice(1, 5).map(Number);
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return null;
  const px = (x: number) => Math.round(x * 100);
  const py = (y: number) => Math.round(100 - y * 100);
  return `M 0 100 C ${px(x1)} ${py(y1)}, ${px(x2)} ${py(y2)}, 100 0`;
}

/**
 * The easing tokens, each drawn as its own curve.
 */
export function EasingSpecimen(): ReactNode {
  const easings = TOKEN_GROUPS.motion.filter((name) => name.startsWith("--ease-"));
  return (
    <div style={{ ...SPECIMEN_STYLE, ...GRID_STYLE }}>
      {easings.map((name) => {
        const value = defaultValue(SHEET, name) ?? "";
        const path = curvePath(value);
        return (
          <div key={name}>
            {path === null ? (
              <div style={{ ...CAPTION_STYLE }}>not a cubic-bezier</div>
            ) : (
              <svg viewBox="0 0 100 100" width="100%" height="var(--space-8)" role="img" aria-label={`${name} curve`}>
                <rect x="0" y="0" width="100" height="100" fill="var(--bg-2)" />
                <path d={path} fill="none" stroke="var(--accent)" strokeWidth="3" />
              </svg>
            )}
            <div style={CAPTION_STYLE}>
              {name}
              <br />
              {value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One duration token, with a control that RUNS it.
 *
 * The first version of this page declared a `transition` and never changed the
 * property, so nothing ever animated: it showed a duration it did not exercise.
 * Here the control flips the transform, so 120ms can be felt against 180ms
 * rather than read off a table (myne-md/myne#847 task 12).
 */
function MotionRow({ name }: { name: string }) {
  const [moved, setMoved] = useState(false);
  const travel = moved ? "translateX(var(--space-7))" : "none";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
      <Button
        variant="secondary"
        onClick={() => setMoved((on) => !on)}
        data-testid={`stories.motion.replay.${name}`}
      >
        Replay
      </Button>
      <span style={{ ...CAPTION_STYLE, width: "var(--space-9)" }}>{name}</span>
      {/* The two renderings sit BESIDE each other: "the same press under reduced
          motion" is the comparison the token exists to answer, and a caption
          describing it is not the same as seeing it (myne-md/myne#847 review). */}
      <span
        aria-hidden="true"
        title="normal"
        style={{
          display: "inline-block",
          width: "var(--space-4)",
          height: "var(--space-4)",
          borderRadius: "var(--radius-1)",
          background: "var(--accent)",
          // The token under test IS the transition, so the specimen is the value.
          transition: `transform var(${name}) var(--ease-standard)`,
          transform: travel,
        }}
      />
      <span
        aria-hidden="true"
        title="reduced motion"
        style={{
          display: "inline-block",
          width: "var(--space-4)",
          height: "var(--space-4)",
          borderRadius: "var(--radius-1)",
          background: "var(--accent)",
          // What the shared sheet already does under `prefers-reduced-motion`: it
          // zeroes the transition, so the same press produces no travel. Shown
          // rather than invented, which is the point of the axis.
          transition: "none",
          transform: travel,
        }}
      />
      <span style={{ ...CAPTION_STYLE }}>{defaultValue(SHEET, name)}</span>
    </div>
  );
}

/**
 * The press treatment, on a surface a reviewer can actually press.
 *
 * The motion rows above replay durations; this shows the OTHER half of the same
 * system, which is what a press looks like and where the value comes from. Two
 * steps exist: `--accent-press` on an accent call to action, and the
 * theme-independent neutral mix on everything else (`design-notes/ui/0683`
 * records why the neutral one is a mix rather than the `--line-1` rung).
 *
 * The three controls deliberately come from two different mechanisms, because
 * that split is the thing worth seeing: the first is a class-based control whose
 * press is the component layer's `:active` rule (and so also fires for a keyboard
 * user), and the other two are inline-styled surfaces driven by
 * `interactiveSurface`, which is what a surface with a computed fill uses.
 */
export function PressSpecimen(): ReactNode {
  const neutral = interactiveSurface({ hoverBg: "var(--bg-3)" });
  const accent = interactiveSurface({
    restBg: "var(--accent)",
    hoverBg: "var(--accent-hover)",
    accent: true,
  });
  return (
    <div style={SPECIMEN_STYLE}>
      <div style={LABEL_STYLE}>
        Press each control. The class-based button takes its press from the shared
        `.myne-btn:enabled:active` rule, so a keyboard user gets the same step; the two
        inline surfaces take theirs from the press primitive.
      </div>
      <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
        <button type="button" data-variant="primary" className="myne-btn">
          Primary
        </button>
        {/* Both of these are deliberately raw `<button>`s rather than
            `<Button>`s: the specimen's whole point is to show what the
            INLINE-STYLED surfaces do, which is the majority the app actually has
            and the case the primitive exists for. `check-primitive-adoption`
            counts them, so this comment is what that guard asks for at a
            call site that genuinely is not a primitive. */}
        <button
          type="button"
          {...neutral}
          style={{ background: "transparent", padding: "var(--space-3) var(--space-4)" }}
        >
          Neutral surface
        </button>
        <button
          type="button"
          {...accent}
          style={{
            background: "var(--accent)",
            color: "var(--accent-on)",
            padding: "var(--space-3) var(--space-4)",
          }}
        >
          Accent surface
        </button>
      </div>
      <div style={{ ...CAPTION_STYLE, marginBlockStart: "var(--space-3)" }}>
        The neutral step is the same size in every palette, which the mix is why: a step measured in
        the `--line-1` border token is 9/255 on light and dark but 18/255 on amoled.
      </div>
    </div>
  );
}

export function MotionSpecimen(): ReactNode {
  const durations = TOKEN_GROUPS.motion.filter((name) => name.startsWith("--duration-"));
  return (
    <div style={SPECIMEN_STYLE}>
      <div style={LABEL_STYLE}>
        Press Replay to run the transition at that token. The duration under test is the
        transition, so the specimen is the value rather than a picture of it.
      </div>
      {durations.map((name) => (
        <MotionRow key={name} name={name} />
      ))}
      <div style={{ ...CAPTION_STYLE, marginBlockStart: "var(--space-4)" }}>
        The second square in each row is the same press under reduced motion. The shared sheet
        already zeroes every transition under the global rule, so the view shows an existing
        behaviour rather than inventing a policy.
      </div>
    </div>
  );
}

/** Control metrics: the hit-target floor, field and control padding, icon sizes. */
export function MetricsSpecimen(): ReactNode {
  return (
    <div style={SPECIMEN_STYLE}>
      {TOKEN_GROUPS.metrics.map((name) => (
        <div key={name} style={{ display: "flex", gap: "var(--space-3)" }}>
          <span style={{ ...CAPTION_STYLE, width: "var(--space-9)" }}>{name}</span>
          <span style={CAPTION_STYLE}>{defaultValue(SHEET, name)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The layering ladder, painted low to high.
 *
 * The order IS the specimen: each box carries its token as `z-index`, so at a
 * given overlap the box on top is the higher step. Reading the stack is reading
 * the ladder, which is the one thing a bare `z-index:` literal could never show.
 */
export function ZIndexSpecimen(): ReactNode {
  const tokens = TOKEN_GROUPS.zIndex
    .map((name) => ({ name, value: Number.parseInt(defaultValue(SHEET, name) ?? "0", 10) }))
    .sort((a, b) => a.value - b.value);

  return (
    <div style={SPECIMEN_STYLE}>
      <div style={LABEL_STYLE}>
        {tokens.length} layering tokens, painted in order. A box that covers its neighbour
        is the higher step.
      </div>
      <div
        style={{
          position: "relative",
          height: `calc(var(--space-3) * ${tokens.length} + var(--space-8))`,
        }}
      >
        {tokens.map((token, index) => (
          <div
            key={token.name}
            style={{
              position: "absolute",
              insetInlineStart: `calc(var(--space-3) * ${index})`,
              insetBlockStart: `calc(var(--space-3) * ${index})`,
              // The token IS the value under test, so the stack is the ladder.
              zIndex: `var(${token.name})` as CSSProperties["zIndex"],
              padding: "var(--space-1) var(--space-2)",
              background: "var(--bg-2)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-2)",
              whiteSpace: "nowrap",
            }}
          >
            {token.name}
          </div>
        ))}
      </div>
      <ul style={{ listStyle: "none", margin: "var(--space-5) 0 0", padding: 0 }}>
        {tokens.map((token) => (
          <li key={token.name} style={CAPTION_STYLE}>
            {token.name} {token.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IconsSpecimen(): ReactNode {
  const names = Object.keys(ICON_PATHS) as IconName[];
  return (
    <div style={{ ...SPECIMEN_STYLE, ...GRID_STYLE }}>
      {names.map((name) => (
        <div key={name} style={{ ...CELL_STYLE, padding: "var(--space-3)" }}>
          <Icon name={name} size={20} />
          <div style={CAPTION_STYLE}>{name}</div>
        </div>
      ))}
    </div>
  );
}

/** The specimens, and the story each one is addressable as. */
export const FOUNDATION_STORIES: StoryDescriptor[] = [
  {
    id: "foundations/tokens/colours",
    group: "foundations",
    surface: "Tokens",
    state: "colours",
    description:
      "Every colour token in the sheet as a swatch, read from client-core/src/tokens.css so it cannot drift.",
    tags: ["tokens", "colour", "palette", "foundations"],
    render: () => <ColoursSpecimen />,
  },
  {
    id: "foundations/tokens/type",
    group: "foundations",
    surface: "Tokens",
    state: "type",
    description:
      "The type scale with an editable sample, each role's size, line-height and weight together.",
    tags: ["tokens", "type", "font", "leading", "weight", "foundations"],
    render: () => <TypeSpecimen />,
  },
  {
    id: "foundations/tokens/spacing",
    group: "foundations",
    surface: "Tokens",
    state: "spacing",
    description: "The spacing scale as measured bars, so a gap can be read as a value.",
    tags: ["tokens", "spacing", "layout", "foundations"],
    render: () => <SpacingSpecimen />,
  },
  {
    id: "foundations/tokens/radii",
    group: "foundations",
    surface: "Tokens",
    state: "radii",
    description: "Every radius token applied to a box.",
    tags: ["tokens", "radius", "foundations"],
    render: () => <RadiiSpecimen />,
  },
  {
    id: "foundations/tokens/shadows",
    group: "foundations",
    surface: "Tokens",
    state: "shadows",
    description: "Every elevation token applied to a card.",
    tags: ["tokens", "shadow", "elevation", "foundations"],
    render: () => <ShadowsSpecimen />,
  },
  {
    id: "foundations/tokens/motion",
    group: "foundations",
    surface: "Tokens",
    state: "motion",
    description:
      "The duration and easing tokens: each duration replays on demand, and each easing is drawn as its curve.",
    tags: ["tokens", "motion", "animation", "easing", "foundations"],
    render: () => (
      <>
        <MotionSpecimen />
        <EasingSpecimen />
        <PressSpecimen />
      </>
    ),
  },
  {
    id: "foundations/tokens/metrics",
    group: "foundations",
    surface: "Tokens",
    state: "metrics",
    description:
      "Control metrics: the pointer-target floor, field and control padding and gaps, and icon sizes.",
    tags: ["tokens", "metrics", "target", "spacing", "foundations"],
    render: () => <MetricsSpecimen />,
  },
  {
    id: "foundations/tokens/z-index",
    group: "foundations",
    surface: "Tokens",
    state: "z-index",
    description:
      "The stacking ladder, painted in order so which step covers which is visible rather than asserted.",
    tags: ["tokens", "z-index", "layering", "stacking", "foundations"],
    render: () => <ZIndexSpecimen />,
  },
  {
    id: "foundations/icons/default",
    group: "foundations",
    surface: "Icons",
    state: "default",
    description: "Every icon in the registry, read from src/lib/icons.ts.",
    tags: ["icons", "glyphs", "foundations"],
    render: () => <IconsSpecimen />,
  },
];
