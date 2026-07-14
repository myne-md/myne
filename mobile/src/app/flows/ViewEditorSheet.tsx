// Create / edit one saved view (MYND-273, mobile). A flat condition builder over
// the {@link ViewDraft} bridge — the common single-level AND/OR of tag / folder /
// text leaves. Persists via the `prefs` plugin setters (`upsertSavedView`, plus
// `setViewOrder` to append a brand-new view to the display order). Editing an
// AST authored on desktop is lossy (see `view-filter.ts`): only editable leaves
// survive, so re-saving narrows a richer view to what the editor can represent.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Banner, Segmented } from "../../components";
import { upsertSavedView, deleteSavedView, setViewOrder, type SavedView } from "../../lib/prefs";
import { parseFilters, buildFilters, type ViewCondition } from "../../lib/view-filter";

const CONDITION_TYPES: ViewCondition["type"][] = ["tag", "folder", "search"];
/** i18n key per condition type (resolved with `t()` at the render site). */
const CONDITION_LABELS: Record<ViewCondition["type"], string> = {
  tag: "notes.filterBuilder.type.tag",
  folder: "notes.filterBuilder.type.folder",
  search: "viewEditor.condition.search",
};

export interface ViewEditorSheetProps {
  /** The view being edited, or `null` to create a new one. */
  initial: SavedView | null;
  /** Available tag names (no leading `#`) for the tag picker. */
  tags: string[];
  /** Available folder paths (canonical trailing-slash) for the folder picker. */
  folders: string[];
  /** Current display order — a new view's id is appended to it. */
  viewOrder: string[];
  onClose: () => void;
  onSaved: () => void;
}

const btn = (bg: string, fg: string, border = "none"): React.CSSProperties => ({
  width: "100%",
  height: 50,
  border,
  borderRadius: 8,
  background: bg,
  color: fg,
  fontFamily: "var(--font-sans)",
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
});

