// Desktop's binding of the agent plugin's IPC surface (myne-md/myne#529).
//
// The bindings themselves, with their doc comments and their argument shapes,
// live in `agent-run-core.ts` and are shared with the mobile client
// (myne-md/myne#456). This file is the seam injection and nothing else: it is
// the ONE place under `src/` allowed to hand `invoke` and `Channel` to them,
// which is what `scripts/check-platform-seam.mjs` is checking.
//
// Every name this module used to export it still exports, from the same
// specifier, so no importer changed.

import { Channel, invoke } from "../platform/core";

import { makeAgentRun } from "./agent-run-core";

export * from "./agent-protocol";

const bound = makeAgentRun({ invoke, Channel });

export const {
  agentStart,
  agentApproveScope,
  agentPreviewGrant,
  agentCancel,
  agentApply,
  agentUndo,
  agentLastRun,
  agentCapability,
} = bound;
