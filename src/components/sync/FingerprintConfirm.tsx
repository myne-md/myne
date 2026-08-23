// The out-of-band certificate-fingerprint gate, shared by both enrollment doors
// (MYND-650 task 9). Rendered by `EndpointConfig` and `JoinDeviceModal` when the
// backend refuses a TOFU pin for want of a confirmation.
//
// # What the user is being asked to do, and why it is phrased this way
//
// With Tor routing on, the enrollment handshake — the ONE handshake this client
// accepts any certificate on, because there is no pin yet — travels through an
// exit node. An exit is an arbitrary volunteer relay that terminates the circuit
// and sees the destination in the clear, so a first-connect MitM is not an
// exotic capability there: it is the position an exit occupies. The backend
// therefore refuses to accept a pin in Tor mode until the user supplies the
// fingerprint they obtained out-of-band, and compares it before trusting
// anything (`core/src/plugins/sync/pin_confirm.rs`).
//
// # The captured fingerprint is NEVER on this screen
//
// Task 5's primitive-level review changed this surface from the obvious design
// ("here is the fingerprint we captured — does it match yours?") to an input,
// and that inversion is the whole security value:
//
//  - showing the captured value first presents the ATTACKER's proposal and asks
//    a human to diff 64 hex characters against a memory, which is the anchoring
//    failure fingerprint-compare studies find repeatedly;
//  - offering it on the mismatch path would hand a user who cannot find their
//    real fingerprint a value to paste back, turning the gate into a speed bump.
//
// So the backend returns nothing on either refusal, and this component has no
// prop through which a captured value could arrive. The only fingerprint it
// renders is the one the user typed, echoed back in grouped hex so the compare
// against their own record is actually feasible on screen.
//
// # Bounds on the copy
//
// It may not claim the pin is verified cryptography. It is a human check with a
// machine comparison — one step above `docs/self-host-policy.md` §6's status
// quo and no more. It also has to state the thing a user is most likely to get
// wrong: a fingerprint fetched over this same circuit confirms nothing, because
// whatever can swap the certificate can swap that page too. And it must name
// the honest way out for a user who has no fingerprint at all (turn Tor routing
// off and connect directly, at the cost of showing their IP address) rather
// than leaving them stuck at a wall with no door.
//
// Built against design tokens; no Penpot frame (unattended run — see the
// feature's progress.md "Design state").

