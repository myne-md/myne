// The presence-side caller of the identity resolver (`member-devices` task 5).
//
// Extracted from `PaneView`'s resolver effect so a test can drive it without a
// PaneView harness (the pane has none by design: it is the whole editor
// surface, so its assertions elsewhere are source-reading). What lives here is
// the effect's BODY and nothing else: for every peer whose signed assertion did
// not verify, ask the backend resolver once and write the label back into the
// awareness store.
//
// # Why the loop is here rather than inline
//
// The rule that turns a `ResolvedIdentity` into a label is
// `resolvedIdentityLabel`, shared with the version history, and it returns a
// DESCRIPTOR rather than a string precisely because this loop's output lands in a
// module-scope store. Keeping the loop beside the rule is what makes the "one
// rule, two surfaces" claim testable: the test drives this function with a fake
// resolver and then renders the real roster, so it exercises the same path the
// app runs rather than a copy of it.
//
// # What this must NOT do
//
// No id is hashed, truncated or otherwise interpreted here. The store's
// `awarenessResolveLabel` takes the label the resolver produced and the peer's
// own id, and the resolver is the only component that knows how either maps to
// a person (the `participant.ts` doc comment states the same limit for the
// colour hash).

import type { ResolvedIdentity } from "../../types/resolved-identity";
import type { Participant } from "./participant";
import { awarenessResolveLabel, setAwareness } from "./awarenessStore";
import { resolvedIdentityLabel } from "./identityLabel";

/** The resolver as this module consumes it: `src/lib/identity.ts::resolveIdentity`. */
export type IdentityResolver = (actorHex: string) => Promise<ResolvedIdentity>;

/**
 * Resolve every un-attributed peer's label and write it back into the awareness
 * store. Peers already attributed are skipped, so a frame that already carries a
 * label is never re-resolved.
 *
 * A peer whose identity resolves to `Unknown` is left un-attributed on purpose:
 * the roster renders its own degraded copy for that case (see
 * `resolvedIdentityLabel`), and writing a label would claim an attribution the
 * backend explicitly did not make.
 *
 * A rejection leaves the peer un-attributed for the next frame to retry, which
 * is why nothing is rethrown: a resolver hiccup must not take the editor down.
 *
 * NO translator is taken, and that is the point: what is written into the store is
 * the DESCRIPTOR the rule returns, and each surface renders it with the `t` it
 * holds when it renders. This loop runs once per peer from an effect, so a string
 * produced here would outlive the language it was produced in
 * (`src/AGENTS.md`; `identityLabel.ts` carries the reasoning).
 */
export async function resolvePeerLabels(
  peers: Iterable<Participant>,
  resolve: IdentityResolver,
): Promise<void> {
  for (const peer of peers) {
    if (!peer.unAttributed) continue;
    let identity: ResolvedIdentity;
    try {
      identity = await resolve(peer.id);
    } catch {
      continue;
    }
    const label = resolvedIdentityLabel(identity);
    if (label === null) continue;
    setAwareness((s) => awarenessResolveLabel(s, peer.id, label));
  }
}
