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

import type { CSSProperties, ReactNode } from "react";
import tokensCss from "../../../client-core/src/tokens.css?raw";
import { Icon } from "@app/components/primitives/Icon";
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

export function TypeSpecimen(): ReactNode {
  const sizes = TOKEN_GROUPS.type.filter((name) => name.startsWith("--text-"));
  return (
    <div style={SPECIMEN_STYLE}>
      {sizes.map((name) => (
        <div key={name} style={{ marginBlockEnd: "var(--space-3)" }}>
          <div style={CAPTION_STYLE}>
            {name} {defaultValue(SHEET, name)}
          </div>
          <div style={{ fontSize: `var(${name})`, color: "var(--fg-1)" }}>
            The quick brown fox jumps over the lazy dog
          </div>
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

export function MotionSpecimen(): ReactNode {
  return (
    <div style={SPECIMEN_STYLE}>
      {TOKEN_GROUPS.motion.map((name) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span style={{ ...CAPTION_STYLE, width: "var(--space-9)" }}>{name}</span>
          <span
            style={{
              display: "inline-block",
              width: "var(--space-4)",
              height: "var(--space-4)",
              borderRadius: "var(--radius-1)",
              background: "var(--accent)",
              // The duration under test, so the specimen is the value itself.
              transition: `transform var(${name}) var(--ease-standard)`,
            }}
          />
          <span style={{ ...CAPTION_STYLE }}>{defaultValue(SHEET, name)}</span>
        </div>
      ))}
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
    description: "The type scale rendered at each size token.",
    tags: ["tokens", "type", "font", "foundations"],
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
    description: "The duration and easing tokens, each named beside its value.",
    tags: ["tokens", "motion", "animation", "foundations"],
    render: () => <MotionSpecimen />,
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
