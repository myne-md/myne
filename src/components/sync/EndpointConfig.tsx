// Sync server endpoint configuration. The native host verifies the CA chain and
// the server name against public CA roots bundled with the app; the browser uses
// its own TLS verifier. Loopback HTTP is local only. There is no certificate pin
// and no fingerprint anywhere in this flow (`docs/decisions/sync/0620`).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/core";
import { refreshTorState } from "../../hooks/useTorState";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { Icon } from "../primitives/Icon";

/**
 * The endpoint's trust status, in the backend's own words.
 *
 * One value, and that is the honest answer rather than a legacy remnant: since
 * `docs/decisions/sync/0620` every client verifies a public CA chain plus the
 * server name, so a `https` endpoint always reports `platform_trust_store` and
 * a loopback `http` one always reports `null`. The WIRE NAME is the retired one
 * (`PinSource` in `core/src/plugins/sync/config.rs`) because renaming it moves
 * three clients' IPC contract and a locale string for no reader's benefit.
 *
 * A one-variant union is kept rather than flattened to a boolean so the value
 * survives a future change to the set; do not read the single variant as a
 * leftover, and do not add one back without a decision entry.
 */
type PinSource = "platform_trust_store" | null;

const ROW: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
};

const FIELD_FILL: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const HELP: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
  lineHeight: "var(--leading-normal)",
};

// HTTPS trust status stays visible when a saved endpoint is loaded.
const NOTE_BLOCK: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent-soft)",
  borderRadius: "var(--radius-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: "var(--leading-normal)",
};

