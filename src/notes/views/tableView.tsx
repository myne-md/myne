// `TableView` — the property-column TABLE renderer for a saved view (MYND-277,
// Saved Views #7). Slots beside `CardsView` behind the `viewRenderHost` dispatch
// and reuses the shared scaffolding verbatim: the query-engine grouped rows
// (`ViewResult`), the typed-cell formatter (`PropertyValue`), the group stream +
// column geometry (`viewLayout`), the row-virtualizer (`VirtualList`), and the
// shared row chrome + click matrix (`viewChrome`).
//
// It is a READ-ONLY projection (SYNC-1): no contenteditable, no `<input>` cell,
// no drag/drop — a calm table of typed cells, NOT a spreadsheet, NEVER a kanban
// (static vertical group sections; `vision.md`). Columns come from `def.columns`
// (the cover-image column excluded), with `row.title` as the leading Name column.
//
// Narrow-pane behaviour (decision: horizontal scroll): columns keep a fixed
// min-width; when the pane is narrower than the table the `VirtualList`
// container scrolls horizontally and the Name column stays pinned
// (`position:sticky; left:0`).
//
// ## The bulk field action (view-manifests task 10)
//
// A view that DECLARES write fields (`write_fields`) gets a selection affordance
// and one bar above the table that sets one declared field on every selected
// note. Three things are deliberate:
//
//   - the selection checkbox lives INSIDE the pinned Name cell rather than in a
//     new grid column, so the shared column geometry (`tableGridTemplate`) is
//     untouched and the control stays visible when the table scrolls sideways;
//   - the writes go through `bulkSetField`, which is N sequential
//     `note_set_field` calls — the authority checks stay in the host, and there
//     is no second write path;
//   - the outcome is reported per note (what landed, what was refused and why),
//     because the vault has no multi-file transaction and a single "done" flag
//     would be a lie the user acts on.
//
// A note whose current value is a LIST is not sent at all: the patch writes one
// scalar, and a list cannot be expressed as the value-anchored precondition, so
// those notes are named in the report as not included rather than refused with a
// reason the host never gave.

import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SavedView } from "../../lib/prefs";
import type { ViewResult, ViewRow } from "../queryEngine";
import { PropertyValue, hasDisplayableValue } from "./propertyFormat";
import { VirtualList } from "../components/VirtualList";
import {
  VIEW_TESTID,
  buildViewStream,
  displayColumns,
  tableGridTemplate,
  type ViewStreamItem,
} from "./viewLayout";
import { ViewEmpty, ViewGroupHeading, makeViewRowHandlers } from "./viewChrome";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { SearchableSelect } from "../../components/primitives/SearchableSelect";
import { Icon } from "../../components/primitives/Icon";
import type { SelectOption } from "../../components/primitives/Select";
import {
  bulkSetField,
  restoreLastBulkAction,
  type BulkFieldResult,
  type BulkRestoreResult,
} from "../bulkSetField";
import { lastBulkAction } from "./bulkUndoJournal";
import type { NoteSetFieldError } from "../../types/note-set-field-error";
import type { CardContextMenuHandler, OpenNoteHandler } from "./cardsView";
import {
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { interactiveSurface } from "../../components/primitives/interactiveSurface";

/** The column-header pseudo-item prepended to the group stream. */
type ColHeaderItem = { kind: "colheader"; key: string };
type TableItem = ColHeaderItem | ViewStreamItem;

const ROW_ESTIMATED_HEIGHT = 40;

const WRAP_STYLE: CSSProperties = {
  height: "100%",
  background: "var(--paper)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

/** The virtualizer's box. `VirtualList` sizes itself `height: 100%`, so it needs
 *  a flex child of its own once the bulk bar sits above it: without this the bar
 *  would push the list past the pane and the last rows would be unreachable. */
const LIST_BOX_STYLE: CSSProperties = { flex: 1, minHeight: 0 };

const CELL_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  padding: "var(--space-2) 0",
};

const NAME_CELL_STYLE: CSSProperties = {
  ...CELL_STYLE,
  position: "sticky",
  insetInlineStart: 0,
  zIndex: 1,
  // Opaque so property cells scroll UNDER the pinned Name column (matches the
  // row + wrapper `--paper` fill so the occlusion is seamless).
  background: "var(--paper)",
  paddingInlineEnd: "var(--space-3)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

/** One grid row (header or data): the column template + a total min-width so a
 *  narrow container overflows horizontally rather than crushing the columns. */
function gridRowStyle(template: string, minWidth: number): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: template,
    minWidth,
    alignItems: "center",
    columnGap: "var(--space-3)",
    padding: "0 var(--space-3)",
    borderBottom: "1px solid var(--line-1)",
    background: "var(--paper)",
    minHeight: ROW_ESTIMATED_HEIGHT,
  };
}

