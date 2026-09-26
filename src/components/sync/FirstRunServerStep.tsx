// SPDX-License-Identifier: AGPL-3.0
// The first-run sync-server step (myne-md/myne#768).
//
// Identity creation registers a person account at a sync endpoint, so it cannot
// succeed without one: `plugin:sync|sync_person_setup` returns a typed
// `NotConfigured` when the device has no endpoint (`core/src/plugins/sync/person_account.rs`).
// Before this step existed the only thing a user saw was the identity dialog's
// generic error telling them to configure a server, with no way to do it from
// where they were standing (the settings surface is unreachable at zero vaults).
//
// The control is the SAME `EndpointConfig` the Settings panel mounts: free-text
// URL, Connect, TOFU leaf-certificate fingerprint, the same device-local
// `sync-config.json`. A second endpoint control would be a second contract, and
// the two would drift in exactly the place a user is least able to recover. What
// this component adds is the first-run framing and the continue gate, not a new
// way to configure a server.
//
// Deliberately no hosted preset. `hosted_static_pin()` is `None` until hosted
// launch, so there is no address to pre-fill, and naming an "official" server in
// the UI would be a policy statement about which server is trusted
// (`decisions/sync/0020` puts self-hosted and hosted at the same boundary).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/core";
import { Button } from "../primitives/Button";
import { EndpointConfig } from "./EndpointConfig";
import { BetaTermsConsent } from "./BetaTermsConsent";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";

interface FirstRunServerStepProps {
  /** Called once a server is configured, so the caller can advance to identity
   *  creation. Not fired while unconfigured. */
  onConnected: () => void;
  /** Abandon the step. The caller decides where Back leads. */
  onBack: () => void;
}

/**
 * Whether this device has a sync endpoint configured. The same read
 * `EndpointConfig` hydrates itself from, so the gate and the control cannot
 * disagree about what "configured" means.
 */
export function useHasSyncEndpoint(): boolean {
  const [hasEndpoint, setHasEndpoint] = useState(false);
  useEffect(() => {
    let alive = true;
    void invoke<{ endpoint_url: string | null }>("plugin:sync|sync_get_endpoint")
      .then((c) => {
        if (alive) setHasEndpoint(Boolean(c.endpoint_url));
      })
      .catch(() => {
        /* unconfigured */
      });
    return () => {
      alive = false;
    };
  }, []);
  return hasEndpoint;
}

export function FirstRunServerStep({ onConnected, onBack }: FirstRunServerStepProps) {
  const { t } = useTranslation();
  // Re-read after the user connects, otherwise the Continue button would stay
  // disabled over an endpoint the control just accepted. A local remount key is
  // enough: `EndpointConfig` owns the connect call and its own success state.
  const [configured, setConfigured] = useState(false);
  const hasEndpoint = useHasSyncEndpoint();
  // The beta-terms gate stands at every door that first enables sync
  // (`decisions/sync/0483`), and this first-run step is one: it is where a user
  // with no vault configures a server for the first time. Reused rather than
  // reimplemented, so the consent text cannot drift between doors.
  const betaTerms = useBetaTermsGate();
  const [termsOpen, setTermsOpen] = useState(false);

  const connected = configured || hasEndpoint;

  // Gate the CONTINUE on the terms, not the connect: the endpoint control writes
  // the device-local config, which is not itself the consenting act. Identity
  // creation is, so that is what the gate fronts.
  const advance = () => {
    if (betaTerms.needed) {
      setTermsOpen(true);
      return;
    }
    setConfigured(true);
    onConnected();
  };

  return (
    <div
      data-testid="first-run-server.root"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div
          style={{
            fontSize: "var(--text-xl)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--fg-display)",
          }}
        >
          {t("firstRun.server.heading")}
        </div>
        <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--fg-2)" }}>
          {t("firstRun.server.intro")}
        </div>
      </div>

      <EndpointConfig />

      {!connected && (
        <p
          data-testid="first-run-server.not-configured"
          style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", margin: 0, lineHeight: 1.5 }}
        >
          {t("firstRun.server.notConfigured")}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <Button variant="ghost" onClick={onBack} icon="arrow-left" data-testid="first-run-server.back">
          {t("firstRun.server.back")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          disabled={!connected}
          data-testid="first-run-server.continue"
          onClick={advance}
        >
          {t("firstRun.server.continue")}
        </Button>
      </div>

      <BetaTermsConsent
        open={termsOpen}
        testId="first-run-server.beta-terms"
        onAccept={() => {
          setTermsOpen(false);
          void betaTerms.accept();
          setConfigured(true);
          onConnected();
        }}
        onCancel={() => setTermsOpen(false)}
      />
    </div>
  );
}
