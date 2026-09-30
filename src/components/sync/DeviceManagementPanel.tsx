// Device management panel (MYND-425 tasks 7 + 8) — the device list (friendly
// names + removal) + the approval gate entry (pending devices with approve).
// Penpot skipped per the owner directive; built against design tokens.
//
// Friendly names (MYND-548, closing the MYND-425 spec-delta follow-up): an
// approved row leads with its synced `device_names` entry and demotes the short
// device code to a secondary line; a device nobody has named keeps the old
// id-derived label. Pending rows deliberately keep ONLY that id-derived label —
// see the SAS note below.
//
// Approve-then-verify SAS (MYND-459 T14, SYNC-40): approving a pending device
// surfaces THIS device's adopted-head fingerprint (`sync_head_fingerprint` →
// the frozen 8-char Crockford `XXXX-XXXX`, protocol::head_fingerprint verbatim,
// ONE encoding — SYNC-17) for an out-of-band eye-compare against the newcomer's
// screen. A match confirms the newcomer is on the genuine account; a mismatch
// routes straight to Remove device. This is the desktop end of the same SAS the
// mobile SY-05 shows (SYNC-40 carries both ends in 459). Ship-gate: the SYNC-17
// primitive-level review of the fingerprint substrate is recorded, not passed.

import { useState, type CSSProperties } from "react";
import {
  REMOVE_DEVICE_CONFIRM,
  REMOVE_DEVICE_DISCLOSURE,
} from "../../lib/load-bearing-copy";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { type DeviceEntry, type DevicesHook } from "../../hooks/useDevices";
import { usePrefs } from "../../hooks/usePrefs";
import { useHeadFingerprintCompare } from "../../hooks/useHeadFingerprintCompare";
import { setDeviceName } from "../../lib/prefs";
import { DEVICE_NAME_MAX_LEN } from "../../lib/device-name";
import { hoverSurface, HOVER_TRANSITION } from "../primitives/hoverSurface";
import { Icon } from "../primitives/Icon";
import { Tooltip } from "../primitives/Tooltip";
import { EmptyState } from "../primitives/EmptyState";

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

// A section (label + its rows) and the row stack inside it both lay out as a
// gapped column, so device rows breathe apart instead of butting their borders
// together (E3a).
const SECTION: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const CONFIRM_BOX: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  flexBasis: "100%",
  marginTop: "var(--space-2)",
  padding: "var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2, 6px)",
  background: "var(--bg-2)",
  fontSize: "var(--text-sm)",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  // The remove-confirmation is rendered as a `flexBasis: 100%` child of this
  // row; without `flex-wrap` it cannot drop to its own line and instead gets
  // squeezed in beside the name + actions, overflowing and colliding with the
  // row (MYND-425 / #204). Wrapping lets it settle on a full-width line beneath
  // the row content. Rows with no confirmation open are unaffected (two children
  // that already fit on one line).
  flexWrap: "wrap",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const SECTION_LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
};

const BTN: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  color: "var(--fg-1)",
  transition: HOVER_TRANSITION,
};

/** Shared hover for the panel's `BTN`-based rows/actions: resting `--bg-2` deepens
 *  one step to `--paper-3`. Pass the same `disabled` the button carries so a
 *  dimmed control never lights up. */
const btnHover = (disabled = false) =>
  hoverSurface({ restBg: "var(--bg-2)", hoverBg: "var(--paper-3)", disabled });

// "This device" reads as an accent-soft pill with accent text (E3b) — a quiet
// self-marker, distinct from a plain outlined chip.
const BADGE: CSSProperties = {
  marginInlineStart: "var(--space-2)",
  padding: "0 var(--space-1)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--accent)",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent-soft)",
  borderRadius: "var(--radius-1)",
  whiteSpace: "nowrap",
};

// Icon-only row actions (Rename / Remove, E3d): a 28px square with the panel's
// resting fill so the two sit as one consistent pair.
const ICON_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  color: "var(--fg-2)",
  transition: HOVER_TRANSITION,
};