const HEADER_CELL_STYLE: CSSProperties = {
  ...CELL_STYLE,
  fontSize: 12,
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-3)",
};

const HEADER_NAME_CELL_STYLE: CSSProperties = {
  ...NAME_CELL_STYLE,
  zIndex: 2, // above data-row Name cells during vertical scroll overlaps
  fontSize: 12,
  color: "var(--fg-3)",
};

const BAR_STYLE: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
  background: "var(--paper-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const REPORT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "0 var(--space-3) var(--space-2)",
  maxHeight: 160,
  overflowY: "auto",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const REPORT_LINE_STYLE: CSSProperties = {
  margin: 0,
  lineHeight: 1.45,
};

const REFUSAL_STYLE: CSSProperties = {
  ...REPORT_LINE_STYLE,
  color: "var(--fg-3)",
};

/** A selection toggle, built from `Button` rather than an `<input>`, and that is
 *  a promise rather than a preference: this table is a READ-ONLY projection
 *  (SYNC-1) and its own spec asserts that no `<input>` appears anywhere in it.
 *  Selection is not cell editing, so the control is a `role="checkbox"` button
 *  (the `Switch` precedent): the announced state and the painted state come from
 *  the same ARIA attribute, and the invariant keeps its letter. */
const TOGGLE_STYLE: CSSProperties = {
  width: "var(--target-min)",
  height: "var(--target-min)",
  padding: 0,
  border: 0,
  background: "transparent",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
};

const TOGGLE_BOX_STYLE: CSSProperties = {
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
};

const NAME_TEXT_STYLE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * One sentence per host refusal. Exhaustive over the mirror, so a new variant is
 * a compile error here rather than a silent generic line: the whole point of the
 * per-note report is that the reader learns what to redo.
 */
function refusalSentence(
  reason: NoteSetFieldError,
  t: (key: string) => string,
): string {
  switch (reason.kind) {
    case "VaultLocked":
      return t("notes.views.bulk.refusedVaultLocked");
    case "InvalidNoteId":
      return t("notes.views.bulk.refusedInvalidNoteId");
    case "NoteNotFound":
      return t("notes.views.bulk.refusedNoteNotFound");
    case "CannotDecrypt":
      return t("notes.views.bulk.refusedCannotDecrypt");
    case "NotApproved":
      return t("notes.views.bulk.refusedNotApproved");
    case "FieldNotDeclared":
      return t("notes.views.bulk.refusedFieldNotDeclared");
    case "FieldReserved":
      return t("notes.views.bulk.refusedFieldReserved");
    case "FieldChanged":
      return t("notes.views.bulk.refusedFieldChanged");
    case "InvalidField":
      return t("notes.views.bulk.refusedInvalidField");
    case "ValueTooLarge":
      return t("notes.views.bulk.refusedValueTooLarge");
    case "LiveSessionOpen":
      return t("notes.views.bulk.refusedLiveSessionOpen");
    case "PrefsUnreadable":
      return t("notes.views.bulk.refusedPrefsUnreadable");
    case "Io":
      return t("notes.views.bulk.refusedIo");
    case "JoinFailure":
      return t("notes.views.bulk.refusedJoinFailure");
  }
}

/** The scalar the view row believes the field holds, or `null` when absent.
 *  A LIST value returns `null` PLUS a flag: the caller excludes those notes,
 *  because one scalar cannot express a list as a precondition. */
function currentScalar(
  value: { type: string; value?: string } | undefined,
): { scalar: string | null; isList: boolean } {
  if (value === undefined) return { scalar: null, isList: false };
  if (value.type === "list") return { scalar: null, isList: true };
  return { scalar: value.value ?? null, isList: false };
}

