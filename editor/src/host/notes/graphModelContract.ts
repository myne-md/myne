// The cross-client graph-model contract (myne-md/myne#199).
//
// One fixture vault, one expected `{nodes, edges}`. Every client feeds its OWN
// extraction pipeline with these bodies and must land on the same summary —
// which is the assertion `tests/notes/graphModel.test.ts` (desktop) and
// `tests/wikilinks.test.ts` (mobile) each make. Modelled on
// `tests/platform/seam-contract.ts`: one set of assertions, run against every
// implementation, rather than two suites that can both be green against two
// different answers. That is exactly how the clients drifted — mobile's regex
// extractor + flat `titleKey → first match` lookup silently disagreed with the
// shared resolver on path-form links, `.md` links, title collisions and links
// inside code fences.
//
// Framework-free on purpose (no vitest import): a shared source package must
// not carry a test runner. Each repo's spec compares `summarizeGraphModel(...)`
// against `GRAPH_CONTRACT_EXPECTATION` with its own `expect`.
//
// Scope note: the contract constrains the MODEL — bodies + a given note-set in,
// nodes + edges out. How a client derives its note-set from the vault (which
// notes are resolver-visible) is asserted by that client's own specs.

import type { GraphModel } from "./graphModel";
import type { ResolverNote } from "./resolveWikilink";

/** A fixture note: the resolver's view of it plus the raw body its client
 *  extracts edges from. */
export interface GraphContractNote extends ResolverNote {
  body: string;
}

const lines = (...l: string[]): string => l.join("\n");

/**
 * The fixture vault. Every case that made the two clients disagree is here,
 * plus the cases that must keep working.
 */
export const GRAPH_CONTRACT_NOTES: ReadonlyArray<GraphContractNote> = [
  {
    // Every link form that must resolve to the SAME target note, plus the three
    // that must produce nothing: a media embed, a self-link and a broken link.
    noteUuid: "n-alpha",
    title: "Alpha",
    folder: null,
    body: lines(
      "Plain [[Beta]] and again [[Beta]].",
      "Alias [[Beta|b]], anchor [[Beta#Section]], block [[Beta^blk]].",
      "Embed ![[Beta]] and media ![[diagram.png]].",
      "Self [[Alpha]] and broken [[Nope]].",
    ),
  },
  { noteUuid: "n-beta", title: "Beta", folder: null, body: "Just a target.\n" },
  {
    // Structurally isolated: no links out, none in. It is still a NODE — the
    // desktop graph has always shown orphans, mobile used to hide them.
    noteUuid: "n-orphan",
    title: "Orphan",
    folder: null,
    body: "Nothing links here.\n",
  },
  {
    // Exists so a link to it from an exclusion zone would resolve if the
    // extractor were regex-based — i.e. the phantom edge has somewhere to go.
    noteUuid: "n-ghost",
    title: "Ghost",
    folder: null,
    body: "Nobody should link to me.\n",
  },
  {
    // Exclusion zones: `[[Ghost]]` in frontmatter and inside a fenced code
    // block must NOT become edges, while the ordinary link below must.
    noteUuid: "n-fence",
    title: "Fence",
    folder: null,
    body: lines(
      "---",
      "title: Fence",
      'note: "[[Ghost]] in frontmatter is not a link"',
      "---",
      "",
      "```",
      "[[Ghost]] inside a fenced block is not a link",
      "```",
      "",
      "But [[Beta]] is.",
    ),
  },
  { noteUuid: "n-work-report", title: "Report", folder: "Work/", body: "" },
  { noteUuid: "n-personal-report", title: "Report", folder: "Personal/", body: "" },
  {
    // Title collision. `[[Work/Report]]` is disambiguated by its folder
    // segment; the bare and `.md` forms fall back to the shortest-path rule
    // (equal depth → lexicographic folded folder, so "personal/" wins).
    noteUuid: "n-linker",
    title: "Linker",
    folder: null,
    body: lines("See [[Work/Report]].", "Also [[Report.md]] and [[Report]]."),
  },
  {
    // An archived note is resolver-visible on desktop by an explicit decision
    // (`src/notes/resolverNotes.ts`), so its links are real edges.
    noteUuid: "n-archived",
    title: "Archived",
    folder: null,
    body: lines("---", "title: Archived", "archived: 2026-01-01T00:00:00Z", "---", "", "Still links to [[Beta]]."),
  },
  {
    noteUuid: "n-projects-index",
    title: "Projects",
    folder: "Projects/",
    folderIndex: true,
    body: "",
  },
  {
    // Folder-target form (MYND-370) resolves to the folder's index note.
    noteUuid: "n-folder-linker",
    title: "FolderLinker",
    folder: null,
    body: "Everything under [[Projects/]].\n",
  },
];

/** The note-set the resolver runs against (the fixture minus the bodies). */
export const GRAPH_CONTRACT_RESOLVER_NOTES: ReadonlyArray<ResolverNote> =
  GRAPH_CONTRACT_NOTES.map(({ body: _body, ...note }) => note);

/** A canonical, order-independent summary of a built model — what both repos'
 *  specs compare. Edges read `<source>-><target>x<weight>`. */
export interface GraphModelSummary {
  nodes: string[];
  edges: string[];
}

export function summarizeGraphModel(model: GraphModel): GraphModelSummary {
  return {
    nodes: model.nodes.map((n) => n.id).sort(),
    edges: model.edges
      .map((e) => `${e.source}->${e.target}x${e.weight}`)
      .sort(),
  };
}

/**
 * The one right answer. Derived from the shared implementation's behaviour:
 *
 * - `n-alpha->n-beta` collapses SIX occurrences (plain ×2, alias, anchor,
 *   block-ref, note embed) into one weighted edge; the media embed, the
 *   self-link and the broken link contribute nothing.
 * - `n-fence` contributes exactly one edge — the two `[[Ghost]]` occurrences
 *   sit in exclusion zones, so `n-ghost` has no inbound edge at all.
 * - `n-linker` splits: the path-form link resolves to the Work note, while the
 *   bare and `.md` forms both take the shortest-path fallback to the Personal
 *   one (weight 2).
 * - `n-orphan` and `n-ghost` are nodes with no edges.
 */
export const GRAPH_CONTRACT_EXPECTATION: GraphModelSummary = {
  nodes: [
    "n-alpha",
    "n-archived",
    "n-beta",
    "n-fence",
    "n-folder-linker",
    "n-ghost",
    "n-linker",
    "n-orphan",
    "n-personal-report",
    "n-projects-index",
    "n-work-report",
  ],
  edges: [
    "n-alpha->n-betax6",
    "n-archived->n-betax1",
    "n-fence->n-betax1",
    "n-folder-linker->n-projects-indexx1",
    "n-linker->n-personal-reportx2",
    "n-linker->n-work-reportx1",
  ],
};
