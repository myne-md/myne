// `<ColorGroupEditor>` — the color-group rule list (graph-connection-ux-polish
// task 7), rendered as a second section inside `<GraphSettingsPanel>`. An
// ordered list of rules — name, enable toggle, filter summary, palette
// swatch — with add / edit / delete / drag-to-reorder (order IS rule
// precedence, per `graphColorGroups.ts`'s first-match-wins evaluator).
//
// Reuses the existing `<FilterBuilder>` (Saved Views) rather than a second
// builder — same `FilterNode` AST, same UI the user already knows — but
// restricts it to the tag/folder leaves the v1 evaluator actually supports
// (`allowedTypes`, added to `FilterBuilder` for this purpose). The color
// picker offers only the task-4 fixed palette; no free-form entry.
//
// Self-contained: reads `usePrefs().prefs.color_groups` directly and persists
// via `setColorGroups` (a whole-list replace — order is the payload, not a
// separate `*_order` field). No `onChange` prop; the nonce bump inside
// `setColorGroups` refreshes every `usePrefs` consumer, including this one.

import { useState, type CSSProperties, type DragEvent as ReactDragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { Switch } from "../../components/primitives/Switch";
import { collectFolderOptions } from "../../components/export/vaultExportFlow";
import { usePrefs } from "../../hooks/usePrefs";
import { setColorGroups, type ColorGroup } from "../../lib/prefs";
import { colorGroupVar } from "../graphColorGroups";
import { useSelectedNote } from "../sidebarState";
import { FilterBuilder, type FolderOption } from "./FilterBuilder";
import { dragEdge, insertionLineStyle } from "./reorderDnd";
import {
  draftToFilterNode,
  filterNodeToDraft,
  sanitizeDraft,
  type FilterDraft,
} from "../filterDraft";

const EMPTY_DRAFT: FilterDraft = { combinator: "and", groups: [] };

/** The task-4 categorical palette — the 8 `--group-*` design tokens. The
 *  stored {@link ColorGroup.color} is the bare token name (no leading `--`);
 *  the canvas renderer (task 8) resolves it as `var(--${color})`. */
const PALETTE: ReadonlyArray<{ key: string; label: string }> = [
  { key: "group-olive", label: "Olive" },
  { key: "group-fern", label: "Fern" },
  { key: "group-teal", label: "Teal" },
  { key: "group-denim", label: "Denim" },
  { key: "group-indigo", label: "Indigo" },
  { key: "group-violet", label: "Violet" },
  { key: "group-orchid", label: "Orchid" },
  { key: "group-rose", label: "Rose" },
];

const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  marginTop: 4,
};

const ROW_STYLE: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 2px",
  borderRadius: "var(--radius-1)",
};

const NAME_INPUT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-1)",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  padding: "2px 4px",
  outline: "none",
};

const ICON_BTN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  flexShrink: 0,
  background: "transparent",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
};

const SWATCH_STYLE = (colorKey: string): CSSProperties => ({
  width: 14,
  height: 14,
  flexShrink: 0,
  borderRadius: "50%",
  border: "1px solid var(--line-2)",
  // NOT `var(--${colorKey})`: the ROW swatch paints `rule.color`, which is
  // synced content a peer (or a future client's ninth palette entry) can set to
  // something this build cannot resolve. A bare `var()` with no fallback paints
  // the swatch transparent, so the editor would show a blank circle for a rule
  // the canvas is meanwhile painting neutral — two surfaces disagreeing about
  // the same key. `colorGroupVar` is the shared degrade both clients use.
  background: colorGroupVar(colorKey),
  cursor: "pointer",
  padding: 0,
});

const SWATCH_PICKER_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  padding: "4px 22px 6px",
};

const FILTER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 2px 4px 22px",
  fontSize: 11,
  color: "var(--fg-3)",
};

const EMPTY_HINT_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

/** Folder choices for the filter builder's folder-condition picker — the same
 *  depth-first, trashed-excluded derivation `collectFolderOptions` already
 *  gives the vault-export flow, indented like the sidebar tree. */
