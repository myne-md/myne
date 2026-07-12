import type { NoteGraph } from "../../../../lib/wikilinks";
import { WikiGraph } from "../../../../components/WikiGraph";

/** Graph tab — a real wikilink graph over the loaded notes (mobile counterpart
 *  to the desktop vault-indices link layer; see lib/wikilinks.ts). */
export function GraphTab({ graph, onOpen }: { graph: NoteGraph; onOpen: (id: string) => void }) {
  const linked = graph.nodes.filter((n) => n.degree > 0).length;
  const links = graph.edges.length;
  return (
    <>
      <div style={{ flex: "none", padding: "8px 20px 0", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>Graph</h1>
        {linked > 0 && (
          <span style={{ flexShrink: 0, fontSize: 13, color: "var(--fg-3)" }}>
            {linked} linked {linked === 1 ? "note" : "notes"} · {links} {links === 1 ? "link" : "links"}
          </span>
        )}
      </div>
      <WikiGraph graph={graph} onOpen={onOpen} />
    </>
  );
}
