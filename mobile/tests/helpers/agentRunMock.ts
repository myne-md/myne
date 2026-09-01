// One mock of the agent's IPC bindings, for every spec that mounts a surface
// which reaches them (myne-md/myne#456).
//
// **This exists because a per-file mock breaks when a DIFFERENT task wires a
// new call.** It happened three times in one branch, always the same way: task
// 11 made `AiChatFlow` call `agentPreviewGrant`, task 12 made it mount the
// review, task 13 made it mount the undo strip, and each time two unrelated
// spec files failed with `No "<name>" export is defined on the … mock`. The
// failure is loud, which is right, but the fix belonged in one place.
//
// The complete set is deliberate. A partial mock is not a smaller stub: it is a
// spec that passes until somebody adds a call, and the spec that then fails is
// never the one whose subject changed.

import { vi } from "vitest";

export const agentStart = vi.fn();
export const agentApproveScope = vi.fn();
export const agentPreviewGrant = vi.fn();
export const agentCancel = vi.fn();
export const agentApply = vi.fn();
export const agentUndo = vi.fn();
export const agentLastRun = vi.fn();
export const agentCapability = vi.fn();

/** The module factory. Pass to `vi.mock("../../src/lib/agent-run", …)`. */
export function agentRunModule() {
  return {
    agentStart: (...a: unknown[]) => agentStart(...a),
    agentApproveScope: (...a: unknown[]) => agentApproveScope(...a),
    agentPreviewGrant: (...a: unknown[]) => agentPreviewGrant(...a),
    agentCancel: (...a: unknown[]) => agentCancel(...a),
    agentApply: (...a: unknown[]) => agentApply(...a),
    agentUndo: (...a: unknown[]) => agentUndo(...a),
    agentLastRun: (...a: unknown[]) => agentLastRun(...a),
    agentCapability: (...a: unknown[]) => agentCapability(...a),
  };
}

/** Reset every binding, and give the two that surfaces call ON MOUNT a benign
 *  answer. Without those two defaults an unrelated spec's first render throws
 *  inside an effect, which reports as that spec's failure rather than as a
 *  missing default here. */
export function resetAgentRunMock(): void {
  for (const m of [
    agentStart,
    agentApproveScope,
    agentPreviewGrant,
    agentCancel,
    agentApply,
    agentUndo,
    agentLastRun,
    agentCapability,
  ]) {
    m.mockReset();
  }
  // The scope strip's pre-run disclosure.
  agentPreviewGrant.mockResolvedValue({
    noteCount: 4,
    excludedCount: 0,
    unknownCount: 0,
    newTotal: 4,
  });
  // The undo strip asks on mount; null means "no offer", which is the state
  // every spec that is not about undo wants.
  agentLastRun.mockResolvedValue(null);
  // The capability gate, which the composer runs on SEND (not on mount: a probe
  // is a third-party request, so firing it on render would make opening the tab
  // an act of egress). A passing verdict is the state every spec that is not
  // about the gate wants; the two that ARE override it.
  agentCapability.mockResolvedValue({ passed: true });
}