function folderOptionsFrom(paths: readonly string[]): FolderOption[] {
  return paths.map((path) => {
    const segments = path.split("/").filter((s) => s.length > 0);
    const name = segments[segments.length - 1] ?? path;
    return { path, label: `${"  ".repeat(Math.max(0, segments.length - 1))}${name}` };
  });
}

export function ColorGroupEditor() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const { cache } = useSelectedNote();
  const rules = prefs.color_groups;

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: "above" | "below" } | null>(
    null,
  );
  const [pickingColorFor, setPickingColorFor] = useState<string | null>(null);
  const [editingFilterFor, setEditingFilterFor] = useState<string | null>(null);

  const persist = (next: ColorGroup[]) => {
    void (async () => {
      try {
        await setColorGroups(next);
      } catch {
        // Surfaced via backend tracing; `usePrefs` re-reads disk truth on the
        // next nonce bump either way, so the UI never diverges silently.
      }
    })();
  };

  const addRule = () => {
    const rule: ColorGroup = {
      id: crypto.randomUUID(),
      name: "",
      color: PALETTE[0]!.key,
      enabled: true,
      filter: { kind: "all" },
    };
    persist([...rules, rule]);
  };

  const updateRule = (id: string, patch: Partial<ColorGroup>) =>
    persist(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const deleteRule = (id: string) => persist(rules.filter((r) => r.id !== id));

  /** Drop `movedId` above/below `targetId` — the same above/below insertion
   *  semantics the sidebar's note and folder reorder use (`dragEdge`), so the
   *  gesture behaves identically here. Order IS precedence, so the resulting
   *  sequence is the whole payload of the write. */
  const reorder = (movedId: string, targetId: string, place: "above" | "below") => {
    if (movedId === targetId) return;
    const moved = rules.find((r) => r.id === movedId);
    if (moved === undefined) return;
    const rest = rules.filter((r) => r.id !== movedId);
    const targetIdx = rest.findIndex((r) => r.id === targetId);
    if (targetIdx === -1) return;
    const insertAt = place === "above" ? targetIdx : targetIdx + 1;
    persist([...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)]);
  };

  const commitName = (id: string, name: string) => {
    const trimmed = name.trim();
    const current = rules.find((r) => r.id === id);
    if (current !== undefined && trimmed !== current.name) {
      updateRule(id, { name: trimmed });
    }
  };

  const editingRule = rules.find((r) => r.id === editingFilterFor) ?? null;
  const editingDraft = editingRule !== null ? filterNodeToDraft(editingRule.filter) : null;

  return (
    <>
      <span style={SECTION_HEADING_STYLE}>{t("notes.graph.colorGroups.heading")}</span>

      {rules.length === 0 ? (
        <div data-testid="editor.color-groups-empty" style={EMPTY_HINT_STYLE}>
          <p style={{ margin: "0 0 2px", color: "var(--fg-2)", fontWeight: 500 }}>
            {t("notes.graph.colorGroups.emptyTitle")}
          </p>
          <p style={{ margin: "0 0 6px" }}>{t("notes.graph.colorGroups.emptyBody")}</p>
        </div>
      ) : (
        <div data-testid="editor.color-groups-list">
          {rules.map((rule) => (
            <div key={rule.id}>
              <div
                data-testid="editor.color-group-row"
                data-rule-id={rule.id}
                draggable
                onDragStart={() => setDragId(rule.id)}
                onDragOver={(e: ReactDragEvent<HTMLDivElement>) => {
                  if (dragId === null || dragId === rule.id) return;
                  e.preventDefault();
                  setDropTarget({ id: rule.id, place: dragEdge(e) });
                }}
                onDragLeave={() =>
                  setDropTarget((cur) => (cur?.id === rule.id ? null : cur))
                }
                onDrop={(e: ReactDragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  if (dragId !== null) reorder(dragId, rule.id, dragEdge(e));
                  setDragId(null);
                  setDropTarget(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTarget(null);
                }}
                style={ROW_STYLE}
              >
                {dropTarget?.id === rule.id && (
                  <div style={insertionLineStyle(dropTarget.place)} aria-hidden="true" />
                )}
                <span
                  aria-hidden="true"
                  title={t("notes.graph.colorGroups.dragHandleTitle")}
                  style={{ display: "flex", flexShrink: 0, color: "var(--fg-3)", cursor: "grab" }}
                >
                  <Icon name="more-vertical" size={12} />
                </span>
                <button
                  type="button"
                  aria-label={t("notes.graph.colorGroups.colorSwatchTitle")}
                  title={t("notes.graph.colorGroups.colorSwatchTitle")}
                  data-testid="editor.color-group-swatch"
                  onClick={() =>
                    setPickingColorFor((cur) => (cur === rule.id ? null : rule.id))
                  }
                  style={SWATCH_STYLE(rule.color)}
                />
                <input
                  type="text"
                  data-testid="editor.color-group-name"
                  defaultValue={rule.name}
                  placeholder={t("notes.graph.colorGroups.namePlaceholder")}
                  onBlur={(e) => commitName(rule.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  style={NAME_INPUT_STYLE}
                />
                <button
                  type="button"
                  aria-label={t("notes.graph.colorGroups.editFilterButton")}
                  title={t("notes.graph.colorGroups.editFilterButton")}
                  data-testid="editor.color-group-edit-filter"
                  onClick={() => setEditingFilterFor(rule.id)}
                  style={ICON_BTN_STYLE}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <Switch
                  checked={rule.enabled}
                  onChange={(next) => updateRule(rule.id, { enabled: next })}
                  ariaLabel={t("notes.graph.colorGroups.enableToggleAriaLabel")}
                  testId="editor.color-group-enabled"
                />
                <button
                  type="button"
                  aria-label={t("notes.graph.colorGroups.deleteRuleTitle")}
                  title={t("notes.graph.colorGroups.deleteRuleTitle")}
                  data-testid="editor.color-group-delete"
                  onClick={() => deleteRule(rule.id)}
                  style={ICON_BTN_STYLE}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>

              <div style={FILTER_ROW_STYLE}>
                {rule.filter.kind === "all"
                  ? t("notes.graph.colorGroups.filterAllNotes")
                  : t("notes.graph.colorGroups.filterConditions", {
                      count: countConditions(rule.filter),
                    })}
              </div>

              {pickingColorFor === rule.id && (
                <div data-testid="editor.color-group-palette" style={SWATCH_PICKER_STYLE}>
                  {PALETTE.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      aria-label={entry.label}
                      title={entry.label}
                      data-testid="editor.color-group-palette-swatch"
                      data-color-key={entry.key}
                      onClick={() => {
                        updateRule(rule.id, { color: entry.key });
                        setPickingColorFor(null);
                      }}
                      style={{
                        ...SWATCH_STYLE(entry.key),
                        outline:
                          entry.key === rule.color ? "2px solid var(--accent)" : "none",
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addRule}
        data-testid="editor.color-group-add"
        style={{
          alignSelf: "flex-start",
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          padding: "4px 8px",
          background: "var(--bg-1)",
          color: "var(--fg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-1)",
          cursor: "pointer",
        }}
      >
        <Icon name="plus" size={12} />
        {t("notes.graph.colorGroups.addRule")}
      </button>

      {editingRule !== null && (
        <FilterBuilder
          title={t("notes.graph.colorGroups.editFilterTitle")}
          initialDraft={editingDraft ?? EMPTY_DRAFT}
          representable={editingDraft !== null}
          allowedTypes={["tag", "folder"]}
          folderOptions={folderOptionsFrom(collectFolderOptions(cache.values()))}
          onCancel={() => setEditingFilterFor(null)}
          onSave={(draft) => {
            setEditingFilterFor(null);
            updateRule(editingRule.id, { filter: draftToFilterNode(sanitizeDraft(draft)) });
          }}
        />
      )}
    </>
  );
}

/** Total leaf-condition count across a non-`all` filter, for the row's plain
 *  filter summary — good enough to show "something is set" without building
 *  a full natural-language description of the AST. */
function countConditions(node: ColorGroup["filter"]): number {
  switch (node.kind) {
    case "and":
    case "or":
      return node.children.reduce((sum, child) => sum + countConditions(child), 0);
    case "not":
      return countConditions(node.child);
    case "all":
      return 0;
    default:
      return 1;
  }
}
