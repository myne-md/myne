// `<ControlBlock>` — the STACKED settings shape: label, then the control at
// full content width, then the helper.
//
// This is the exception, not the default. `SettingRow` (label left / control
// right) is the canonical Settings layout; reach for this one only when the
// control genuinely needs the whole column:
//
//   - a reorderable or scrollable list (the floating-toolbar customizer)
//   - a multi-line `<textarea>` (the excluded-folder editors)
//   - a long value rendered inline (the vault's filesystem path)
//   - a live preview (the typography specimen)
//   - a control with its own prose body
//
// Anything that fits beside its label — a `Switch`, a dropdown trigger, a
// short `Segmented`, a button or two — belongs in a `SettingRow`.

import type { ReactNode } from "react";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

interface ControlBlockProps {
  label: string;
  helper: string;
  control: ReactNode;
  /** Settings-search scroll target (MYND-536) — the registry `id`. */
  anchorId?: string;
  /** `data-testid` on the block root. */
  testId?: string;
}

export function ControlBlock({
  label,
  helper,
  control,
  anchorId,
  testId,
}: ControlBlockProps) {
  return (
    <div style={BLOCK_STYLE} data-setting-row="true" data-setting-anchor={anchorId} data-testid={testId}>
      <span style={LABEL_STYLE}>{label}</span>
      {control}
      <p style={HELPER_STYLE}>{helper}</p>
    </div>
  );
}
