// Create / edit one saved view (MYND-273, mobile). A flat condition builder over
// the {@link ViewDraft} bridge — the common single-level AND/OR of tag / folder /
// text / property leaves. Persists via the `prefs` plugin setters
// (`upsertSavedView`, plus `setViewOrder` to append a brand-new view to the
// display order). Editing an AST authored on desktop is lossy (see
// `view-filter.ts`): only editable leaves survive, so re-saving narrows a richer
// view to what the editor can represent.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Banner, Segmented, Chip } from "../../components";
import { upsertSavedView, deleteSavedView, setViewOrder, type SavedView, type PropertyOp } from "../../lib/prefs";
import { parseFilters, buildFilters, type ViewCondition } from "../../lib/view-filter";

const CONDITION_TYPES: ViewCondition["type"][] = ["tag", "folder", "search", "property"];
/** view_type picker order (Segmented is index-based on mobile). */
const VIEW_TYPES: SavedView["view_type"][] = ["list", "cards", "table"];
/** i18n key per condition type (resolved with `t()` at the render site). */
const CONDITION_LABELS: Record<ViewCondition["type"], string> = {
  tag: "notes.filterBuilder.type.tag",
  folder: "notes.filterBuilder.type.folder",
  search: "viewEditor.condition.search",
  property: "notes.filterBuilder.type.property",
};
/** Engine operator order for the property-condition op picker. The comparison
 *  symbols are literal (never translated); only `contains` goes through i18n
 *  at the render site — same rule as the desktop builder. */
const PROPERTY_OPS: PropertyOp[] = ["==", "!=", ">", "<", ">=", "<=", "contains"];

export interface ViewEditorSheetProps {
  /** The view being edited, or `null` to create a new one. */
  initial: SavedView | null;
  /** Available tag names (no leading `#`) for the tag picker. */
  tags: string[];
  /** Available folder paths (canonical trailing-slash) for the folder picker. */
  folders: string[];
  /** Vault frontmatter property keys (the `vault_indices_property_keys` universe)
   *  — the option set for the group / sort / column pickers. */
  propertyKeys: string[];
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

const FIELD_LABEL_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "var(--fg-3)",
  fontWeight: 600,
};

