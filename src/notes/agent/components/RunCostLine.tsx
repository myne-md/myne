// What a run cost, in the figures the user is entitled to (myne#529).
//
// **One component because the sentence is load-bearing, not decorative.**
// `design-notes/ai/0515` records this line as the compensating control for
// the remote arm having no volume bound. A control that is worded in two places
// is a control that is worded differently in two places, and the two copies had
// already drifted on their separator before this file existed.
//
// **The off-device character count is gone** (2026-11-27, on the owner's read:
// "this about-x-characters thing is not needed"). It was the longest clause on
// a line that is read at a glance and the one figure nobody acted on. What
// stays is the distinction the sentence still needs: `null` means the run never
// left this device, and it is kept apart from a remote run that sent nothing —
// a remote run now reports its requests and its reads only.

import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";

export interface RunCostLineProps {
  /** Model round-trips. */
  iterations: number;
  /** Notes read in full. */
  notesRead: number;
  /** Characters that left the device, or `null` when the run stayed local. */
  charsOffDevice: number | null;
  testId: string;
  style?: CSSProperties;
}

export function RunCostLine({
  iterations,
  notesRead,
  charsOffDevice,
  testId,
  style,
}: RunCostLineProps) {
  const { t } = useTranslation();
  const parts = [
    t("agent.review.runSummaryRequests", { count: iterations }),
    t("agent.review.runSummaryNotes", { count: notesRead }),
  ];
  if (charsOffDevice === null) parts.push(t("agent.review.runSummaryOnDevice"));
  return (
    <span data-testid={testId} style={style}>
      {parts.join(", ")}
    </span>
  );
}
