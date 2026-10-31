// Hide vault names on the lock screen: the mobile Privacy row (myne-md/myne#411).
//
// A **block inside an existing panel**, not a rail entry of its own: the same
// route `ReminderSwitchBlock` took, and for the same reason. It sits under
// Privacy directly after screen-capture protection, because the two answer one
// question: what can somebody holding this phone see before it is unlocked.
//
// The picker renders before any vault is open, so the names it shows come from a
// device-local sealed cache (`MYL1`, `protocol.md` § 9.22) rather than from
// `vault.prefs`. This switch destroys that cache and stops it being refilled.
//
// ── Not gated by Developer mode, deliberately ──────────────────────────────
//
// `developer_mode` is a `vault.prefs` field and therefore per vault, while the
// picker is device-wide: gating on it would need a rule about which vault's
// preference governs a shared screen. And cryptographic erase cannot reach a
// snapshot taken earlier, so the person for whom this option is fully honest is
// the one who sets it BEFORE a first unlock ever writes a name. A control behind
// Developer mode cannot be found by that person.
//
// ── One sentence on the row, the rest one tap away ─────────────────────────
//
// The destructive sentence stays ON the row, beside the switch that does it. The
// three explanatory paragraphs used to sit under the row as three grey
// paragraphs, which on a phone is most of a screen spent on prose above the next
// setting (myne-md/myne#960); they now open in a sheet through `InfoNote`, the
// same disclosure the desktop keeps behind its question mark since #885.
//
// What must not change with the shape: the COPY. It is the same three sentences
// the desktop shows, from the same locale keys, so the two clients cannot come to
// disagree about what is private, and `mobile/tests/hide-vault-names.test.ts`
// holds the key sets equal. Bounded by `docs/threat-model.md` § 7 and
// `docs/decisions/security/0491-…`.
//
// ── `unavailable` is a live state here, not an exotic one ──────────────────
//
// `myne_core::vault_label::key::platform_keychain` has an Apple backend and
// returns `UnavailableKeychain` on every other target, so **every Android
// device** is in that state until a Keystore provider is wired behind the
// `myne-core` seam (the shape `share_import` already uses for `MYF1`). The row
// says so rather than sitting inert. What must never happen instead is a
// plaintext fallback: it would look identical on screen while voiding the erase
// guarantee (`decisions.md` 2026-08-15).
//
// The switch stays INTERACTIVE in that state on purpose. Turning the option OFF
// touches no keychain, which is exactly what lets it succeed on a device that
// has none, so a disabled control would strand a user whose keychain disappeared
// after they turned it on.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  hideNamesWriteNotice,
  hideVaultNamesErrorKind,
  readHideVaultNames,
  readKeychainStatus,
  setHideVaultNames,
  type HideNamesNotice,
  type KeychainStatus,
} from "../lib/vault-label";
import { Switch } from "./inputs";
import { InfoNote } from "./InfoNote";

const rowLabel: CSSProperties = { fontSize: "var(--text-md)", color: "var(--fg-1)" };

const helper: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
  margin: "var(--space-2) var(--space-1) 0",
};

/** Holds the info trigger under the row, on the same left edge as the subtitle. */
const INFO_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  margin: "var(--space-1) var(--space-4) 0",
};

/** The row's own subtitle, tighter than the block-level helper below it. */
const subtitle: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
  marginTop: "var(--space-1)",
};

function Group({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-3)",
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      {children}
    </div>
  );
}

export type HideVaultNamesBlockProps = {
  /** Injected in tests so the two reads can be awaited deterministically. */
  onResolved?: (state: { hidden: boolean; keychain: KeychainStatus }) => void;
};