export function EndpointConfig({
  onConnected,
  onEdit,
  initialUrl,
  lockedUrl = false,
}: {
  onConnected?: () => void;
  onEdit?: () => void;
  /**
   * Seed the address on mount, for the first-run HOSTED door (myne-md/myne#800):
   * the hosted server is the gated one, so its one-tap connection needs the
   * invite-code field the self-hosted form already has. Seeding the SAME control
   * rather than adding a second one is the file's own rule — "a second endpoint
   * control would be a second contract".
   */
  initialUrl?: string;
  /**
   * Render the address read-only. The hosted door fixes the origin (`the browser
   * fixes the origin`, and the desktop hosted door writes `HOSTED_SYNC_ORIGIN`
   * for the same reason), so the user may enter only the invite code.
   */
  lockedUrl?: boolean;
} = {}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(initialUrl ?? "");
  // The endpoint this device is currently connected to (loaded, or set on a
  // successful connect). When the input still equals it, there is nothing to do
  // and the button rests as a disabled "Connected" (E4c).
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The shared admission code for a gated server (`MYNE_INVITE_CODE` on the
  // server). Optional: an open server (self-host, fresh clone) needs none.
  // Device-local, never synced and never backed up.
  const [inviteCode, setInviteCode] = useState("");
  // `null` means loopback HTTP, never an unverified remote TLS session.
  const [pinSource, setPinSource] = useState<PinSource>(null);
  // On the LOCKED hosted door the address is read-only, so editing it can never
  // fire the address `onChange` that re-reveals the invite field. This flag is
  // the manual escape hatch for that door (myne-md/myne#822).
  const [revealCode, setRevealCode] = useState(false);

  useEffect(() => {
    // `cert_pin_hex` is on the wire and is always `null` since 0620. It is not
    // declared here: this type describes what THIS component reads, and a
    // declared-but-unread field is a field the next reader greps for.
    void invoke<{
      endpoint_url: string | null;
      pin_source: PinSource;
      invite_code: string | null;
    }>("plugin:sync|sync_get_endpoint")
      .then((c) => {
        // A seeded hosted door keeps its fixed origin; only the invite code is
        // hydrated (and only if the stored code belongs to that same origin,
        // which `set_endpoint`'s read-modify-write already enforces).
        if (lockedUrl) {
          if (initialUrl && c.endpoint_url === initialUrl) {
            setConnectedUrl(initialUrl);
          }
          setInviteCode(c.invite_code ?? "");
          setPinSource(c.pin_source);
          return;
        }
        if (c.endpoint_url) {
          setUrl(c.endpoint_url);
          setConnectedUrl(c.endpoint_url);
        }
        setInviteCode(c.invite_code ?? "");
        setPinSource(c.pin_source);
      })
      .catch(() => {
        /* unconfigured — leave the field empty */
      });
  }, []);

  const connect = () => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setMsg(null);
    setPinSource(null);
    void invoke<{
      pin_source: PinSource;
    }>("plugin:sync|sync_set_endpoint", {
      endpointUrl: trimmed,
      inviteCode: inviteCode.trim(),
    })
      .then((r) => {
        setConnectedUrl(trimmed);
        setRevealCode(false);
        onConnected?.();
        setPinSource(r.pin_source);
        // The Tor posture is endpoint-aware (MYND-650 task 8): repointing a
        // loopback endpoint at a remote server — or the reverse — moves
        // `exempt`, and `exempt` sits on the slow poll because the toggle used
        // to be the only thing that could move it. Without this the Network
        // panel keeps saying "this address points at this device", with the
        // fail-closed banner suppressed, over the server that just replaced it.
        refreshTorState();
        // A browser and native clients both report TLS trust rather than a pin.
        setMsg(
          t(
            r.pin_source === "platform_trust_store"
              ? "sync.endpoint.connectedPlatformTrust"
              : "sync.endpoint.connectedLocal",
          ),
        );
      })
      .catch((e: unknown) => {
        setMsg(t((e as { kind?: string } | null)?.kind === "TlsFailure"
          ? "sync.endpoint.tlsFailure"
          : "sync.endpoint.unreachable"));
      })
      .finally(() => setBusy(false));
  };

  // "Connected & unedited": the input still matches the endpoint in use, so the
  // button rests as a disabled "Connected". Editing it (or having nothing
  // connected yet) re-enables "Connect".
  const trimmedUrl = url.trim();
  const isConnectedUnedited =
    connectedUrl !== null &&
    trimmedUrl.length > 0 &&
    trimmedUrl === connectedUrl;
  // The invite field shows while unconnected, OR when the user asked to
  // re-enter it on the locked hosted door (myne-md/myne#822). On that door the
  // address is read-only and the code is the ONLY thing that can be wrong, so
  // without this a wrong/rotated code is uncorrectable.
  const showInviteField = !isConnectedUnedited || revealCode;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
      data-testid="sync.endpoint-config"
    >
      {pinSource && (
        <div style={NOTE_BLOCK} data-testid="sync.pin-note">
          <span
            aria-hidden="true"
            style={{ display: "flex", flexShrink: 0, color: "var(--accent)", marginTop: 1 }}
          >
            <Icon name="info" size={16} />
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
              minWidth: 0,
            }}
          >
            <span data-testid="sync.pin-source" data-pin-source={pinSource}>
              {t("sync.endpoint.pinPlatformTrust")}
            </span>
          </div>
        </div>
      )}
      <div style={ROW}>
        <Input
          value={url}
          readOnly={lockedUrl}
          onChange={(e) => {
            setUrl(e.target.value);
            // Changing the address invalidates a code issued for the old server;
            // clearing it here keeps it from being sent to the new one.
            setInviteCode("");
            onEdit?.();
          }}
          placeholder={t("sync.endpoint.placeholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          style={lockedUrl ? { ...FIELD_FILL, color: "var(--fg-3)" } : FIELD_FILL}
          data-testid="sync.endpoint-input"
        />
        {isConnectedUnedited && !revealCode ? (
          <Button variant="secondary" disabled data-testid="sync.endpoint-connect">
            {t("sync.endpoint.connected")}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={connect}
            disabled={busy}
            data-testid="sync.endpoint-connect"
          >
            {busy ? t("sync.endpoint.connecting") : t("sync.endpoint.connect")}
          </Button>
        )}
      </div>
      {/* The invite code for a gated server (myne-md/myne#800). Optional: an
          open server ignores it, and a self-host operator never sets one. It
          sits under the address because it is part of "which server, and what
          does it ask for", not a separate setting.

          Hidden once the server is connected (myne-md/myne#815): the code is
          only for admission, so asking for it again on an already-connected
          endpoint reads as if it were still required. The value stays hydrated
          from `sync_get_endpoint`, and on the self-hosted door editing the
          address clears it and re-reveals the field (a code issued for the old
          server must not go to the new one). On the LOCKED hosted door the
          address is read-only, so that path cannot fire; there the "Change
          invite code" control below re-reveals the field instead
          (myne-md/myne#822). It is NOT true that the code is still sent on a
          reconnect: every reconnect requires an address change (or a deliberate
          re-entry here), and both re-send whatever is in the field. */}
      {showInviteField && (
        <>
          <label
            style={{ ...HELP, marginTop: "var(--space-1)" }}
            htmlFor="sync-endpoint-invite"
          >
            {t("sync.endpoint.inviteLabel")}
          </label>
          <div style={ROW}>
            <Input
              id="sync-endpoint-invite"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value);
                onEdit?.();
              }}
              placeholder={t("sync.endpoint.invitePlaceholder")}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              style={FIELD_FILL}
              data-testid="sync.endpoint-invite-input"
            />
          </div>
        </>
      )}
      {/* The locked hosted door has no way to re-reveal the invite field by
          editing the read-only address, so it gets an explicit control
          (myne-md/myne#822). Hidden on the self-hosted door, where editing the
          address already re-reveals the field. */}
      {lockedUrl && isConnectedUnedited && !revealCode && (
        <Button
          variant="ghost"
          onClick={() => setRevealCode(true)}
          style={{ alignSelf: "flex-start" }}
          data-testid="sync.endpoint-change-invite"
        >
          {t("sync.endpoint.changeInviteCode")}
        </Button>
      )}
      {/* The instructional helper sits directly under the input (E4a). */}
      <p style={HELP} data-testid="sync.endpoint-help">
        {t("sync.endpoint.tlsHelp")}
      </p>
      {msg && (
        <p style={HELP} data-testid="sync.endpoint-msg">
          {msg}
        </p>
      )}
    </div>
  );
}
