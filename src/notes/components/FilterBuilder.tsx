// `<FilterBuilder>` — the saved-view filter builder modal (Saved Views #4 /
// MYND-282). A desktop modal carve-out (ModalShell) that edits a view's filter as
// Notion/Airtable-style single-level groups, mapped to the canonical `FilterNode`
// AST via the pure `filterDraft` core. Serves BOTH create ("+ New view") and edit
// ("Edit filter…") — the parent seeds `initialDraft` (empty for new, parsed for
// edit) and persists on `onSave`. Saving with no conditions yields an all-pages
// view, preserving the prior "+ New view" behavior as the empty case.
//
// Composition model: a top-level All/Any combinator across GROUPS, each group its
// own All/Any across CONDITIONS, one level of nesting. v1 condition types: tag
// (picked from the tag tree), folder (picked from the folder tree), search (free
// text); each carries an "is / is not" negation. `property` is deferred (task 1's
// representability guard keeps it out). The live count + edge states layer on in
// tasks 4/6.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ModalShell } from "../../components/primitives/ModalShell";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { Icon } from "../../components/primitives/Icon";
import { SearchableSelect } from "../../components/primitives/SearchableSelect";
import type { SelectOption } from "../../components/primitives/Select";
import { tagRows, type TagRow } from "../tagBrowser";
import { tagTree } from "../vaultIndices";
import { useFilterCount } from "../views/useFilterCount";
import {
  draftToFilterNode,
  sanitizeDraft,
  type ConditionType,
  type DraftCondition,
  type DraftGroup,
  type FilterDraft,
} from "../filterDraft";

/** A folder choice for the folder-condition picker (canonical path + label). */
export interface FolderOption {
  path: string;
  label: string;
}

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const EMPTY_HINT_STYLE: CSSProperties = {
  padding: "var(--space-4)",
  textAlign: "center",
  color: "var(--fg-3)",
  fontSize: 13,
  lineHeight: 1.6,
};

const GROUP_STYLE: CSSProperties = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  background: "var(--bg-1)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

const ICON_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  padding: 0,
  background: "transparent",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
  flexShrink: 0,
};

const FOOTER_STYLE: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

const COUNT_STYLE: CSSProperties = {
  marginRight: "auto",
  fontSize: 12,
  color: "var(--fg-3)",
  fontVariantNumeric: "tabular-nums",
};

const BADGE_STYLE: CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  color: "var(--fg-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  padding: "1px 6px",
  whiteSpace: "nowrap",
};

const COMBINATOR_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

export interface FilterBuilderProps {
  /** Header title — "New view" for create, "Edit filter" for edit. */
  title: string;
  /** Seed draft: empty for a new view, parsed from the view's filter for edit.
   *  The component is mounted fresh per open, so this seeds local state once. */
  initialDraft: FilterDraft;
  /** Whether the underlying filter is faithfully editable here. `false` (an
   *  unrepresentable AST — e.g. a future `property` condition) → the builder
   *  refuses to edit and disables Save rather than silently dropping conditions.
   *  The richer read-only / "Replace filter" treatment lands in task 6. */
  representable?: boolean;
  /** Folder choices for the folder-condition picker (from the sidebar tree). */
  folderOptions: readonly FolderOption[];
  /** Dismiss without persisting (Cancel / Esc / backdrop). */
  onCancel: () => void;
  /** Persist the composed draft. The parent maps it to a `FilterNode` and
   *  upserts the view (an empty draft → an all-pages filter). */
  onSave: (draft: FilterDraft) => void;
}

const EMPTY_DRAFT: FilterDraft = { combinator: "and", groups: [] };

const COMBINATOR_OPTIONS: readonly SelectOption<"and" | "or">[] = [
  { value: "and", label: "all" },
  { value: "or", label: "any" },
];
const TYPE_OPTIONS: readonly SelectOption<ConditionType>[] = [
  { value: "tag", label: "Tag" },
  { value: "folder", label: "Folder" },
  { value: "search", label: "Search" },
];
const NEGATE_OPTIONS: readonly SelectOption<"is" | "not">[] = [
  { value: "is", label: "is" },
  { value: "not", label: "is not" },
];

const newCondition = (): DraftCondition => ({ type: "tag", value: "", negated: false });