import { useId, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";

/** A SHA-256 fingerprint, as hex characters. */
const FINGERPRINT_HEX_LEN = 64;
/** Characters per group in the echo. 64 / 4 = 16 groups. */
const GROUP_LEN = 4;

/** What the user has typed so far, read the way the backend reads it. */
export interface FingerprintReading {
  /** The hex characters, lowercased, separators dropped. */
  hex: string;
  /** True once a character that is neither hex nor a separator appeared. */
  hasJunk: boolean;
  /** 64 hex characters and nothing else — the only state Confirm is live in. */
  complete: boolean;
}

/**
 * Read a typed fingerprint the way `pin_confirm::normalize_fingerprint` does.
 *
 * Operators copy fingerprints out of tools that format them differently —
 * `openssl` emits `AB:CD:…`, dashboards use spaces, people paste a `sha256:`
 * prefix — so the same separators and the same prefix are tolerated here, and
 * the same alphabet is enforced. This is a **hand-mirror** of the Rust
 * function: it exists to tell the user "that is not 64 hex characters" while
 * they type, not to decide anything. The backend still normalizes and compares,
 * and a disagreement between the two shows up as a refusal, never as a pin
 * accepted on this side's say-so.
 */
export function readFingerprintInput(raw: string): FingerprintReading {
  const trimmed = raw.trim();
  const body =
    trimmed.startsWith("sha256:") || trimmed.startsWith("SHA256:")
      ? trimmed.slice("sha256:".length)
      : trimmed;
  let hex = "";
  let hasJunk = false;
  for (const ch of body) {
    if (":- \t\n\r".includes(ch)) continue;
    if (/[0-9a-fA-F]/.test(ch)) hex += ch.toLowerCase();
    else hasJunk = true;
  }
  return {
    hex,
    hasJunk,
    complete: !hasJunk && hex.length === FINGERPRINT_HEX_LEN,
  };
}

/**
 * The two backend refusals that open this gate, as their shared `kind` tags.
 *
 * `SyncConfigError` and `SyncDeviceError` are different enums, but these two
 * variants mean the same thing on both and carry the same contract: **nothing
 * was written** — no endpoint, no pin, no vault container — so the screen stays
 * where it is with the field revealed, and declining costs nothing to undo.
 */
export type FingerprintGateRefusal =
  | "PinConfirmationRequired"
  | "FingerprintMismatch"
  /**
   * The endpoint is already trusted and the server presented a different
   * certificate (myne#581). Reaches the gate for the same reason the other two
   * do — nothing was written, and the way forward is a fingerprint the user
   * obtained out of band — but it arises at RE-connect rather than at
   * enrollment, which is why it exists at all: before it, re-entering the URL
   * silently replaced the pin with whatever answered.
   */
  | "CertificateChanged";

/**
 * Does this rejection mean "the gate wants a fingerprint", and which one?
 *
 * One classifier for both enrollment doors (`EndpointConfig`, `JoinDeviceModal`)
 * so the rule about which refusals reveal the gate has one home. Two independent
 * `kind ===` chains had already drifted on type-safety within the change that
 * added them, and a third door — or a third refusal — would have to find every
 * copy.
 */
export function fingerprintGateRefusal(e: unknown): FingerprintGateRefusal | null {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return kind === "PinConfirmationRequired" ||
    kind === "FingerprintMismatch" ||
    kind === "CertificateChanged"
    ? kind
    : null;
}

/** Split hex into fixed-width groups for the eye-compare. */
export function groupFingerprint(hex: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += GROUP_LEN) {
    groups.push(hex.slice(i, i + GROUP_LEN));
  }
  return groups;
}

const GATE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
};

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const BODY: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const NOTE: CSSProperties = { ...BODY, color: "var(--fg-3)" };

const FIELD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: "var(--weight-semibold)",
};

const ECHO_GROUPS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  letterSpacing: "0.04em",
  color: "var(--fg-1)",
};

const DISCLOSURE_BUTTON: CSSProperties = {
  alignSelf: "flex-start",
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--fg-2)",
  font: "inherit",
  fontSize: "var(--text-sm)",
  textDecoration: "underline",
  cursor: "pointer",
  transition: "color var(--duration-fast) var(--ease-standard)",
};

const HELP_LIST: CSSProperties = {
  ...NOTE,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  paddingInlineStart: "var(--space-4)",
};

const ACTIONS: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
  flexWrap: "wrap",
};

export interface FingerprintConfirmProps {
  /** The raw text the user has typed. Owned by the host, which sends it back. */
  value: string;
  onChange: (next: string) => void;
  /** Retry the enrollment with the typed fingerprint. */
  onConfirm: () => void;
  /** Abort. Nothing was written by the refused attempt, so this just backs out. */
  onDecline: () => void;
  /** The host's own verb for the retry — "Connect", "Add device". */
  confirmLabel: string;
  /** Host-side reasons the retry cannot run yet (in flight, form incomplete). */
  confirmDisabled?: boolean;
  /** Testid prefix: `sync` for the endpoint screen, `join` for the modal. */
  testIdPrefix: string;
}

