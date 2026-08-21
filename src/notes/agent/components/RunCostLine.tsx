// What a run cost, in the three figures the user is entitled to (myne#529).
//
// **One component because the sentence is load-bearing, not decorative.**
// `design-notes/ai/0515` records this line as the compensating control for
// the remote arm having no volume bound: "the residual is disclosed rather than
// capped: a finished run reports the requests it made, the notes it read, and
// how much text left the device". A control that is worded in two places is a
// control that is worded differently in two places, and the two copies had
// already drifted on their separator before this file existed.
//
// The third figure is the one the argument actually rests on, which is why
// `null` and `0` are kept apart all the way to the screen: "the run stayed on
// this device" and "the run was remote and sent nothing" are different
// statements, and collapsing them into a zero would report the second as the
// first.

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
  return (
    <span data-testid={testId} style={style}>
      {t("agent.review.runSummaryRequests", { count: iterations })}
      {", "}
      {t("agent.review.runSummaryNotes", { count: notesRead })}
      {", "}
      {charsOffDevice === null
        ? t("agent.review.runSummaryOnDevice")
        : t("agent.review.runSummaryOffDevice", { count: charsOffDevice })}
    </span>
  );
}
