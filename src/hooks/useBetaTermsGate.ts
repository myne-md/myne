// Whether this device still owes an acceptance of the beta terms (operations#15).
//
// A hook rather than three copies of the same `useEffect`, because sync turns
// on through THREE doors — the Settings enrol form, the welcome-screen join
// modal, and the web account bootstrap — and a gate placed at one of them is
// not a gate. Each door renders `BetaTermsConsent` while `needed` is true and
// proceeds only after `accept()` resolves.
//
// The record and the comparison live below the seam
// (`src/platform/legal-consent.ts`, and `legal_consent.rs` beneath it on
// desktop); this hook only holds the answer for a render tree.

import { useCallback, useEffect, useState } from "react";

import { BETA_TERMS_VERSION } from "../lib/load-bearing-copy";
import { acceptBetaTerms, betaTermsAccepted } from "../platform/legal-consent";

export interface BetaTermsGate {
  /** The answer has not arrived yet. Render neither the gate nor the door. */
  pending: boolean;
  /** The terms this build ships have not been accepted on this device. */
  needed: boolean;
  /** Record the acceptance, then open the door. */
  accept: () => Promise<void>;
}

/**
 * Read the device-local acceptance once on mount.
 *
 * The initial state is `null` — *unknown*, distinct from both answers — because
 * defaulting to "accepted" would flash the enrolment form before the gate on
 * every mount, and defaulting to "needed" would flash the terms at someone who
 * accepted them months ago. Neither is a spinner-worthy wait (one local read),
 * but both are visible.
 */
export function useBetaTermsGate(): BetaTermsGate {
  const [accepted, setAccepted] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void betaTermsAccepted(BETA_TERMS_VERSION)
      .then((ok) => {
        if (!cancelled) setAccepted(ok);
      })
      .catch(() => {
        // The seam already reduces every failure to `false`; this catch is for
        // a rejection it did not model. Same direction: ask rather than assume.
        if (!cancelled) setAccepted(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const accept = useCallback(async () => {
    await acceptBetaTerms(BETA_TERMS_VERSION);
    setAccepted(true);
  }, []);

  return { pending: accepted === null, needed: accepted === false, accept };
}
