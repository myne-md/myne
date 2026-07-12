import { type ReactNode, useMemo, useState } from "react";
import { Icon, Sheet } from "../../../../components";
import { HAS_TAURI } from "../../../../lib/app-window";
import { upsertSavedView, setViewOrder } from "../../../../lib/prefs";
import { foldSegment } from "../../../../dialect/folderPath";
import type { SavedView } from "../../../../lib/prefs";

/** Tag Browser (mobile port of the desktop bottom-bar TagBrowser, Image #26):
 *  multi-select tag chips + an All/Any match mode, a live matching-notes list,
 *  and Save-as-view / Clear. Distinct from the right-panel Unlinked-mentions
 *  tab — same `#` glyph, different feature. Filtering is a client-side set
 *  algebra over `byTag` (AND = intersection, OR = union), gated to live ids. */
export function TagBrowserSheet({
  onClose,
  tags,
  byTag,
  liveIds,
  titleById,
  viewOrder,
  onOpenNote,
  onSavedView,
}: {
  onClose: () => void;
  tags: { tag: string; count: number }[];
  byTag: Map<string, string[]>;
  liveIds: Set<string>;
  titleById: Map<string, string>;
  viewOrder: string[];
  onOpenNote: (id: string) => void;
  onSavedView: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"all" | "any">("all");
  const [q, setQ] = useState("");
  const [savingName, setSavingName] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  const displayByKey = useMemo(() => new Map(tags.map((t) => [foldSegment(t.tag), t.tag])), [tags]);
  const needle = foldSegment(q.trim());
  const shownTags = needle ? tags.filter((t) => foldSegment(t.tag).includes(needle)) : tags;

  const matchIds = useMemo(() => {
    const keys = [...selected];
    if (keys.length === 0) return [];
    let acc: Set<string> | null = null;
    for (const k of keys) {
      const ids = new Set((byTag.get(k) ?? []).filter((id) => liveIds.has(id)));
      if (acc === null) acc = ids;
      else if (mode === "all") {
        const nx = new Set<string>();
        for (const id of acc) if (ids.has(id)) nx.add(id);
        acc = nx;
      } else {
        for (const id of ids) acc.add(id);
      }
    }
    return [...(acc ?? new Set<string>())];
  }, [selected, mode, byTag, liveIds]);

  const toggle = (k: string) =>
    setSelected((prev) => {
      const nx = new Set(prev);
      nx.has(k) ? nx.delete(k) : nx.add(k);
      return nx;
    });

  async function saveView() {
    const name = (savingName ?? "").trim();
    if (name === "" || selected.size === 0) return;
    setSaveBusy(true);
    const children = [...selected].map((k) => ({ kind: "hasTag" as const, tag: displayByKey.get(k) ?? k }));
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      view_type: "list",
      filters: mode === "all" ? { kind: "and", children } : { kind: "or", children },
    };
    try {
      if (HAS_TAURI) {
        await upsertSavedView(view);
        await setViewOrder([...viewOrder, view.id]);
      }
      onSavedView(view.id);
    } catch {
      setSaveBusy(false);
    }
  }

  const modeBtn = (m: "all" | "any", txt: string): ReactNode => (
    <button
      onClick={() => setMode(m)}
      style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", background: mode === m ? "var(--bg-1)" : "transparent", color: mode === m ? "var(--fg-1)" : "var(--fg-3)", fontSize: 13, fontWeight: mode === m ? 600 : 500, fontFamily: "var(--font-sans)", cursor: "pointer" }}
    >
      {txt}
    </button>
  );

  return (
    <Sheet onClose={onClose} style={{ maxHeight: "86%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 8 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Tags</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>

          {/* Search + All/Any toggle */}
          <div style={{ flex: "none", display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, height: 40, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--bg-2)", padding: "0 11px" }}>
              <Icon name="search" size={16} color="var(--fg-3)" strokeWidth={1.7} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tags…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--fg-1)" }}
              />
            </div>
            <div style={{ flex: "none", display: "flex", gap: 3, background: "var(--bg-2)", border: "1px solid var(--line-2)", borderRadius: 8, padding: 3, width: 110 }}>
              {modeBtn("all", "All")}
              {modeBtn("any", "Any")}
            </div>
          </div>

          {/* Tag chips — tap to toggle into the filter */}
          <div style={{ flex: "none", display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0" }}>
            {shownTags.map((t) => {
              const k = foldSegment(t.tag);
              const on = selected.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggle(k)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${on ? "var(--accent)" : "var(--line-2)"}`, borderRadius: 999, background: on ? "var(--accent-soft)" : "var(--bg-2)", color: on ? "var(--accent)" : "var(--fg-2)", fontSize: 13, fontFamily: "var(--font-sans)", padding: "5px 12px", cursor: "pointer" }}
                >
                  #{t.tag}
                  {t.count > 1 && <span style={{ opacity: 0.6 }}>{t.count}</span>}
                </button>
              );
            })}
            {shownTags.length === 0 && <span style={{ fontSize: 14, color: "var(--fg-3)", padding: "4px 2px" }}>No tags match.</span>}
          </div>

          {/* Results: NOTES count + Save-as-view / Clear, then the matching notes */}
          {selected.size > 0 && (
            <>
              <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid var(--line-1)", paddingTop: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)" }}>Notes · {matchIds.length}</span>
                <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
                  {matchIds.length > 0 && (
                    <button onClick={() => setSavingName("")} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>Save as view</button>
                  )}
                  <button onClick={() => setSelected(new Set())} style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>Clear</button>
                </div>
              </div>

              {savingName !== null && (
                <div style={{ flex: "none", display: "flex", gap: 8, marginTop: 10 }}>
                  <input
                    value={savingName}
                    onChange={(e) => setSavingName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveView()}
                    placeholder="View name"
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    style={{ flex: 1, minWidth: 0, height: 40, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--bg-1)", padding: "0 12px", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--fg-1)", outline: "none", boxSizing: "border-box" }}
                  />
                  <button
                    onClick={() => void saveView()}
                    disabled={saveBusy || savingName.trim() === ""}
                    style={{ flex: "none", height: 40, padding: "0 16px", border: "none", borderRadius: 9, background: "var(--accent)", color: "var(--accent-on)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: saveBusy || savingName.trim() === "" ? 0.5 : 1 }}
                  >
                    Save
                  </button>
                </div>
              )}

              <div style={{ overflowY: "auto", minHeight: 0, marginTop: 8 }}>
                {matchIds.map((id) => (
                  <button
                    key={id}
                    onClick={() => { close(); onOpenNote(id); }}
                    style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: "1px solid var(--line-1)", background: "transparent", padding: "12px 4px", fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {titleById.get(id) || "Untitled note"}
                  </button>
                ))}
                <div style={{ height: "calc(8px + env(safe-area-inset-bottom, 0px))" }} />
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
