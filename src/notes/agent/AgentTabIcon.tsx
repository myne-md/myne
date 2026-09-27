// The agent tab's glyph in the tab strip (myne-md/myne#771).
//
// ── Why the orb moved here ─────────────────────────────────────────────────
// The run indicator had exactly one home: the agent pane's own top row, while
// a run was in flight. That is the one place it is least needed — you are
// already looking at the conversation, and the composer's Send is already
// spinning. And because a short run settles in about a second, the indicator
// that exists to report a MULTI-MINUTE wait was, in practice, never seen at
// all.
//
// The tab is the honest home. It is visible from every other tab in the pane,
// so a run started and walked away from still says so; and it costs no layout,
// because the glyph slot is already there and already 14px, which is the orb's
// own size.
//
// ── Why this is a component rather than a node passed in ───────────────────
// `PaneView` renders the whole pane. Subscribing IT to the agent store would
// re-render the editor, the tab strip and every float on each progress report
// a run emits. So the subscription lives in the leaf that actually changes:
// this component is what `iconNodeOf` hands back, and only this re-renders.
//
// ── The words are not here, deliberately ───────────────────────────────────
// The orb is a named motion-canon exemption whose terms require the run's
// status to be stated in WORDS somewhere a screen reader reaches
// (`design-notes/ai/0621`). The tab's icon slot is `aria-hidden` — correct,
// since the tab's accessible name is its title — so this carries no label and
// adds no claim. The words stay where they were: the pane's own run label,
// beside the pane's own orb.

import { Icon } from "../../components/primitives/Icon";
import { useAgent } from "./agentStore";
import { AgentRunOrb } from "./AgentRunOrb";

/** The tab's resting glyph. The same plain speech bubble `tabKinds.ts` names,
 *  and it is named in BOTH places on purpose: the registry's value is what a
 *  tab with no run shows everywhere else (the overflow menu, the palette), and
 *  this file only overrides the strip. */
const RESTING: "message-square" = "message-square";

export function AgentTabIcon() {
  // A run is RUNNING, not merely open: the store keeps `view` after a run
  // settles so the review surface can read it, and an orb over a finished run
  // is the one state it must never report. Same reasoning as the orb's own.
  const running = useAgent().running;
  return running ? <AgentRunOrb /> : <Icon name={RESTING} size={13} />;
}
