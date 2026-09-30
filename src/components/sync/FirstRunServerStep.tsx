// SPDX-License-Identifier: AGPL-3.0
// The first-run sync-server step (myne-md/myne#768, choice added myne-md/myne#780).
//
// Identity creation registers a person account at a sync endpoint, so it cannot
// succeed without one: `plugin:sync|sync_person_setup` returns a typed
// `NotConfigured` when the device has no endpoint (`core/src/plugins/sync/person_account.rs`).
// Before this step existed the only thing a user saw was the identity dialog's
// generic error telling them to configure a server, with no way to do it from
// where they were standing (the settings surface is unreachable at zero vaults).
//
// # The choice
//
// The step now opens with two doors, because "which server" has two honest
// answers: `Myne Sync` (the hosted server, one tap) and `self-hosted` (the
// operator types their own URL). Both are first-class and neither is presumed:
// `decisions/sync/0020` puts hosted and self-host at the same trust boundary.
//
// The hosted door writes `HOSTED_SYNC_ORIGIN` and lets the first connection
// TOFU-pin the leaf; it deliberately does NOT claim a pre-vetted build-time pin
// (that pin, and the SPKI mechanism a renewal-safe one needs, is myne-md/myne#781).
// The self-hosted door is the SAME `EndpointConfig` the Settings panel mounts:
// free-text URL, Connect, TOFU leaf-certificate fingerprint, the same
// device-local `sync-config.json`. A second endpoint control would be a second
// contract, and the two would drift in exactly the place a user is least able
// to recover. What this component adds is the first-run framing, the choice and
// the continue gate, not a new way to configure a server.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HOSTED_SYNC_ORIGIN } from "@myne/client-core/hosted-sync";
import { invoke } from "../../platform/core";
import { Button } from "../primitives/Button";
import { CHOICE_ACTION_STYLE, ChoiceCard, ChoiceRow } from "../ChoiceList";
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
  // Which door is open. `choose` is the fork itself; `self-hosted` is the URL
  // form behind the second door.
  const [mode, setMode] = useState<"choose" | "self-hosted">("choose");
  const [hostedBusy, setHostedBusy] = useState(false);
  const [hostedError, setHostedError] = useState(false);
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

  // The hosted door: write the Myne server and let the first connection pin its
  // leaf (TOFU). No fingerprint claim is shown; the pin source the backend
  // records is `tofu` and the copy stays honest about it.
  const connectHosted = () => {
    setHostedBusy(true);
    setHostedError(false);
    void invoke("plugin:sync|sync_set_endpoint", {
      endpointUrl: HOSTED_SYNC_ORIGIN,
      confirmedFingerprint: null,
    })
      .then(() => {
        setConfigured(true);
        advance();
      })
      .catch(() => setHostedError(true))
      .finally(() => setHostedBusy(false));
  };

  if (mode === "choose") {
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
            {t("firstRun.server.chooseHeading")}
          </div>
          <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--fg-2)" }}>
            {t("firstRun.server.chooseIntro")}
          </div>
        </div>

        {/* Two doors on one card, each saying where it leads: the hint under
            Myne Sync is the honest pin statement (TOFU), so it has to be read
            before the button, not after it. */}
        <ChoiceCard>
          <ChoiceRow
            title={t("firstRun.server.myneSyncTitle")}
            body={t("firstRun.server.myneSyncHint")}
            action={
              <Button
                variant="primary"
                disabled={hostedBusy}
                onClick={connectHosted}
                data-testid="first-run-server.myne-sync"
                style={CHOICE_ACTION_STYLE}
              >
                {hostedBusy ? t("firstRun.server.connecting") : t("firstRun.server.connectAction")}
              </Button>
            }
          />
          <ChoiceRow
            title={t("firstRun.server.selfHostedTitle")}
            body={t("firstRun.server.selfHostedHint")}
            action={
              <Button
                variant="secondary"
                disabled={hostedBusy}
                onClick={() => setMode("self-hosted")}
                data-testid="first-run-server.self-hosted"
                style={CHOICE_ACTION_STYLE}
              >
                {t("firstRun.server.setUpAction")}
              </Button>
            }
            last
          />
        </ChoiceCard>

        {hostedError && (
          <p
            data-testid="first-run-server.hosted-error"
            style={{ fontSize: "var(--text-sm)", color: "var(--danger)", margin: 0 }}
          >
            {t("firstRun.server.hostedError")}
          </p>
        )}

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          <Button variant="ghost" onClick={onBack} icon="arrow-left" data-testid="first-run-server.back">
            {t("firstRun.server.back")}
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
        <Button
          variant="ghost"
          onClick={() => setMode("choose")}
          icon="arrow-left"
          data-testid="first-run-server.back"
        >
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