export function FingerprintConfirm({
  value,
  onChange,
  onConfirm,
  onDecline,
  confirmLabel,
  confirmDisabled = false,
  testIdPrefix,
}: FingerprintConfirmProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const [helpOpen, setHelpOpen] = useState(false);

  const reading = readFingerprintInput(value);
  const typed = value.trim().length > 0;
  // Confirm stays inert until the input IS a fingerprint. The backend answers a
  // malformed value with the same `FingerprintMismatch` it answers a genuinely
  // different certificate with — deliberately, because from there the two are
  // indistinguishable — and that message says "something is between this device
  // and your server". Letting a half-pasted value produce it would spend the
  // alarm on a typo, which is how an alarm stops meaning anything.
  const canConfirm = reading.complete && !confirmDisabled;

  return (
    <section
      style={GATE}
      aria-labelledby={`${baseId}-title`}
      data-testid={`${testIdPrefix}.fingerprint-gate`}
    >
      <h3 id={`${baseId}-title`} style={TITLE}>
        {t("sync.fingerprint.title")}
      </h3>
      <p style={BODY}>{t("sync.fingerprint.why")}</p>

      <div style={FIELD}>
        <label style={LABEL} htmlFor={`${baseId}-input`}>
          {t("sync.fingerprint.label")}
        </label>
        {/* `mono`, and the shared primitive: the focus ring is where a user
            reading 64 hex characters finds their place again, and a hand-rolled
            input would be the one field on this screen without one. */}
        <Input
          mono
          id={`${baseId}-input`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("sync.fingerprint.placeholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          data-testid={`${testIdPrefix}.expected-fingerprint-input`}
        />
      </div>

      {/* The echo is the "shown legibly" half of the compare: the user's own
          value, grouped, so it can be read against their record without
          counting characters. It is derived from the input and from nothing
          else — there is no captured fingerprint in this component to leak. */}
      {typed && (
        <div
          style={FIELD}
          aria-live="polite"
          data-testid={`${testIdPrefix}.fingerprint-echo`}
          data-complete={String(reading.complete)}
        >
          <span style={LABEL}>{t("sync.fingerprint.echoLabel")}</span>
          <span style={ECHO_GROUPS}>
            {groupFingerprint(reading.hex).map((group, i) => (
              <span key={i}>{group}</span>
            ))}
          </span>
          <span style={NOTE} data-testid={`${testIdPrefix}.fingerprint-echo-note`}>
            {reading.hasJunk
              ? t("sync.fingerprint.echoInvalid")
              : reading.complete
                ? t("sync.fingerprint.echoComplete")
                : t("sync.fingerprint.echoProgress", {
                    count: reading.hex.length,
                    total: FINGERPRINT_HEX_LEN,
                  })}
          </span>
        </div>
      )}

      {/* Left as a bare button: the shared `Button` primitive has no
          text-link variant, and the panel-level disclosures elsewhere in
          Settings are styled the same way. */}
      <button
        type="button"
        onClick={() => setHelpOpen((open) => !open)}
        aria-expanded={helpOpen}
        aria-controls={`${baseId}-help`}
        style={DISCLOSURE_BUTTON}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--fg-1)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--fg-2)";
        }}
        data-testid={`${testIdPrefix}.fingerprint-help-toggle`}
      >
        {t("sync.fingerprint.helpToggle")}
      </button>
      {helpOpen && (
        <ul
          id={`${baseId}-help`}
          style={HELP_LIST}
          data-testid={`${testIdPrefix}.fingerprint-help`}
        >
          <li>{t("sync.fingerprint.helpNotOverTor")}</li>
          <li>{t("sync.fingerprint.helpFromServer")}</li>
          <li>{t("sync.fingerprint.helpFromDevice")}</li>
          <li>{t("sync.fingerprint.helpNoFingerprint")}</li>
        </ul>
      )}

      <div style={ACTIONS}>
        <Button
          type="button"
          onClick={onDecline}
          data-testid={`${testIdPrefix}.fingerprint-decline`}
        >
          {t("sync.fingerprint.decline")}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onConfirm}
          disabled={!canConfirm}
          data-testid={`${testIdPrefix}.fingerprint-confirm`}
        >
          {confirmLabel}
        </Button>
      </div>
    </section>
  );
}
