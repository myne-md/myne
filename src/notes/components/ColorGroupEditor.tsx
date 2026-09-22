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
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { Switch } from "../../components/primitives/Switch";
import { collectFolderOptions } from "../../components/export/vaultExportFlow";
import { usePrefs } from "../../hooks/usePrefs";
import { setColorGroups, type ColorGroup } from "../../lib/prefs";
import { colorGroupVar, GROUP_COLOR_KEYS } from "../graphColorGroups";
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

/** The task-4 categorical palette, the 8 `--group-*` design tokens, in the
 *  order {@link GROUP_COLOR_KEYS} fixes. Only the human labels live here; the
 *  KEYS are shared with the default tag grouping, because that assigns them in
 *  sequence and the sequence is precedence. */
const PALETTE_LABELS = ["Olive", "Fern", "Teal", "Denim", "Indigo", "Violet", "Orchid", "Rose"];
const PALETTE: ReadonlyArray<{ key: string; label: string }> = GROUP_COLOR_KEYS.map(
  (key, i) => ({ key, label: PALETTE_LABELS[i]! }),
);

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
  borderRadius: "var(--radius-1)",
  padding: "2px 4px",
  outline: "none",
};

const ROW_TEXT_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: "0 var(--space-2)",
  flexShrink: 0,
  background: "transparent",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-2)",
  cursor: "pointer",
};

/** The remove control is the same button, square: `×` has no label to make room
 *  for, and a square beside a labelled one is what makes the pair read as a
 *  control group rather than as two unrelated glyphs. */
