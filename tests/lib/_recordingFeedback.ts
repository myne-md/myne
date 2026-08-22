// A feedback pair whose arms record that they ran.
//
// Shared by `clipboard.test.ts` and `secret-export.test.ts` rather than defined
// twice, because both suites are asserting the same contract: an arm ran, and
// which one. Two private copies could silently disagree about what "announced"
// means, which is the thing under test in both files.
//
// The arm KIND is a parameter because it is the one thing the two suites
// legitimately differ on, and `announce` does not distinguish it: the copy
// surfaces use a toast, the vault-creation screens an inline line, and the
// recording is identical either way.

import type { Feedback, FeedbackArm } from "../../src/lib/clipboard";

export type RecordedArm = "success" | "failure";

export function recordingFeedback(
  kind: Extract<FeedbackArm, { kind: "toast" | "inline" }>["kind"] = "toast",
): { feedback: Feedback; ran: RecordedArm[] } {
  const ran: RecordedArm[] = [];
  return {
    ran,
    feedback: {
      onSuccess: { kind, run: () => ran.push("success") },
      onFailure: { kind, run: () => ran.push("failure") },
    },
  };
}
