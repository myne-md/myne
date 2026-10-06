// The graph's hover-highlight policy (myne-md/myne#727), as a pure module.
//
// "What does hovering a node highlight" is a decision rather than plumbing: the
// node itself, its immediate neighbours, and the edges that touch it stay at
// full strength while everything else recedes. Keeping it here means the answer
// is asserted directly instead of being inferred from what a canvas happened to
// paint.

/** Alpha applied to everything outside a hover highlight. Chosen so a dimmed
 *  element still reads as present, this is a graph being read, not a modal
 *  hiding things, while the highlighted structure is unambiguous. It is a
 *  canvas draw value rather than a design token because the token sheet has no
 *  opacity axis at all; the COLOURS being dimmed are all token-derived. */
export const HOVER_DIM_ALPHA = 0.18;

/** The node ids and edge keys a hover keeps at full strength. */
export interface HoverHighlight {
  /** The node the pointer is over. Carried explicitly rather than inferred from
   *  the membership sets, because the renderer draws an anchor ring on it and
   *  "the node that is in `nodes` and is not a neighbour" is not a question the
   *  sets can answer. */
  id: string;
  /** The hovered node and its immediate neighbours. */
  nodes: ReadonlySet<string>;
  /** {@link edgeKey} of every edge incident to the hovered node. */
  edges: ReadonlySet<string>;
}

/**
 * The key identifying an edge. Direction is part of the identity, because the
 * renderer draws directed edges and an arrowhead belongs to the direction it
 * points in. A `\u0000` separator cannot occur in a note id.
 */
export function edgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

/**
 * Build the highlight for a hovered node, or `null` when nothing is hovered.
 * `links` is the renderer's own link list, already resolved to ids.
 */
export function buildHoverHighlight(
  hoveredId: string | null,
  links: ReadonlyArray<{ source: string; target: string }>,
): HoverHighlight | null {
  if (hoveredId === null) return null;
  const nodes = new Set<string>([hoveredId]);
  const edges = new Set<string>();
  for (const l of links) {
    if (l.source !== hoveredId && l.target !== hoveredId) continue;
    edges.add(edgeKey(l.source, l.target));
    nodes.add(l.source);
    nodes.add(l.target);
  }
  return { id: hoveredId, nodes, edges };
}

/** Whether a node is at full strength under a highlight. */
export function nodeIsLit(hover: HoverHighlight | null, id: string): boolean {
  return hover === null || hover.nodes.has(id);
}

/** Whether an edge is at full strength under a highlight. */
export function edgeIsLit(
  hover: HoverHighlight | null,
  source: string,
  target: string,
): boolean {
  return hover === null || hover.edges.has(edgeKey(source, target));
}

/** The alpha to draw an element at, given whether it is lit. */
export function highlightAlpha(
  hover: HoverHighlight | null,
  lit: boolean,
): number {
  return hover === null || lit ? 1 : HOVER_DIM_ALPHA;
}

/**
 * Resting alpha for an EDGE with nothing hovered.
 *
 * Edges were drawn fully opaque, which makes a dense hub read as a solid fan of
 * lines with dots on the ends — the connections out-weigh the notes, and the
 * notes are the content. Pulling them back lets the nodes sit in front of their
 * own structure without losing it.
 */
export const EDGE_REST_ALPHA = 0.5;

/**
 * Alpha for an edge that IS lit during a hover.
 *
 * Still clearly the brightest thing on screen — it is answering "which
 * connections are this note's" — but not a hard accent line, which at full
 * opacity across a hundred-edge hub reads as a starburst rather than a
 * highlight.
 */
export const EDGE_LIT_ALPHA = 0.8;

/**
 * The alpha to draw an EDGE at. Separate from {@link highlightAlpha} because
 * edges and nodes want different weights: dimming a node hides content, while
 * dimming an edge reveals it.
 */
export function edgeAlpha(hover: HoverHighlight | null, lit: boolean): number {
  if (hover === null) return EDGE_REST_ALPHA;
  return lit ? EDGE_LIT_ALPHA : HOVER_DIM_ALPHA;
}