export function ViewEditorSheet({ initial, tags, folders, propertyKeys, viewOrder, onClose, onSaved }: ViewEditorSheetProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const parsed = parseFilters(initial?.filters ?? { kind: "all" });
  const [mode, setMode] = useState<"and" | "or">(parsed.mode);
  const [conditions, setConditions] = useState<ViewCondition[]>(parsed.conditions);
  // Structural render config (desktop parity): view_type + group / sort / columns.
  const [viewType, setViewType] = useState<SavedView["view_type"]>(initial?.view_type ?? "list");
  const [groupBy, setGroupBy] = useState(initial?.group_by ?? "");
  const [sortKey, setSortKey] = useState(initial?.sort?.key ?? "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initial?.sort?.direction ?? "asc");
  const [columns, setColumns] = useState<string[]>(initial?.columns ?? []);
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
      view_type: viewType,
      filters: buildFilters({ mode, conditions }),
      group_by: groupBy === "" ? undefined : groupBy,
      sort: sortKey === "" ? undefined : { key: sortKey, direction: sortDir },
      columns: columns.length === 0 ? undefined : columns,
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

          {/* Render config (desktop parity): view type + group / sort / columns. */}
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={FIELD_LABEL_STYLE}>{t("notes.viewSettings.viewType")}</div>
              <Segmented
                options={[
                  t("notes.viewSettings.viewTypeList"),
                  t("notes.viewSettings.viewTypeCards"),
                  t("notes.viewSettings.viewTypeTable"),
                ]}
                active={Math.max(0, VIEW_TYPES.indexOf(viewType))}
                onChange={(i: number) => setViewType(VIEW_TYPES[i] ?? "list")}
                ariaLabel={t("notes.viewSettings.viewType")}
                style={{ marginTop: 6 }}
              />
            </div>

            {propertyKeys.length > 0 && (
              <>
                <div>
                  <div style={FIELD_LABEL_STYLE}>{t("notes.viewSettings.groupBy")}</div>
                  <select
                    value={groupBy}
                    onChange={(e) => setGroupBy(e.target.value)}
                    data-testid="view-editor.group-by"
                    style={{ ...selectStyle(0), width: "100%", marginTop: 6 }}
                  >
                    <option value="">{t("notes.viewSettings.propertyNone")}</option>
                    {propertyKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={FIELD_LABEL_STYLE}>{t("notes.viewSettings.sortBy")}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value)}
                      data-testid="view-editor.sort-key"
                      style={{ ...selectStyle(0), flex: 1 }}
                    >
                      <option value="">{t("notes.viewSettings.propertyNone")}</option>
                      {propertyKeys.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    {sortKey !== "" && (
                      <Segmented
                        options={[t("notes.viewSettings.sortAsc"), t("notes.viewSettings.sortDesc")]}
                        active={sortDir === "asc" ? 0 : 1}
                        onChange={(i: number) => setSortDir(i === 0 ? "asc" : "desc")}
                        ariaLabel={t("notes.viewSettings.sortDirection")}
                        style={{ flex: 1 }}
                      />
                    )}
                  </div>
                </div>

                <div>
                  <div style={FIELD_LABEL_STYLE}>{t("notes.viewSettings.columns")}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                    {propertyKeys.map((k) => {
                      const on = columns.includes(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() =>
                            setColumns((cs) => (on ? cs.filter((c) => c !== k) : [...cs, k]))
                          }
                          data-testid="view-editor.column-chip"
                          data-value={k}
                          data-on={on ? "true" : "false"}
                          style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
                        >
                          <Chip active={on}>{k}</Chip>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          {conditions.length > 1 && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--fg-3)", flexShrink: 0 }}>{t("notes.filterBuilder.match")}</span>
              <Segmented
                options={[t("notes.tagBrowser.modeAll"), t("notes.tagBrowser.modeAny")]}
                active={mode === "and" ? 0 : 1}
                onChange={(i: number) => setMode(i === 0 ? "and" : "or")}
                ariaLabel={t("notes.filterBuilder.match")}
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
                    if (type === "property") {
                      // A native <select> needs a valid selected value, so a
                      // fresh property row starts on the first known key.
                      setCondition(i, { type: "property", key: propertyKeys[0] ?? "", op: "==", value: "" });
                      return;
                    }
                    const value = type === "tag" ? (tags[0] ?? "") : type === "folder" ? (folders[0] ?? "") : "";
                    setCondition(i, { type, value } as ViewCondition);
                  }}
                  data-testid="view-editor.condition-type"
                  style={selectStyle(88)}
                >
                  {CONDITION_TYPES.map((ct) => (
                    <option key={ct} value={ct}>
                      {t(CONDITION_LABELS[ct])}
                    </option>
                  ))}
                </select>

                {c.type === "property" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
                    {propertyKeys.length > 0 || c.key !== "" ? (
                      <select
                        value={c.key}
                        onChange={(e) => setCondition(i, { ...c, key: e.target.value })}
                        data-testid="view-editor.condition-prop-key"
                        style={{ ...selectStyle(0), width: "100%" }}
                      >
                        {/* A stored key the index no longer knows (deleted
                            property / desktop-authored) is kept as the first
                            option — a native <select> renders an unknown value
                            blank and silently snaps to another option on first
                            touch, which would be silent data change. */}
                        {!propertyKeys.includes(c.key) && c.key !== "" && (
                          <option value={c.key}>{c.key}</option>
                        )}
                        {propertyKeys.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={c.key}
                        onChange={(e) => setCondition(i, { ...c, key: e.target.value })}
                        placeholder={t("viewEditor.propertyKeyPlaceholder")}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        data-testid="view-editor.condition-prop-key"
                        style={{ ...selectStyle(0), width: "100%", fontFamily: "var(--font-mono)" }}
                      />
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        value={c.op}
                        onChange={(e) => setCondition(i, { ...c, op: e.target.value as PropertyOp })}
                        data-testid="view-editor.condition-prop-op"
                        style={selectStyle(96)}
                      >
                        {PROPERTY_OPS.map((op) => (
                          <option key={op} value={op}>
                            {op === "contains" ? t("notes.filterBuilder.op.contains") : op}
                          </option>
                        ))}
                      </select>
                      <input
                        value={c.value}
                        onChange={(e) => setCondition(i, { ...c, value: e.target.value })}
                        placeholder={t("notes.filterBuilder.propertyValuePlaceholder")}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        data-testid="view-editor.condition-prop-value"
                        style={{ ...selectStyle(0), flex: 1, minWidth: 0, fontFamily: "var(--font-sans)" }}
                      />
                    </div>
                  </div>
                ) : c.type === "search" ? (
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
