// `<SettingRow>` — the canonical Settings control layout: label on the left,
// control on the right, helper text below the label, error below that.
//
// This is the DEFAULT shape for every setting in the dialog. Its stacked
// sibling `ControlBlock` is the documented exception, for controls that need
// the full content width (reorderable lists, multi-line textareas, a long
// inline value like a filesystem path, a live preview, or a control with its
// own prose body). When in doubt, a setting is a row.
//
// Generalised from the private `ToggleRow` in `PrivacyPanel.tsx`, which had
// been the right shape all along — it just wasn't shared, so seven other
// panels each grew their own copy of the same three nested divs (and, in
// `ReminderSettings`, a copy with the design tokens replaced by hardcoded
// pixels). Composing `panel-styles` here is what keeps that from recurring.
//
// Accessibility: the helper paragraph gets a generated id, and the function
// form of `control` hands it to the caller so the control can point its
// `aria-describedby` at it. Prefer that form for any control whose helper text
// is part of its meaning — most of the toggles migrated onto this component
// had no description association at all before.
//
// **`explanation` is the second description slot** (myne-md/myne#885). It takes
// the copy that is NOT the one sentence the row needs, renders it behind a
// question mark beside the label, and hands its id to the control as the
// function's SECOND argument, so the control can name both in
// `aria-describedby`. The association is the point rather than the popover: the
// description element is in the document while collapsed, so a screen reader
// reads the full copy without the disclosure ever being opened, and a
// hover-only surface would be an accessibility failure rather than a shortcut.
// A row that passes no `explanation` is byte-for-byte the row it was before,
// which is what keeps every existing call site working with no edit.
//
// Observability (src/AGENTS.md "Test observability"): `testId` lands on the
// block root and `anchorId` on the same element as `data-setting-anchor`, the
// settings-search scroll target. Pass testids as literal strings from the
// panel — `tests/settings-search-index.test.ts` greps the panel sources for
// them, and a testid composed here from a template literal is invisible to it.

import { useId, type ReactNode } from "react";
import {
  BLOCK_STYLE,
  CONTROL_SLOT_STYLE,
  ERROR_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  TOGGLE_ROW_COMPACT_STYLE,
  TOGGLE_ROW_STYLE,
} from "./panel-styles";
import { HelperDisclosure } from "./HelperDisclosure";
import { ornamentRole } from "@myne/ornaments";
import { useSettingsCompact } from "./settingsCompact";

interface SettingRowProps {
  /** The setting's name, rendered left. Already localised — call `t()` at the
   *  panel, never here (see `scripts/check-i18n.mjs`). */
  label: string;
  /** Explanatory line under the label. Omit for a setting that needs none.
   *  This is the CRITICAL sentence: what the setting does, in one line. */
  helper?: string;
  /**
   * The rest of what the setting has to say, one string per paragraph.
   *
   * Rendered behind a question mark beside the label and named by the control
   * through `aria-describedby`, so it is reachable by keyboard and announced to
   * assistive tech while the row is collapsed. Already localised: call `t()` at
   * the panel, never here.
   */
  explanation?: readonly string[];
  /** The control, rendered right. Pass a function to receive the helper's id
   *  and the explanation's id (the second is `undefined` when the row has no
   *  `explanation`) and wire the control's `aria-describedby` to whichever it
   *  needs. */
  control:
    | ReactNode
    | ((helperId: string, explanationId: string | undefined) => ReactNode);
  /** Save-failure text, announced when it appears. `null` renders nothing. */
  error?: string | null;
  /** Settings-search scroll target (MYND-536) — the registry `id`. */
  anchorId?: string;
  /** `data-testid` on the block root. */
  testId?: string;
  /** `data-testid` on the helper paragraph, for the settings whose helper text
   *  IS the readout (quick-unlock reports which method is configured there). */
  helperTestId?: string;
  /** Extra `data-*` state discriminators on the block root, so a scenario can
   *  assert what a row IS rather than scraping how it looks. Enum-ish state
   *  only — never vault content. The CLI block is the worked example: it
   *  publishes a folder COUNT, because a folder NAME here would land in every
   *  screenshot and CI failure artefact. */
  stateAttrs?: Record<`data-${string}`, string>;
  /** Full-width content below the helper: a control that only appears for
   *  certain selections, a disclosure, a nested block. */
  children?: ReactNode;
}

export function SettingRow({
  label,
  helper,
  explanation,
  control,
  error,
  anchorId,
  testId,
  helperTestId,
  stateAttrs,
  children,
}: SettingRowProps) {
  const helperId = useId();
  const explanationId = useId();
  const hasExplanation = explanation !== undefined && explanation.length > 0;
  // Narrow dialog: restack the control under the label so a shrinking label
  // cell can never paint over the control (#391).
  const compact = useSettingsCompact();

  return (
    <div
      style={BLOCK_STYLE}
      data-setting-row="true"
      data-setting-anchor={anchorId}
      data-testid={testId}
      // A setting row is a BOX (myne#394) — the same role callouts and cards
      // take, so a theme that gives boxes a frame gives one here too.
      {...ornamentRole("box")}
      data-setting-compact={compact ? "true" : undefined}
      {...stateAttrs}
    >
      <div style={compact ? TOGGLE_ROW_COMPACT_STYLE : TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>
          {label}
          {hasExplanation && (
            <HelperDisclosure
              paragraphs={explanation}
              descriptionId={explanationId}
              // The row's own testid, which the disclosure turns into
              // `<row>-explain` for the trigger and `<row>-explanation` for the
              // copy. A row with no testid gets none, the same contract the row
              // root already has.
              testId={testId}
            />
          )}
        </span>
        <div style={CONTROL_SLOT_STYLE}>
          {typeof control === "function"
            ? control(helperId, hasExplanation ? explanationId : undefined)
            : control}
        </div>
      </div>
      {helper !== undefined && (
        <p id={helperId} style={HELPER_STYLE} data-testid={helperTestId}>
          {helper}
        </p>
      )}
      {children}
      {error != null && error !== "" && (
        // The error slot is a state a scenario has to be able to WAIT ON, and a
        // `role="alert"` with no id cannot be addressed from the driver. Derived
        // from the row's own testid so the two cannot drift, and absent when the
        // row passes none (nothing to address it by).
        <p
          role="alert"
          style={ERROR_STYLE}
          data-testid={testId === undefined ? undefined : `${testId}-error`}
        >
          {error}
        </p>
      )}
    </div>
  );
}
