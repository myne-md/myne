// The agent run indicator (myne-md/myne#771, task 12).
//
// **This is the named motion-canon exemption.** It runs while a run is active
// and stops when the run stops; it is a state indication with a bounded
// lifetime, never ambient decoration. `polish-epic-prompt.md` D1 preserves "no
// motion on keyboard-initiated or 100+/day actions" verbatim, and the bounded
// lifetime is this surface's answer to it: there is nothing to indicate when no
// run is running, so nothing animates.
//
// Task 2 lands the component as a placeholder; task 12 builds the field and
// registers the exemption with `scripts/check-motion-canon.mjs` beside the `01`
// binary field. Until then it renders nothing, which is also what it does when
// no run is active.

import { useAgent } from "./agentStore";

export function AgentRunOrb() {
  const agent = useAgent();
  // A run is active exactly when the store holds a view. Rendering nothing is
  // the correct off state, not a missing one.
  if (agent.view === null) return null;
  // Placeholder until task 12: a text marker carries the state while the field
  // itself is built. `aria-hidden` will stay on the decorative field; the state
  // is always stated in text, which is what this renders today.
  return (
    <span
      data-testid="agent.run-orb"
      style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
    >
      ·
    </span>
  );
}