// Remove's icon turns danger on hover (background still deepens, E3c), so the
// button also transitions colour — HOVER_TRANSITION only covers background.
const ICON_BTN_DANGER_TRANSITION: CSSProperties["transition"] =
  "background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)";

/** The short, id-derived label — the fallback for a device nobody has named, and
 *  the ONLY label a pending device ever gets (SYNC-40: a name chosen by an
 *  unverified newcomer would read as a trust signal next to the SAS). */
function shortName(d: DeviceEntry): string {
  return i18n.t("sync.devices.shortName", { hex: d.device_id_hex.slice(0, 6) });
}

/** The label an APPROVED row leads with: the synced `device_names` entry when the
 *  user has named this device, else {@link shortName}. A whitespace-only stored
 *  value is treated as absent — the Rust setter refuses to write one, so this is
 *  belt-and-braces against a hand-edited or foreign-client blob. */
function displayName(d: DeviceEntry, names: Record<string, string>): string {
  const stored = names[d.device_id_hex];
  return stored !== undefined && stored.trim() !== "" ? stored : shortName(d);
}

/** The demoted device code. Kept as a permanent secondary line rather than a
 *  hover affordance: mobile has no hover, and this is what disambiguates two
 *  devices that share a default name ("Mac" / "Mac"). */
const CODE_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const NAME_LINE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
};

const IDENTITY_COLUMN: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const ACTIONS: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

const RENAME_INPUT: CSSProperties = {
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "2px var(--space-1)",
  minWidth: 0,
  width: "100%",
};

// Takes the `useDevices` hook result as a prop (lifted to `SyncPanel`) so the
// roster poll runs once for both the device list AND the "Add a device" enroll
// gate above it — a single source of enrollment truth, no double-polling.
/** The device in the approve-then-verify SAS step (SYNC-40). */
interface SasState {
  deviceId: string;
}

/**
 * A readable reason for the "couldn't reach sync" line, keyed by the backend's
 * serde `kind`.
 *
 * That line used to interpolate the `kind` itself, so a bare English enum name
 * — `Transport` — appeared inside translated user copy, in all 32 locales. It
 * told the reader nothing and it was the string a four-day sync outage was
 * reported under. Unknown kinds fall through to a neutral phrase rather than
 * leaking the identifier, so a variant added on the Rust side degrades to vague
 * instead of to jargon.
 */
function deviceErrorReason(kind: string): string {
  switch (kind) {
    case "Transport":
      return "sync.devices.reasonUnreachable";
    case "CertPinMismatch":
      return "sync.devices.reasonCertChanged";
    case "Unauthenticated":
      return "sync.devices.reasonRejected";
    case "AccountFrozen":
      return "sync.devices.reasonFrozen";
    case "DeviceLimitReached":
      return "sync.devices.reasonDeviceLimit";
    case "AwaitingApproval":
      return "sync.devices.reasonAwaitingApproval";
    case "NotConfigured":
      return "sync.devices.reasonNotConfigured";
    default:
      return "sync.devices.reasonUnexpected";
  }
}

