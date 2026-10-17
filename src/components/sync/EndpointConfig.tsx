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
}: {
  onConnected?: () => void;
  onEdit?: () => void;
} = {}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
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
        if (c.endpoint_url) {
          setUrl(c.endpoint_url);
          setConnectedUrl(c.endpoint_url);
        }
        setInviteCode(c.invite_code ?? "");
        setPinSource(c.pin_source);
      })
      .catch(() => {
        /* unconfigured, leave the field empty */
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
  // The invite field shows while unconnected, and hides once the server has
  // accepted the address and the code with it. Editing the address clears the
  // code and re-reveals the field, which is the one path back to it.
  const showInviteField = !isConnectedUnedited;

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
          style={FIELD_FILL}
          data-testid="sync.endpoint-input"
        />
        {isConnectedUnedited ? (
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
          from `sync_get_endpoint`, and editing the address clears it and
          re-reveals the field, so a code issued for the old server never goes
          to the new one. It is NOT true that the code is still sent on a
          reconnect: every reconnect requires an address change, and that
          re-send carries whatever is in the field. */}
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