export function ViewEditorSheet({ initial, tags, folders, viewOrder, onClose, onSaved }: ViewEditorSheetProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const parsed = parseFilters(initial?.filters ?? { kind: "all" });
  const [mode, setMode] = useState<"and" | "or">(parsed.mode);
  const [conditions, setConditions] = useState<ViewCondition[]>(parsed.conditions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus the name field AFTER the sheet's slide-up animation settles (new-view
  // only). Autofocusing on mount would summon the keyboard mid-animation, which
  // fights the bottom-anchored sheet and makes it jump toward the middle then
  // snap back — the janky behaviour the other (non-focusing) sheets don't have.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initial !== null) return;
    const t = window.setTimeout(() => nameRef.current?.focus(), 320);
    return () => window.clearTimeout(t);
  }, [initial]);

  const setCondition = (i: number, next: ViewCondition) =>
    setConditions((cs) => cs.map((c, j) => (j === i ? next : c)));
  const removeCondition = (i: number) => setConditions((cs) => cs.filter((_, j) => j !== i));
  const addCondition = () =>
    setConditions((cs) => [...cs, { type: "tag", value: tags[0] ?? "" }]);

  async function save() {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    const isNew = initial === null;
    const id = initial?.id ?? crypto.randomUUID();
    const view: SavedView = {
      ...(initial ?? {}),
      id,
      name: trimmed,
      view_type: initial?.view_type ?? "list",
      filters: buildFilters({ mode, conditions }),
    };
    try {
      await upsertSavedView(view);
      if (isNew) await setViewOrder([...viewOrder, id]);
      onSaved();
      onClose();
    } catch {
      setError(t("viewEditor.saveError"));
      setBusy(false);
    }
  }

  async function remove() {
    if (initial === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSavedView(initial.id);
      onSaved();
      onClose();
    } catch {
      setError(t("viewEditor.deleteError"));
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>
            {initial === null ? t("notes.list.newViewTitle") : t("viewEditor.editView")}
          </div>

          {error && (
            <div style={{ marginTop: 12 }}>
              <Banner kind="danger">{error}</Banner>
            </div>
          )}

          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("notes.tagBrowser.viewNamePlaceholder")}
            style={{
              marginTop: 14,
              width: "100%",
              height: 48,
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              background: "var(--bg-1)",
              padding: "0 14px",
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              color: "var(--fg-1)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />

          {conditions.length > 1 && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--fg-3)", flexShrink: 0 }}>{t("notes.filterBuilder.match")}</span>
              <Segmented
                options={[t("notes.tagBrowser.modeAll"), t("notes.tagBrowser.modeAny")]}
                active={mode === "and" ? 0 : 1}
                onChange={(i) => setMode(i === 0 ? "and" : "or")}
                style={{ flex: 1 }}
              />
            </div>
          )}

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {conditions.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <select
                  value={c.type}
                  onChange={(e) => {
                    const type = e.target.value as ViewCondition["type"];
                    const value = type === "tag" ? (tags[0] ?? "") : type === "folder" ? (folders[0] ?? "") : "";
                    setCondition(i, { type, value } as ViewCondition);
                  }}
                  style={selectStyle(88)}
                >
                  {CONDITION_TYPES.map((ct) => (
                    <option key={ct} value={ct}>
                      {t(CONDITION_LABELS[ct])}
                    </option>
                  ))}
                </select>

                {c.type === "search" ? (
                  <input
                    value={c.value}
                    onChange={(e) => setCondition(i, { type: "search", value: e.target.value })}
                    placeholder={t("viewEditor.containsPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{ ...selectStyle(0), flex: 1, fontFamily: "var(--font-sans)" }}
                  />
                ) : (c.type === "tag" ? tags : folders).length > 0 ? (
                  <select
                    value={c.value}
                    onChange={(e) => setCondition(i, { type: c.type, value: e.target.value } as ViewCondition)}
                    style={{ ...selectStyle(0), flex: 1 }}
                  >
                    {(c.type === "tag" ? tags : folders).map((o) => (
                      <option key={o} value={o}>
                        {c.type === "tag" ? `#${o}` : o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={c.value}
                    onChange={(e) => setCondition(i, { type: c.type, value: e.target.value } as ViewCondition)}
                    placeholder={c.type === "tag" ? t("viewEditor.tagPlaceholder") : t("viewEditor.folderPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{ ...selectStyle(0), flex: 1, fontFamily: c.type === "folder" ? "var(--font-mono)" : "var(--font-sans)" }}
                  />
                )}

                <button
                  onClick={() => removeCondition(i)}
                  aria-label={t("notes.filterBuilder.removeCondition")}
                  style={{ flexShrink: 0, width: 34, height: 44, border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 22, cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
              </div>
            ))}

            <button
              onClick={addCondition}
              style={{ alignSelf: "flex-start", border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "4px 0" }}
            >
              {t("viewEditor.addCondition")}
            </button>
          </div>

          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={() => void save()} disabled={name.trim() === "" || busy} style={{ ...btn("var(--accent)", "var(--accent-on)"), opacity: name.trim() === "" || busy ? 0.5 : 1 }}>
              {initial === null ? t("viewEditor.createView") : t("notes.filterBuilder.save")}
            </button>
            {initial !== null && (
              <button onClick={() => void remove()} disabled={busy} style={btn("transparent", "var(--danger)", "1px solid var(--line-2)")}>
                {t("notes.views.menu.deleteView")}
              </button>
            )}
            <button onClick={close} style={btn("transparent", "var(--fg-1)", "1px solid var(--line-2)")}>
              {t("common.prompt.cancel")}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function selectStyle(width: number): React.CSSProperties {
  return {
    ...(width ? { width, flexShrink: 0 } : {}),
    height: 44,
    border: "1px solid var(--line-2)",
    borderRadius: 8,
    background: "var(--bg-1)",
    padding: "0 10px",
    fontFamily: "var(--font-sans)",
    fontSize: 15,
    color: "var(--fg-1)",
    outline: "none",
    boxSizing: "border-box",
  };
}