export function HideVaultNamesBlock({ onResolved }: HideVaultNamesBlockProps): ReactNode {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(false);
  const [keychain, setKeychain] = useState<KeychainStatus>("unknown");
  const [notice, setNotice] = useState<HideNamesNotice | null>(null);
  const [busy, setBusy] = useState(false);

  // The mount reads and a toggle's write are UNORDERED, and `alive` does not
  // order them: it only says the block is still mounted. A mount read that
  // resolves after a write has landed would call `setHidden` with the value from
  // before the write and flip the switch back on its own, and would report that
  // stale pair through `onResolved` as well. That misreports whether a
  // destructive erase took effect, which is the one thing this row exists to say
  // honestly. Once a write has started the mount reads describe a state that no
  // longer exists, so they are dropped.
  const writeStartedRef = useRef(false);

  // Two independent questions, asked independently: whether names are hidden,
  // and whether this device could store one at all. They fail apart, since names can
  // be hidden on a phone with a keychain and shown on one without.
  useEffect(() => {
    let alive = true;
    let flag = false;
    let status: KeychainStatus = "unknown";
    let settled = 0;
    const superseded = () => !alive || writeStartedRef.current;
    const settle = () => {
      if (++settled === 2 && !superseded()) onResolved?.({ hidden: flag, keychain: status });
    };

    void readHideVaultNames()
      .then((next) => {
        if (superseded()) return;
        flag = next;
        setHidden(next);
      })
      .catch(() => {
        // Do not assert a position we could not read.
        if (!superseded()) setNotice("read");
      })
      .finally(settle);

    // A rejection resolves to "unknown" inside `readKeychainStatus`, never to
    // "unavailable": the unavailable case arrives as a value, so a rejection
    // means the question went unanswered.
    void readKeychainStatus()
      .then((next) => {
        if (superseded()) return;
        status = next;
        setKeychain(next);
      })
      .finally(settle);

    return () => {
      alive = false;
    };
    // Mount-only: both reads are device state, not props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (next: boolean): Promise<void> => {
    writeStartedRef.current = true;
    setNotice(null);
    setBusy(true);
    try {
      setHidden(await setHideVaultNames(next));
    } catch (e) {
      const kind = hideVaultNamesErrorKind(e);
      setNotice(hideNamesWriteNotice(kind));
      // This one IS authoritative: the backend answered the question, it just
      // answered through the error channel because the write could not proceed.
      // Nothing here writes a name as a consolation.
      if (kind === "KeychainUnavailable") setKeychain("unavailable");
      // Re-read rather than guess where the switch should land. The erase runs
      // BEFORE the flag is persisted, so a failed write leaves the flag wherever
      // it already was while the keys may already be gone.
      await readHideVaultNames()
        .then(setHidden)
        .catch(() => {
          /* the notice already says the attempt failed */
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group>
        <div
          data-testid="settings.hide-vault-names"
          data-hidden={String(hidden)}
          data-keychain={keychain}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
            padding: "var(--space-3) var(--space-4)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={rowLabel}>{t("settings.privacy.hideVaultNamesLabel")}</div>
            {/* The critical sentence, and only it, on the row (myne-md/myne#885).
                Desktop split this row's 776 characters across four paragraphs:
                the destructive sentence stays beside the switch and the detail
                moves behind the question mark. Mobile has no disclosure
                primitive, so the same keys render as paragraphs below the row
                rather than collapsed; the COPY is byte-identical, which is what
                `tests/hide-vault-names.test.ts` pins across the two clients. */}
            <div style={subtitle}>{t("settings.privacy.hideVaultNamesInline")}</div>
          </div>
          {/* `disabled` while the erase runs, NOT a dropped `onToggle`.
              Mobile's Switch renders `role="switch"` and `aria-checked` only
              when it has a handler, so withholding the handler took the
              control's role and its state away from assistive technology for
              the duration, and left it at full opacity looking live while it
              ignored taps. The operation destroys per-vault keys across every
              vault on the device, so that window is not instantaneous.
              Desktop's Switch reads the same idiom correctly; this is what
              keeps the two clients from diverging on it. */}
          <Switch
            on={hidden}
            onToggle={() => void toggle(!hidden)}
            disabled={busy}
          />
        </div>
      </Group>

      <div style={INFO_ROW_STYLE}>
        <InfoNote
          testId="settings.hide-vault-names"
          paragraphs={[
            t("settings.privacy.hideVaultNamesHelper"),
            t("settings.privacy.hideVaultNamesErases"),
            t("settings.privacy.hideVaultNamesResidue"),
          ]}
        />
      </div>

      {keychain === "unavailable" && (
        <p style={helper} data-testid="settings.hide-vault-names-unavailable">
          {t("settings.privacy.hideVaultNamesUnavailable")}
        </p>
      )}

      {notice !== null && (
        <p style={helper} role="status" data-testid="settings.hide-vault-names-notice">
          {notice === "read" && t("settings.privacy.hideVaultNamesErrorRead")}
          {notice === "save" && t("settings.privacy.hideVaultNamesErrorSave")}
          {notice === "erase" && t("settings.privacy.hideVaultNamesErrorErase")}
        </p>
      )}
    </>
  );
}