const ROW_ICON_BUTTON_STYLE: CSSProperties = {
  ...ROW_TEXT_BUTTON_STYLE,
  width: 20,
  padding: 0,
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
  fontSize: "var(--text-xs)",
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

export function ColorGroupEditor({
  derivedGroupCount = 0,
  onMaterializeDerived = undefined,
  derivedMaterializeFailed = false,
}: {
  /** How many groups the graph is showing from its DERIVED default (one per
   *  qualifying tag, at least two notes) because the vault has authored none
   *  (myne-md/myne#727). Zero means there is nothing to explain. */
  derivedGroupCount?: number;
  /** Turn those derived groups into real, editable rules. The ONE moment this
   *  surface writes `color_groups`, and it is a write the user asked for. */
  onMaterializeDerived?: () => void;
  /** The materialise write failed. Reported rather than swallowed: the button
   *  promises the defaults became editable, and a silent failure leaves the
   *  panel showing "N derived groups" as if nothing was pressed. */
  derivedMaterializeFailed?: boolean;
} = {}) {
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
  /** Whether the NEW-rule modal is open. The rule does not exist until this is
   *  confirmed, which is what makes adding one a single step. */
  const [creating, setCreating] = useState(false);

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

  /** ONE step, not two. This used to persist an "Untitled rule" immediately and
   *  leave the user to click Edit afterwards, which is what the maintainer
   *  flagged: the thing you came to set was behind a second click, and the list
   *  meanwhile held a rule matching every note. The modal opens first and the
   *  rule only exists once it is confirmed. */
  const addRule = () => setCreating(true);

  const createRule = (draft: FilterDraft) => {
    setCreating(false);
    const rule: ColorGroup = {
      id: crypto.randomUUID(),
      name: "",
      color: PALETTE[0]!.key,
      enabled: true,
      filter: draftToFilterNode(sanitizeDraft(draft)),
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
      {/* No section heading of its own: the panel renders this editor inside a
          `SettingsGroup` and that group's label IS the heading (myne-md/myne#727).
          A second heading here would be the same words twice, one of them
          outside the fold. */}

      {rules.length === 0 ? (
        <div data-testid="editor.color-groups-empty" style={EMPTY_HINT_STYLE}>
          <p style={{ margin: "0 0 2px", color: "var(--fg-2)", fontWeight: "var(--weight-medium)" }}>
            {t("notes.graph.colorGroups.emptyTitle")}
          </p>
          <p style={{ margin: "0 0 6px" }}>{t("notes.graph.colorGroups.emptyBody")}</p>
          {/* The graph is ALREADY coloured when the vault has no rules: the
              default grouping by tag is DERIVED at render time rather than
              written into `color_groups`, because an empty rule list is the
              same state before the prefs read resolves, on a failed read, and
              after the user deletes everything (myne-md/myne#727). Saying so
              here is what stops the panel and the picture disagreeing, and the
              button is the one moment the write is what the user asked for. */}
          {derivedGroupCount > 0 && (
            <div
              data-testid="editor.color-groups-derived"
              style={{ marginTop: "var(--space-1)" }}
            >
              <p style={{ margin: "0 0 6px", color: "var(--fg-2)" }}>
                {t("notes.graph.colorGroups.derivedNote", {
                  count: derivedGroupCount,
                })}
              </p>
              <button
                type="button"
                onClick={onMaterializeDerived}
                data-testid="editor.color-groups-materialize"
                style={{
                  fontSize: "var(--text-xs)",
                  padding: "var(--space-1) var(--space-2)",
                  background: "var(--bg-1)",
                  color: "var(--fg-2)",
                  border: "1px solid var(--line-1)",
                  borderRadius: "var(--radius-2)",
                  cursor: "pointer",
                }}
              >
                {t("notes.graph.colorGroups.derivedMakeEditable")}
              </button>
              {derivedMaterializeFailed && (
                <p
                  data-testid="editor.color-groups-materialize-failed"
                  style={{ margin: "6px 0 0", color: "var(--danger)" }}
                >
                  {t("notes.graph.colorGroups.derivedMakeEditableFailed")}
                </p>
              )}
            </div>
          )}
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
                {/* The trailing controls read in ONE order and at ONE height
                    (the Switch is 20px): toggle, edit, remove. The edit control
                    is a labelled bordered button rather than a bare pencil, so
                    it says what it does; remove is the same button square. */}
                <Switch
                  checked={rule.enabled}
                  onChange={(next) => updateRule(rule.id, { enabled: next })}
                  ariaLabel={t("notes.graph.colorGroups.enableToggleAriaLabel")}
                  testId="editor.color-group-enabled"
                />
                <button
                  type="button"
                  aria-label={t("notes.graph.colorGroups.editFilterButton")}
                  title={t("notes.graph.colorGroups.editFilterButton")}
                  data-testid="editor.color-group-edit-filter"
                  onClick={() => setEditingFilterFor(rule.id)}
                  style={ROW_TEXT_BUTTON_STYLE}
                >
                  {t("notes.graph.colorGroups.editRuleButton")}
                </button>
                <button
                  type="button"
                  aria-label={t("notes.graph.colorGroups.deleteRuleTitle")}
                  title={t("notes.graph.colorGroups.deleteRuleTitle")}
                  data-testid="editor.color-group-delete"
                  onClick={() => deleteRule(rule.id)}
                  style={ROW_ICON_BUTTON_STYLE}
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
          // FULL width and taller than a row control: this is the one action in
          // the section that creates something, and at its old size it read as
          // a footnote under the list rather than as the way to start one
          // (myne-md/myne#727).
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-1)",
          fontSize: 12,
          padding: "var(--space-2) var(--space-3)",
          background: "var(--bg-1)",
          color: "var(--fg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          cursor: "pointer",
        }}
      >
        <Icon name="plus" size={12} />
        {t("notes.graph.colorGroups.addRule")}
      </button>

      {/* Both modals go through a PORTAL. `ModalShell`'s backdrop is
          `position: fixed`, and this editor renders inside the graph settings
          panel, which is an absolutely-positioned, `overflowY: auto` box: an
          ancestor that creates a containing block (a transform, a filter,
          `will-change`) turns "fixed" into "fixed to that ancestor", and the
          modal then renders clipped and off-centre. That is the defect the
          maintainer saw as "it doesn't display correctly the modal". Portalling
          to the body makes the backdrop resolve against the viewport, which is
          what every other modal in the app already gets by living at the top
          level. */}
      {editingRule !== null &&
        createPortal(
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
          />,
          document.body,
        )}

      {creating &&
        createPortal(
          <FilterBuilder
            title={t("notes.graph.colorGroups.newRuleTitle")}
            initialDraft={EMPTY_DRAFT}
            representable
            allowedTypes={["tag", "folder"]}
            folderOptions={folderOptionsFrom(collectFolderOptions(cache.values()))}
            onCancel={() => setCreating(false)}
            onSave={createRule}
          />,
          document.body,
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