export function DeviceManagementPanel({ hook }: { hook: DevicesHook }) {
  const { t } = useTranslation();
  const { devices, pending, error, busy, approve, remove, resetLocal } = hook;
  // The synced `device_names` map (MYND-548). Read off the shared prefs hook like
  // every other prefs consumer — `setDeviceName` bumps the prefs nonce, so a local
  // rename and a peer's merged rename both land here the same way.
  const { prefs } = usePrefs();
  // `?? {}` is not defensive noise: a client can outrun its own backend (mobile
  // ships ahead of core), and a payload without the key must degrade to the
  // id-derived labels rather than take the panel down.
  const names = prefs.device_names ?? {};

  // The row currently being renamed, plus its in-flight input value. `null` = no
  // row is in rename mode. One at a time: the Rename buttons disable while any
  // row is open, so a stray click cannot strand a half-typed edit.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [renameFailed, setRenameFailed] = useState(false);

  // Enter and blur both land here. Closing the editor FIRST makes the two paths
  // idempotent — blur fires right after Enter, and the second call sees `null`
  // and returns. A blank value is a cancel (the backend refuses it too), so the
  // previous name survives; only a genuine write failure surfaces. Deliberately
  // NOT optimistic: the row renders straight off `names`, so a failed write simply
  // never changed it — which IS the revert, with no rollback path to desync.
  const commitRename = async () => {
    const target = renaming;
    if (target === null) return;
    setRenaming(null);
    if (target.value.trim() === "") return;
    try {
      await setDeviceName(target.id, target.value.trim());
      setRenameFailed(false);
    } catch {
      setRenameFailed(true);
    }
  };
  const approved = (devices ?? []).filter((d) => d.approved && !d.retired);
  // This device, if the roster came back marking it retired — it was removed from
  // another device. It is filtered out of `approved`/`pending`, so without this it
  // would vanish silently; surface it with the reset+re-add recovery instead.
  const retiredSelf = (devices ?? []).find((d) => d.is_current && d.retired);

  const [sas, setSas] = useState<SasState | null>(null);
  // The device id whose removal is awaiting confirmation, or `null`. One at a
  // time: a second Remove click replaces the open disclosure rather than
  // stacking two.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Approve-then-verify (SYNC-40): approve FIRST, then fetch this device's
  // adopted-head fingerprint for the out-of-band eye-compare against the newcomer.
  const approveAndVerify = async (deviceId: string) => {
    // Only surface the SAS eye-compare once approval actually succeeded. If the
    // backend `sync_approve_device` failed, `approve` returns false (and set the
    // error banner) — stay on the device list rather than showing a verify
    // screen for a device that was never approved.
    if (!(await approve(deviceId))) return;
    setSas({ deviceId });
  };

  // #243 made this side KEEP LOOKING; myne#462 made it keep looking for the
  // right thing.
  //
  // Before #243 this was one `sync_head_fingerprint` call inside
  // `approveAndVerify`, and `None` — the honest answer while no head is adopted
  // — left the panel saying "this code appears once the new device finishes its
  // first sync" forever. #243 added a poll. But that poll stopped at the first
  // non-null answer, and on THIS side the first answer arrives before the
  // device has pulled anything, so the panel latched a pre-sync head and then
  // sat on it while the ceremony moved the vault head underneath.
  //
  // Both halves now live in `useHeadFingerprintCompare`, shared with the two
  // joining screens so the copies cannot drift apart again — which is how the
  // mobile approving side kept the pre-#243 shape long after this one was fixed.
  const { fingerprint, syncing, changed, acknowledgeChange } = useHeadFingerprintCompare(
    sas !== null,
    "approver",
  );

  // SY-05 desktop end: the SAS eye-compare, shown right after an approve. Renders
  // the frozen Crockford `XXXX-XXXX` (SYNC-17: one encoding, no word-list) for the
  // user to compare against the new device; a mismatch routes to Remove device.
  if (sas) {
    return (
      <div style={ROOT} data-testid="sync.approve-verify">
        <div style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"], color: "var(--fg-1)" }}>
          {t("sync.devices.verifyTitle")}
        </div>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", margin: 0, lineHeight: "var(--leading-normal)" }}>
          {t("sync.devices.verifyBody")}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "var(--space-4)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            background: "var(--bg-2)",
          }}
        >
          {syncing ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>{t("sync.devices.verifySyncing")}</span>
          ) : fingerprint ? (
            <span
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xl)", fontWeight: "var(--weight-bold)", letterSpacing: "0.14em", color: "var(--fg-1)" }}
              data-testid="sync.sas-fingerprint"
            >
              {fingerprint}
            </span>
          ) : (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", textAlign: "center" }} data-testid="sync.sas-pending">
              {t("sync.devices.verifyPending")}
            </span>
          )}
        </div>
        {/* The head moved while the compare was open — a third device pushed, or
            the hold lapsed. Say so rather than letting the code swap under the
            reader, and rather than letting the screen quietly re-converge: "keep
            looking until they agree" is not a comparison. */}
        {changed && (
          <p
            style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", margin: 0, lineHeight: "var(--leading-normal)" }}
            data-testid="sync.sas-changed"
          >
            {t("sync.devices.verifyChanged")}
          </p>
        )}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button type="button" style={BTN} {...btnHover()} onClick={() => setSas(null)} data-testid="sync.sas-match">
            {t("sync.devices.verifyMatch")}
          </button>
          <button
            type="button"
            style={{ ...BTN, color: "var(--danger)" }}
            {...btnHover(busy)}
            disabled={busy}
            onClick={() => {
              // myne#462: a mismatch is now known to be a timing artefact far
              // more often than an attack, so this no longer revokes on one
              // click. It routes into the SAME confirmation every other removal
              // on this panel goes through (`REMOVE_DEVICE_CONFIRM` +
              // `REMOVE_DEVICE_DISCLOSURE`) — which is what the mobile
              // counterpart already did, making desktop the outlier, and the
              // outlier in the destructive direction.
              const id = sas.deviceId;
              acknowledgeChange();
              setSas(null);
              setConfirmRemove(id);
            }}
            data-testid="sync.sas-mismatch"
          >
            {t("sync.devices.verifyMismatch")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={ROOT} data-testid="sync.device-management">
      {error === "NotEnrolled" ? (
        <div
          data-testid="sync.device-not-enrolled"
          style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}
        >
          {t("sync.devices.notEnrolled")}
        </div>
      ) : error ? (
        <div
          data-testid="sync.device-error"
          style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          <span>
            {error === "CertPinMismatch"
              ? t("sync.devices.certChanged")
              : t("sync.devices.unreachable", { error: t(deviceErrorReason(error)) })}
          </span>
          {error === "Unauthenticated" ||
          error === "AccountFrozen" ||
          error === "DeviceLimitReached" ||
          error === "AwaitingApproval" ? (
            // A rejected credential (e.g. this device was removed elsewhere) — a local
            // reset is the actual remedy.
            //
            // #269 widens the gate to the three refusals #268 stopped
            // flattening into `Unauthenticated`. They are not transport
            // failures, and for a device stuck awaiting an approval that will
            // never come — the account was wrong, or the approver is gone —
            // a local reset is the ONLY way back: the enrol-gate hides the
            // form while enrolment looks live.
            <button
              type="button"
              style={BTN}
              {...btnHover(busy)}
              disabled={busy}
              onClick={() => void resetLocal()}
              data-testid="sync.reset-local"
            >
              {t("sync.devices.resetSyncOnThisDevice")}
            </button>
          ) : (
            // A transport failure — NOT a reason to wipe the baseline. The likely cause
            // (server moved / certificate changed) is fixed by re-pinning the endpoint.
            //
            // Two hints, because one of them no longer has to guess: when the
            // backend says `CertPinMismatch` the cause is KNOWN, and the copy
            // says so and says what to do. The older hint stays for every other
            // transport failure, where "the server moved or its certificate
            // changed" really is a guess.
            <span
              style={{ color: "var(--fg-3)" }}
              data-testid={
                error === "CertPinMismatch" ? "sync.cert-changed-hint" : "sync.transport-hint"
              }
            >
              {t(
                error === "CertPinMismatch"
                  ? "sync.devices.certChangedHint"
                  : "sync.devices.transportHint",
              )}
            </span>
          )}
        </div>
      ) : retiredSelf ? (
        <div
          data-testid="sync.device-retired-self"
          style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          <span>{t("sync.devices.removedElsewhere")}</span>
          <button
            type="button"
            style={BTN}
            {...btnHover(busy)}
            disabled={busy}
            onClick={() => void resetLocal()}
            data-testid="sync.reset-local"
          >
            {t("sync.devices.resetAndReAdd")}
          </button>
        </div>
      ) : null}

      {pending.length > 0 && (
        <div data-testid="sync.pending-devices" style={SECTION}>
          <div style={SECTION_LABEL}>
            {t("sync.devices.awaitingApproval", { count: pending.length })}
          </div>
          <div style={SECTION}>
            {pending.map((d) => (
              <div key={d.device_id_hex} style={ROW} data-testid="sync.pending-row" data-device-id={d.device_id_hex}>
                <span>{shortName(d)}</span>
                <button
                  type="button"
                  style={BTN}
                  {...btnHover(busy)}
                  disabled={busy}
                  onClick={() => void approveAndVerify(d.device_id_hex)}
                  data-testid="sync.approve-device"
                >
                  {t("sync.devices.approve")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={SECTION}>
        <div style={SECTION_LABEL}>{t("sync.devices.yourDevices")}</div>
        {renameFailed && (
          <div
            style={{ color: "var(--danger)", fontSize: "var(--text-sm)", paddingBottom: "var(--space-1)" }}
            data-testid="sync.rename-error"
          >
            {t("sync.devices.renameFailed")}
          </div>
        )}
        {devices === null ? (
          // Only "Loading…" while genuinely loading. When the roster failed (e.g. this
          // device is not enrolled) `devices` stays null with an error set above — show
          // nothing here rather than spinning on "Loading…" forever.
          error ? null : (
            <div style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>{t("sync.devices.loading")}</div>
          )
        ) : approved.length === 0 ? (
          <EmptyState
            variant="firstRun"
            icon="hard-drive"
            size="sm"
            title={t("sync.devices.noDevices")}
            body={t("sync.devices.noDevicesBody")}
            testId="sync.devices-empty"
          />
        ) : (
          <div style={SECTION}>
          {approved.map((d) => (
            <div key={d.device_id_hex} style={ROW} data-testid="sync.device-row" data-device-id={d.device_id_hex} data-current={d.is_current ? "true" : "false"}>
              <span style={IDENTITY_COLUMN}>
                {renaming?.id === d.device_id_hex ? (
                  <input
                    // Focused on mount: the field replaces the line the user just
                    // activated, so focusing it IS the interaction.
                    autoFocus
                    value={renaming.value}
                    maxLength={DEVICE_NAME_MAX_LEN}
                    style={RENAME_INPUT}
                    aria-label={t("sync.devices.renameLabel")}
                    data-testid="sync.device-name-input"
                    onChange={(e) => setRenaming({ id: d.device_id_hex, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : (
                  <span style={NAME_LINE}>
                    <span data-testid="sync.device-name">{displayName(d, names)}</span>
                    {d.is_current && (
                      <span style={BADGE} data-testid="sync.this-device">
                        {t("sync.devices.thisDevice")}
                      </span>
                    )}
                  </span>
                )}
                <span style={CODE_LINE} data-testid="sync.device-code">
                  {d.device_id_hex.slice(0, 6)}
                </span>
              </span>
              <span style={ACTIONS}>
                {/* This device: "Synced here" reads first, THEN the rename pencil
                    (swapped per feedback). Other devices: rename then remove. */}
                {d.is_current && (
                  <span style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
                    {t("sync.devices.syncedHere")}
                  </span>
                )}
                {/* Rename is offered on EVERY approved row, not just this device:
                    devices enrolled before names existed are named from whatever
                    device the user happens to be holding. Icon-only (E3d): the
                    tooltip carries the label, `aria-label` the a11y name. */}
                <Tooltip label={t("sync.devices.rename")}>
                  <button
                    type="button"
                    style={{
                      ...ICON_BTN,
                      opacity: busy || renaming !== null ? 0.5 : 1,
                    }}
                    {...btnHover(busy || renaming !== null)}
                    disabled={busy || renaming !== null}
                    aria-label={t("sync.devices.rename")}
                    onClick={() =>
                      setRenaming({ id: d.device_id_hex, value: displayName(d, names) })
                    }
                    data-testid="sync.rename-device"
                  >
                    <Icon name="pencil" size={16} />
                  </button>
                </Tooltip>
                {/* #243: a way BACK into the verify screen. Approval happens
                    once, so before this the SAS compare was a dead end — dismiss
                    it (or leave it showing the pending text) and there was no
                    route back to the code for a device that was already
                    approved. The compare is worth doing whenever the user gets
                    round to it, not only in the seconds after they click
                    Approve. */}
                {!d.is_current && (
                  <Tooltip label={t("sync.devices.verifyAction")}>
                    <button
                      type="button"
                      style={{ ...ICON_BTN, opacity: busy ? 0.5 : 1 }}
                      {...btnHover(busy)}
                      disabled={busy}
                      aria-label={t("sync.devices.verifyAction")}
                      onClick={() =>
                        setSas({ deviceId: d.device_id_hex })
                      }
                      data-testid="sync.verify-device"
                    >
                      <Icon name="circle-check" size={16} />
                    </button>
                  </Tooltip>
                )}
                {!d.is_current && (
                  <Tooltip label={t("sync.devices.remove")}>
                    <button
                      type="button"
                      style={{
                        ...ICON_BTN,
                        transition: ICON_BTN_DANGER_TRANSITION,
                        opacity: busy ? 0.5 : 1,
                      }}
                      disabled={busy}
                      aria-label={t("sync.devices.remove")}
                      onMouseEnter={(e) => {
                        if (busy) return;
                        e.currentTarget.style.background = "var(--paper-3)";
                        e.currentTarget.style.color = "var(--danger)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "var(--bg-2)";
                        e.currentTarget.style.color = "var(--fg-2)";
                      }}
                      onClick={() => setConfirmRemove(d.device_id_hex)}
                      data-testid="sync.remove-device"
                    >
                      <Icon name="trash-2" size={16} />
                    </button>
                  </Tooltip>
                )}
              </span>
              {confirmRemove === d.device_id_hex && (
                // The honest-disclosure step (MYND-574 task 69). `@myne/copy`
                // has carried `REMOVE_DEVICE_CONFIRM` +
                // `REMOVE_DEVICE_DISCLOSURE` since MYND-425 and **nothing
                // rendered them** — the literals were single-sourced, pinned by
                // a test, and dead. So removal was one unconfirmed click that
                // said nothing about what it does.
                //
                // Both sentences are shown together, never collapsed: the
                // effect (sync stops) is the part a user wants, and the limit
                // (a device that already has the vault and the password keeps
                // it — this is not a remote wipe) is the part they must not be
                // allowed to assume. `decisions.md` 2026-06-27 makes the wording
                // itself a decision, not copy.
                //
                // Rendered by the SHARED component, which is what makes
                // "identical to desktop" true by construction rather than by
                // review — there is one implementation and both clients mount it.
                <div style={CONFIRM_BOX} data-testid="sync.remove-confirm">
                  <span style={{ fontWeight: "var(--weight-semibold)" }}>{REMOVE_DEVICE_CONFIRM}</span>
                  <span style={{ color: "var(--fg-2)" }} data-testid="sync.remove-disclosure">
                    {REMOVE_DEVICE_DISCLOSURE}
                  </span>
                  <span style={{ display: "flex", gap: "var(--space-2)" }}>
                    <button
                      type="button"
                      style={{ ...BTN, color: "var(--danger)" }}
                      {...btnHover(busy)}
                      disabled={busy}
                      onClick={() => {
                        setConfirmRemove(null);
                        void remove(d.device_id_hex);
                      }}
                      data-testid="sync.remove-confirm-yes"
                    >
                      {t("sync.devices.remove")}
                    </button>
                    <button
                      type="button"
                      style={BTN}
                      {...btnHover()}
                      onClick={() => setConfirmRemove(null)}
                      data-testid="sync.remove-confirm-cancel"
                    >
                      {t("common.cancel")}
                    </button>
                  </span>
                </div>
              )}
            </div>
          ))}
          </div>
        )}
      </div>
    </div>
  );
}
