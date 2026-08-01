import { useTranslation } from "react-i18next";
import type { GraphModel } from "@myne/editor/host/notes/graphModel";
import { WikiGraph } from "../../../../components/WikiGraph";

/** Graph tab — the shared wikilink graph, rendered by the shared canvas
 *  (myne-md/myne#200). The header counts stay: how much of the vault is
 *  actually connected is the question the graph exists to answer. */
export function GraphTab({ model, onOpen }: { model: GraphModel; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const degree = new Map<string, number>();
  for (const e of model.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const linked = model.nodes.filter((n) => (degree.get(n.id) ?? 0) > 0).length;
  const links = model.edges.length;
  return (
    <>
      <div style={{ flex: "none", padding: "8px 20px 0", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>{t("editor.chrome.barItems.graph")}</h1>
        {linked > 0 && (
          <span style={{ flexShrink: 0, fontSize: 13, color: "var(--fg-3)" }}>
            {t("editor.graphTab.linkedNotes", { count: linked })} · {t("editor.graphTab.links", { count: links })}
          </span>
        )}
      </div>
      <WikiGraph model={model} onOpen={onOpen} />
    </>
  );
}
