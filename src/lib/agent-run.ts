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
import { bumpPrefsNonce } from "../notes/prefsNonce";
import { setAgentPrefsNonceBump } from "../notes/agent/agentStore";

export * from "./agent-protocol";

// The agent's setting writes happen HOST-side, so the prefs nonce has to be
// bumped when an apply reports one (myne-md/myne#850). The store takes that bump
// as a binding rather than importing a module, because the mobile client has a
// different nonce module; this is the desktop client's installation. Here rather
// than at a screen, so every apply path in this client is wired by construction.
setAgentPrefsNonceBump(bumpPrefsNonce);

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
