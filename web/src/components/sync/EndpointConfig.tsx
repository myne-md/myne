// The web build's sync-server panel (phase3-web-client task 96).
//
// # The desktop panel tells a browser user two things that are not true
//
// **A free-text server URL is a lie of capability.** Task 50 fixes the sync
// origin when the container starts and generates a `connect-src` naming exactly
// it, so any other address is blocked by the CSP before a request leaves the
// page. An input inviting the user to type one offers a choice the deployment
// has already made — and the failure, when they take it, is a network error
// with no explanation.
//
// **A certificate fingerprint is a lie of security.** The desktop panel shows a
// SHA-256 leaf-certificate fingerprint with a `static` / `tofu` badge, for the
// user to eye-compare across devices (`self-host-policy.md` §6). A page cannot
// see a leaf certificate at all. Whatever appeared there would be a security
// affordance backed by nothing, which is worse than no affordance: it invites a
// check the user then believes they have performed.
//
// So this shows the configured origin READ-ONLY and says, in the wording the
// A4-per-client row already uses, that the browser verifies the certificate and
// this client cannot pin one. Substituting the module (rather than branching
// inside it) also keeps `sync.endpoint.pinStatic` and `sync.endpoint.pinTofu` —
// the two claims that are false here — out of the bundle entirely.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../../../src/platform/core";
import { deploymentSyncOrigin } from "../../platform/deployment-config";

const HELP: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  margin: 0,
};

const ORIGIN: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--paper-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  overflowWrap: "anywhere",
};

export function EndpointConfig() {
  const { t } = useTranslation();
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Stored config FIRST, deployment config as the fallback — the same order
    // `AccountBootstrap` uses, and for the same reason: on this client the
    // deployment is what fixes the origin (task 50), and the stored copy is a
    // consequence of the join rather than the source of truth.
    //
    // The fallback is not theoretical. On a signed-in, actively syncing session
    // this panel read `null` and rendered "No sync server is configured for this
    // deployment" while the client was talking to `sync.myne.md` — the config
    // was on disk and correct (verified in OPFS), so something between the two
    // answers `Absent`. Which is a bug worth finding, and separately: a panel
    // whose whole job is to name the server must not be the thing that reports
    // a working session as unconfigured.
    void invoke<{ endpoint_url: string | null } | null>("plugin:sync|sync_get_endpoint")
      .then(async (c) => {
        const stored = c?.endpoint_url ?? null;
        if (!cancelled) setOrigin(stored ?? (await deploymentSyncOrigin()));
      })
      .catch(async () => {
        // A read failure is not worth a banner here: the panel's job is to say
        // WHICH server this client talks to, and the deployment can still answer
        // that even when the stored copy cannot be read.
        const fallback = await deploymentSyncOrigin();
        if (!cancelled) setOrigin(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
      data-testid="sync.endpoint-config"
    >
      {origin !== null ? (
        <>
          <div style={ORIGIN} data-testid="sync.endpoint-origin">
            {origin}
          </div>
          <p style={HELP}>{t("sync.endpoint.fixedOrigin")}</p>
          <p style={HELP} data-testid="sync.pin-source" data-pin-source="platform_trust_store">
            {t("sync.endpoint.pinPlatformTrust")}
          </p>
        </>
      ) : (
        <p style={HELP} data-testid="sync.endpoint-none">
          {t("sync.endpoint.fixedOriginNone")}
        </p>
      )}
    </div>
  );
}
