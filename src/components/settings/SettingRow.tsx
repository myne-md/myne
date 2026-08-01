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
// Observability (src/CLAUDE.md "Test observability"): `testId` lands on the
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
  TOGGLE_ROW_STYLE,
} from "./panel-styles";

interface SettingRowProps {
  /** The setting's name, rendered left. Already localised — call `t()` at the
   *  panel, never here (see `scripts/check-i18n.mjs`). */
  label: string;
  /** Explanatory line under the label. Omit for a setting that needs none. */
  helper?: string;
  /** The control, rendered right. Pass a function to receive the helper's id
   *  and wire the control's `aria-describedby` to it. */
  control: ReactNode | ((helperId: string) => ReactNode);
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
  control,
  error,
  anchorId,
  testId,
  helperTestId,
  stateAttrs,
  children,
}: SettingRowProps) {
  const helperId = useId();

  return (
    <div
      style={BLOCK_STYLE}
      data-setting-row="true"
      data-setting-anchor={anchorId}
      data-testid={testId}
      {...stateAttrs}
    >
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <div style={CONTROL_SLOT_STYLE}>
          {typeof control === "function" ? control(helperId) : control}
        </div>
      </div>
      {helper !== undefined && (
        <p id={helperId} style={HELPER_STYLE} data-testid={helperTestId}>
          {helper}
        </p>
      )}
      {children}
      {error != null && error !== "" && (
        <p role="alert" style={ERROR_STYLE}>
          {error}
        </p>
      )}
    </div>
  );
}
