// Mobile's binding of the agent plugin's IPC surface (myne-md/myne#456).
//
// **This file is a seam injection and nothing else**, which is the whole point
// of it being this short. The bindings themselves, with their command names,
// their argument shapes and the doc comments explaining why each argument
// exists, live in `@myne/agent-run-core` and are shared with the desktop
// client. Two hand-typed copies of `plugin:agent|agent_apply` would be two
// chances to send the whole proposal where only the approved subset belongs,
// and neither the compiler nor the per-plugin ACL guard can see that: the ACL
// compares four RUST-side sources, and the caller is on the other side of IPC.
//
// This is the ONE place under `mobile/src` allowed to hand `invoke` and
// `Channel` to those bindings, because `mobile/src/platform/` is this tree's
// seam (`scripts/check-platform-seam.mjs`, myne#492). The shared core imports
// neither.
//
// Mobile registers a NINTH command desktop does not have,
// `agent_list_provider_models`, and it is deliberately not in the shared core:
// it exists because this client has no local model to fall back on, so the
// chooser has to ask the provider. It lives in `ai.ts` beside the capability
// probe.

import { Channel, invoke } from "../platform/core";

import { makeAgentRun } from "@myne/agent-run-core";
import { setAgentPrefsNonceBump } from "@myne/agent-store";
import { bumpPrefsNonce } from "./prefsNonce";

export * from "@myne/agent-protocol";

// The agent's setting writes happen HOST-side, so the prefs nonce has to be
// bumped when an apply reports one (myne-md/myne#850). The store takes that bump
// as a binding rather than importing a module, because this client's nonce
// module is NOT desktop's; this is mobile's installation, and it is the reason
// the shared store no longer imports `src/notes/prefsNonce` (which would have
// bumped a module nothing on the phone listens to).
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