export function FilterBuilder({
  title,
  initialDraft,
  representable = true,
  folderOptions,
  onCancel,
  onSave,
}: FilterBuilderProps) {
  const [draft, setDraft] = useState<FilterDraft>(initialDraft);
  const [tagOptions, setTagOptions] = useState<TagRow[]>([]);
  // An unrepresentable filter (`representable === false`) opens read-only. The
  // user can deliberately "Replace filter" — that discards the opaque AST and
  // starts a fresh editable draft (never a silent best-effort parse).
  const [replacing, setReplacing] = useState(false);
  const editable = representable || replacing;

  // Live "N notes" preview against the current (sanitized) draft — a read-only
  // projection through the same engine the saved view uses; never persists.
  const filterNode = useMemo(() => draftToFilterNode(sanitizeDraft(draft)), [draft]);
  const count = useFilterCount(filterNode);

  // Tag choices come from the same shipped tag tree the Tag browser reads.
  useEffect(() => {
    let cancelled = false;
    void tagTree().then(
      (t) => {
        if (!cancelled) setTagOptions(tagRows(t));
      },
      () => {
        /* index unavailable → empty picker, still usable for folder/search */
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const hasGroups = draft.groups.length > 0;
  const hasConditions = useMemo(
    () => draft.groups.some((g) => g.conditions.length > 0),
    [draft.groups],
  );

  // A tag/folder condition whose stored value no longer exists (deleted folder,
  // tag now absent from every note) is shown with a quiet "unresolved" badge —
  // the engine already yields 0 matches for it, so this is informational only.
  const tagKeySet = useMemo(() => new Set(tagOptions.map((t) => t.key)), [tagOptions]);
  const folderPathSet = useMemo(
    () => new Set(folderOptions.map((f) => f.path)),
    [folderOptions],
  );
  const isUnresolved = (c: DraftCondition): boolean =>
    c.value.trim() !== "" &&
    ((c.type === "tag" && !tagKeySet.has(c.value)) ||
      (c.type === "folder" && !folderPathSet.has(c.value)));

  // Options for a condition's value picker. A stored-but-missing value (deleted
  // folder / absent tag) is kept as the first option so it stays visible and
  // editable rather than silently snapping to another.
  const valueOptionsFor = (c: DraftCondition): SelectOption<string>[] => {
    const base: SelectOption<string>[] =
      c.type === "tag"
        ? tagOptions.map((t) => ({ value: t.key, label: t.display }))
        : folderOptions.map((f) => ({ value: f.path, label: f.label }));
    return isUnresolved(c) ? [{ value: c.value, label: c.value }, ...base] : base;
  };

  // ---- immutable draft mutators -------------------------------------------
  const mutateGroup = (gi: number, fn: (g: DraftGroup) => DraftGroup) =>
    setDraft((d) => ({ ...d, groups: d.groups.map((g, i) => (i === gi ? fn(g) : g)) }));

  const mutateCondition = (gi: number, ci: number, fn: (c: DraftCondition) => DraftCondition) =>
    mutateGroup(gi, (g) => ({
      ...g,
      conditions: g.conditions.map((c, i) => (i === ci ? fn(c) : c)),
    }));

  const addCondition = (gi: number) =>
    mutateGroup(gi, (g) => ({ ...g, conditions: [...g.conditions, newCondition()] }));

  const removeCondition = (gi: number, ci: number) =>
    setDraft((d) => {
      const groups = d.groups
        .map((g, i) => (i === gi ? { ...g, conditions: g.conditions.filter((_, j) => j !== ci) } : g))
        .filter((g) => g.conditions.length > 0);
      return { ...d, groups };
    });

  const addGroup = () =>
    setDraft((d) => ({
      ...d,
      groups: [...d.groups, { combinator: "and", conditions: [newCondition()] }],
    }));

  const setTopCombinator = (combinator: "and" | "or") =>
    setDraft((d) => ({ ...d, combinator }));

  // ---- render --------------------------------------------------------------
  return (
    <ModalShell
      open
      title={title}
      labelId="view-filter-title"
      onClose={onCancel}
      width={580}
      height={560}
      closeLabel="Cancel"
    >
      <div data-testid="view-filter.modal" style={BODY_STYLE}>
        {!editable && (
          <div data-testid="view-filter.unrepresentable" style={EMPTY_HINT_STYLE}>
            <p style={{ margin: "0 0 var(--space-3)" }}>
              This filter was made with an advanced editor and can't be edited here.
            </p>
            <Button
              variant="secondary"
              data-testid="view-filter.replace"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setReplacing(true);
              }}
            >
              Replace filter
            </Button>
          </div>
        )}
        {editable && draft.groups.length > 1 && (
          <div style={COMBINATOR_LABEL_STYLE}>
            <span>Match</span>
            <SearchableSelect
              testId="view-filter.top-combinator"
              options={COMBINATOR_OPTIONS}
              selected={[draft.combinator]}
              onChange={(next) => setTopCombinator(next[0] ?? "and")}
            />
            <span>of the groups:</span>
          </div>
        )}

        {editable && !hasConditions && (
          <div data-testid="view-filter.empty" style={EMPTY_HINT_STYLE}>
            No conditions yet — this view shows all pages.
          </div>
        )}

        {editable &&
          draft.groups.map((group, gi) => (
          <div key={gi} data-testid="view-filter.group" data-index={gi} style={GROUP_STYLE}>
            {group.conditions.length > 1 && (
              <div style={COMBINATOR_LABEL_STYLE}>
                <span>Match</span>
                <SearchableSelect
                  testId="view-filter.group-combinator"
                  options={COMBINATOR_OPTIONS}
                  selected={[group.combinator]}
                  onChange={(next) =>
                    mutateGroup(gi, (g) => ({ ...g, combinator: next[0] ?? "and" }))
                  }
                />
                <span>of:</span>
              </div>
            )}

            {group.conditions.map((cond, ci) => (
              <div key={ci} data-testid="view-filter.condition" data-gi={gi} data-ci={ci} style={ROW_STYLE}>
                <SearchableSelect
                  testId="view-filter.condition-type"
                  options={TYPE_OPTIONS}
                  selected={[cond.type]}
                  onChange={(next) =>
                    // Changing type clears the value (tag key / folder path /
                    // search text are not interchangeable).
                    mutateCondition(gi, ci, (c) => ({
                      ...c,
                      type: next[0] ?? c.type,
                      value: "",
                    }))
                  }
                />

                <SearchableSelect
                  testId="view-filter.condition-negate"
                  options={NEGATE_OPTIONS}
                  selected={[cond.negated ? "not" : "is"]}
                  onChange={(next) =>
                    mutateCondition(gi, ci, (c) => ({ ...c, negated: next[0] === "not" }))
                  }
                />

                {cond.type === "search" ? (
                  <Input
                    type="text"
                    data-testid="view-filter.condition-value"
                    value={cond.value}
                    placeholder="search text"
                    onChange={(e) => mutateCondition(gi, ci, (c) => ({ ...c, value: e.target.value }))}
                    style={{ flex: "1 1 auto", minWidth: 0 }}
                  />
                ) : (
                  <SearchableSelect
                    testId="view-filter.condition-value"
                    options={valueOptionsFor(cond)}
                    selected={cond.value ? [cond.value] : []}
                    onChange={(next) =>
                      mutateCondition(gi, ci, (c) => ({ ...c, value: next[0] ?? "" }))
                    }
                    placeholder={cond.type === "tag" ? "select a tag…" : "select a folder…"}
                  />
                )}

                {isUnresolved(cond) && (
                  <span data-testid="view-filter.unresolved" style={BADGE_STYLE}>
                    unresolved
                  </span>
                )}

                <button
                  type="button"
                  aria-label="Remove condition"
                  data-testid="view-filter.remove-condition"
                  onClick={() => removeCondition(gi, ci)}
                  style={ICON_BTN_STYLE}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}

            <div>
              <Button
                variant="ghost"
                icon="plus"
                data-testid="view-filter.add-condition"
                onClick={() => addCondition(gi)}
              >
                Add condition
              </Button>
            </div>
          </div>
        ))}

        {editable && (
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="secondary"
              icon="plus"
              data-testid={hasGroups ? "view-filter.add-group" : "view-filter.add-condition-first"}
              onClick={addGroup}
            >
              {hasGroups ? "Add filter group" : "Add condition"}
            </Button>
          </div>
        )}
      </div>

      <div style={FOOTER_STYLE}>
        {editable && (
          <span data-testid="view-filter.count" style={COUNT_STYLE}>
            {count === null ? "…" : `${count} ${count === 1 ? "note" : "notes"}`}
          </span>
        )}
        <Button variant="ghost" data-testid="view-filter.cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="view-filter.save"
          disabled={!editable}
          onClick={() => onSave(sanitizeDraft(draft))}
        >
          Save
        </Button>
      </div>
    </ModalShell>
  );
}
