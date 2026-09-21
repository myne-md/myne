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