/** The selection toggle: a `role="checkbox"` button, so it is keyboard-operable
 *  and announceable, and so the table keeps its no-`<input>` promise. */
function SelectToggle({
  checked,
  label,
  onToggle,
  testId,
  noteId,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
  testId: string;
  noteId?: string;
}) {
  return (
    <Button
      variant="ghost"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      {...(noteId === undefined ? {} : { "data-note-id": noteId })}
      onClick={(e) => {
        // The row opens the note on click; the toggle must not.
        e.stopPropagation();
        onToggle();
      }}
      style={TOGGLE_STYLE}
    >
      <span style={TOGGLE_BOX_STYLE} aria-hidden="true">
        {checked ? <Icon name="check" size={12} /> : null}
      </span>
    </Button>
  );
}

export function TableView({
  def,
  result,
  onOpenNote,
  onContextMenu,
}: {
  def: SavedView;
  result: ViewResult;
  onOpenNote?: OpenNoteHandler;
  onContextMenu?: CardContextMenuHandler;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => displayColumns(def), [def]);

  // ---- the bulk field action (view-manifests task 10) ---------------------
  const writableFields = useMemo(() => def.write_fields ?? [], [def.write_fields]);
  const selectable = writableFields.length > 0;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkField, setBulkField] = useState<string>(writableFields[0] ?? "");
  const [bulkValue, setBulkValue] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<BulkFieldResult | null>(null);
  const [listSkipped, setListSkipped] = useState<readonly string[]>([]);
  const [restored, setRestored] = useState<BulkRestoreResult | null>(null);

  const fieldOptions = useMemo<readonly SelectOption<string>[]>(
    () => writableFields.map((field) => ({ value: field, label: field })),
    [writableFields],
  );
  const { template, minWidth } = useMemo(
    () => tableGridTemplate(columns.length),
    [columns.length],
  );

  const { stream, total } = useMemo(
    () => buildViewStream(result, t("notes.views.table.noValue")),
    [result, t],
  );

  // The column-header row leads the stream (task: `view.table-header`). It
  // scrolls away vertically (sticky vertical header is a v2 polish — a sticky
  // item unmounts past the virtualizer buffer), but its Name cell pins
  // horizontally like every data row.
  const items = useMemo<TableItem[]>(
    () => (total === 0 ? [] : [{ kind: "colheader", key: "__colheader__" }, ...stream]),
    [stream, total],
  );

  // Every rendered row, addressable by note id, plus the ids in display order.
  // The bulk action needs a row's CURRENT value for its precondition, and the
  // view result is the only place that value is typed.
  const { rowById, resultNoteIds } = useMemo(() => {
    const byId = new Map<string, ViewRow>();
    const ids: string[] = [];
    for (const group of result.groups) {
      for (const row of group.rows) {
        if (!byId.has(row.noteId)) {
          byId.set(row.noteId, row);
          ids.push(row.noteId);
        }
      }
    }
    return { rowById: byId, resultNoteIds: ids };
  }, [result]);

  const toggleRow = useCallback((noteId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const allSelected =
    resultNoteIds.length > 0 && resultNoteIds.every((id) => selected.has(id));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (resultNoteIds.length > 0 && resultNoteIds.every((id) => prev.has(id))) {
        return new Set();
      }
      return new Set(resultNoteIds);
    });
  }, [resultNoteIds]);

  const runBulk = useCallback(async () => {
    if (busy || bulkField === "" || selected.size === 0) return;
    setBusy(true);
    setRestored(null);
    // Targets are built from the rows the table is showing, so the precondition
    // is the value the reader is looking at. List-valued fields are excluded and
    // named: one scalar cannot express a list as a precondition.
    const targets: { noteId: string; expectedValue: string | null }[] = [];
    const skipped: string[] = [];
    for (const noteId of resultNoteIds) {
      if (!selected.has(noteId)) continue;
      const row = rowById.get(noteId);
      const current = currentScalar(row?.values[bulkField]);
      if (current.isList) {
        skipped.push(noteId);
        continue;
      }
      targets.push({ noteId, expectedValue: current.scalar });
    }
    setListSkipped(skipped);
    try {
      const result = await bulkSetField({
        viewId: def.id,
        field: bulkField,
        newValue: bulkValue,
        targets,
      });
      setOutcome(result);
      // The written notes keep their selection off, so a second Apply does not
      // silently rewrite what the report says was already done.
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }, [busy, bulkField, bulkValue, def.id, resultNoteIds, rowById, selected]);

  const runRestore = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setRestored(await restoreLastBulkAction());
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const restorable = lastBulkAction();
  // **Only offer the restore when it can restore something.** A note in the
  // current on-disk format is a CRDT note, whose change graph IS its history, so
  // `note_set_field` captures no pre-write snapshot for it and every entry in the
  // journal carries `snapshotId: null`. Rendering the button anyway offered an
  // action that could only answer "Restored 0." on every vault created today,
  // which is the offer-without-a-capability shape the design canon rules out.
  const restoreAvailable =
    restorable !== null && restorable.notes.some((n) => n.snapshotId !== null);
  // ...and when it is absent, the report says WHY rather than leaving the reader
  // to wonder where the button went.
  const nothingToRestore =
    outcome !== null &&
    restored === null &&
    outcome.writtenCount > 0 &&
    !restoreAvailable;

  // Row styles depend only on the (stable) template + interactivity, so build
  // them once rather than per rendered row.
  const interactive = onOpenNote !== undefined;
  const dataRowStyle = useMemo<CSSProperties>(
    () => ({
      ...gridRowStyle(template, minWidth),
      cursor: interactive ? "pointer" : "default",
      transition: HOVER_TRANSITION,
    }),
    [template, minWidth, interactive],
  );
  const headerRowStyle = useMemo<CSSProperties>(
    () => ({ ...gridRowStyle(template, minWidth), borderBottom: "1px solid var(--line-2)" }),
    [template, minWidth],
  );

  const rows = makeViewRowHandlers(onOpenNote, onContextMenu);

  if (total === 0) {
    return <ViewEmpty message={t("notes.views.table.empty")} />;
  }

  const renderItem = (item: TableItem): ReactNode => {
    if (item.kind === "heading") {
      return <ViewGroupHeading label={item.label} count={item.count} />;
    }
    if (item.kind === "colheader") {
      return (
        <div data-testid={VIEW_TESTID.tableHeader} style={headerRowStyle}>
          {/* Inside the pinned Name cell rather than in a grid column of its
              own: the shared column geometry stays untouched, and the control
              stays visible when the table scrolls sideways. */}
          <span style={HEADER_NAME_CELL_STYLE}>
            {selectable && (
              <SelectToggle
                testId="view.bulk-select-all"
                label={t("notes.views.bulk.selectAll")}
                checked={allSelected}
                onToggle={toggleAll}
              />
            )}
            {t("notes.views.table.name")}
          </span>
          {columns.map((col) => (
            <span key={col} style={HEADER_CELL_STYLE} title={col}>
              {col}
            </span>
          ))}
        </div>
      );
    }
    // A data row.
    const { row } = item;
    return (
      <div
        data-testid={VIEW_TESTID.tableRow}
        data-note-id={row.noteId}
        role={interactive ? "button" : undefined}
        // A Tab stop, not a `-1` placeholder: see `makeViewRowHandlers`, whose
        // `key` entry is the other half (myne-md/myne#728).
        tabIndex={interactive ? 0 : undefined}
        {...interactiveSurface({ restBg: "var(--paper)", disabled: !interactive })}
        style={dataRowStyle}
        onClick={onOpenNote ? rows.click(row.noteId) : undefined}
        onKeyDown={onOpenNote ? rows.key(row.noteId) : undefined}
        onAuxClick={onOpenNote ? rows.aux(row.noteId) : undefined}
        onContextMenu={onContextMenu ? rows.contextMenu(row.noteId) : undefined}
      >
        <span
          style={NAME_CELL_STYLE}
          title={row.title ?? undefined}
          data-testid="view.table-name-cell"
        >
          {selectable && (
            <SelectToggle
              testId="view.bulk-select-row"
              noteId={row.noteId}
              label={t("notes.views.bulk.selectRow", {
                title: row.title ?? t("notes.views.cards.untitled"),
              })}
              checked={selected.has(row.noteId)}
              onToggle={() => toggleRow(row.noteId)}
            />
          )}
          <span style={NAME_TEXT_STYLE}>
            {row.title ?? t("notes.views.cards.untitled")}
          </span>
        </span>
        {columns.map((col) => {
          const prop = row.values[col];
          return (
            <span key={col} style={CELL_STYLE}>
              {hasDisplayableValue(prop) ? <PropertyValue prop={prop} /> : null}
            </span>
          );
        })}
      </div>
    );
  };

  const report = outcome === null ? null : (
    <div data-testid="view.bulk-report" style={REPORT_STYLE}>
      <p style={REPORT_LINE_STYLE}>
        {t("notes.views.bulk.written", { count: outcome.writtenCount })}
      </p>
      {/* Per note, with its own reason. A count alone would leave the reader
          unable to tell what to redo, which is the whole point of reporting a
          partial result instead of rolling back. */}
      {outcome.refused.map((entry) => (
        <p key={entry.noteId} style={REFUSAL_STYLE} data-note-id={entry.noteId}>
          {t("notes.views.bulk.refusedLine", {
            title:
              rowById.get(entry.noteId)?.title ?? t("notes.views.cards.untitled"),
            reason: refusalSentence(entry.reason, t),
          })}
        </p>
      ))}
      {listSkipped.length > 0 && (
        <p style={REFUSAL_STYLE} data-testid="view.bulk-skipped">
          {t("notes.views.bulk.skippedListValues", { count: listSkipped.length })}
        </p>
      )}
      {nothingToRestore && (
        <p style={REPORT_LINE_STYLE} data-testid="view.bulk-nothing-to-restore">
          {t("notes.views.bulk.nothingToRestore")}
        </p>
      )}
      {restored !== null && (
        <p style={REPORT_LINE_STYLE} data-testid="view.bulk-restored">
          {t("notes.views.bulk.restored", { count: restored.restoredCount })}
        </p>
      )}
      {restored !== null &&
        restored.failed.map((entry) => (
          <p key={entry.noteId} style={REFUSAL_STYLE} data-note-id={entry.noteId}>
            {t(
              entry.reason === "notRestorable"
                ? "notes.views.bulk.notRestorableLine"
                : "notes.views.bulk.restoreFailedLine",
              {
                title:
                  rowById.get(entry.noteId)?.title ??
                  t("notes.views.cards.untitled"),
              },
            )}
          </p>
        ))}
    </div>
  );

  return (
    <div data-testid={VIEW_TESTID.table} style={WRAP_STYLE}>
      {selectable && (
        <div data-testid="view.bulk-bar" style={BAR_STYLE}>
          <SearchableSelect
            testId="view.bulk-field"
            aria-label={t("notes.views.bulk.field")}
            options={fieldOptions}
            selected={[bulkField]}
            onChange={(next) => setBulkField(next[0] ?? "")}
          />
          <Input
            type="text"
            data-testid="view.bulk-value"
            aria-label={t("notes.views.bulk.value")}
            placeholder={t("notes.views.bulk.valuePlaceholder")}
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            style={{ flex: "1 1 160px", minWidth: 0 }}
          />
          <Button
            variant="primary"
            data-testid="view.bulk-apply"
            disabled={busy || selected.size === 0 || bulkField === ""}
            onClick={() => void runBulk()}
          >
            {t("notes.views.bulk.apply", { count: selected.size })}
          </Button>
          {restoreAvailable && restored === null && (
            <Button
              variant="secondary"
              data-testid="view.bulk-restore"
              disabled={busy}
              onClick={() => void runRestore()}
            >
              {t("notes.views.bulk.restore")}
            </Button>
          )}
        </div>
      )}
      {report}
      <div style={LIST_BOX_STYLE}>
        <VirtualList<TableItem>
          items={items}
          keyOf={(item) => item.key}
          renderItem={renderItem}
          estimatedRowHeight={ROW_ESTIMATED_HEIGHT}
          overflowX="auto"
        />
      </div>
    </div>
  );
}
