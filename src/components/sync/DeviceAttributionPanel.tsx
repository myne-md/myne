// SPDX-License-Identifier: AGPL-3.0
//
// The vault's devices, with the member each one is CLAIMED by
// (`vault.device-bindings`, magic `MYU5`; myne-md/myne#852, PRD story 11).
//
// ── Why this is its own panel and not a column on the device list above ────
//
// `DeviceManagementPanel` lists the devices on THIS ACCOUNT
// (`plugin:sync|sync_list_devices`), and a member's device is enrolled on the
// MEMBER's own account: it can never appear in the owner's account roster, so
// there is no row there to augment. Story 11 asks which member a device belongs
// to for exactly the devices that panel cannot show, so the answer has to come
// from the vault-scoped store, which is what `device_bindings_list` reads.
//
// ── What a row is worth, because the field names are the trap ──────────────
//
// The row's hybrid signature covers the row's own contents
// (`protocol.md` §9.30.4). It binds the row to the person who signed it and
// binds NOTHING to the device, so any member could seal a row naming any device
// id, a co-member's included. Every string on this surface therefore reads
// "claimed by", never "belongs to" or "owned by": the honest claim is that a
// named person signed this assertion, and the device id next to it is the thing
// they made the assertion ABOUT.
//
// What makes a row renderable at all is the partition the backend performs
// before it answers, so `view.rows` holds only what survived
// `protocol::partition_verified_bindings`. An id whose row did not survive
// appears in `view.unverified_device_ids`, which carries no person and no name
// by construction and is rendered as a bare id under a plain "not verified"
// marker. Rendering a name or a friendly device label beside one of those ids
// would invent the attribution the partition exists to withhold.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDeviceBindings } from "../../hooks/useDeviceBindings";
import { usePrefs } from "../../hooks/usePrefs";
import type { DeviceAttributionRow } from "../../lib/deviceBindings";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { HELPER_STYLE } from "../settings/panel-styles";
import { SettingsSection } from "../settings/SettingsSection";

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
};

const LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  minWidth: 0,
};

/** Hex, so it is monospaced for the same reason every other id in the tree is:
 *  the reader compares it character by character against another screen. */
const CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const STATUS_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  // The panel stacks several sentences; without this each `<p>` keeps the
  // WebView's default paragraph margin and the flex gap doubles on top of it.
  margin: 0,
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
};

/** The unverified marker. `--warning` rather than `--danger`, matching
 *  `MemberRosterPanel`'s unverified-name marker and for the same reason: an id
 *  whose row did not verify is a fact to state plainly, not an alarm about a
 *  vault that is broken here and now, and the id beside it is what the reader
 *  can actually act on. */
const WARNING_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--warning)",
};

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  alignSelf: "stretch",
  width: "100%",
};

const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

/** The `This device` badge: the device-management panel's own label, reused so
 *  the two device surfaces agree on the words for the same fact. */
const BADGE_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-2)",
};

/**
 * The 16-character prefix this panel renders and puts in the DOM.
 *
 * The full value is 32 hex, and `MemberRosterPanel` records the rule: a DOM
 * holding more than the user can see holds whatever the extra characters are.
 * It matters more here than there, because a device id is only checked to BE an
 * id when the row verifies: an unverified key can be arbitrary bytes a member
 * wrote, so the slice is also what keeps this surface from echoing an unbounded
 * member-supplied string back into the document.
 */
function shortHex(hex: string): string {
  return hex.slice(0, 16);
}

/** The device's own label: the name the user gave it on this device, else the
 *  id-derived fallback. Deliberately the SAME resolution
 *  `DeviceManagementPanel` performs, so one device reads the same way on both
 *  surfaces. This is the device half of the row and never the person half. */
function deviceLabel(
  deviceIdHex: string,
  names: Record<string, string>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const stored = names[deviceIdHex];
  if (stored !== undefined && stored.trim() !== "") return stored;
  return t("sync.devices.shortName", { hex: deviceIdHex.slice(0, 6) });
}

export function DeviceAttributionPanel() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const hook = useDeviceBindings();
  const names = prefs.device_names ?? {};
  const view = hook.view;
  const rows = view?.rows ?? [];
  const unverified = view?.unverified_device_ids ?? [];

  // The three arms below fire only when there is NOTHING to show. A re-read that
  // is in flight, or a claim that just failed, keeps the rows the reader was
  // looking at: the hook deliberately holds `view` across both, and replacing a
  // list with a spinner (or with an error) because a backgrounded refresh is
  // running is how a panel flickers for no reason.
  if (view === null && hook.loading) {
    return (
      <p data-testid="device-bindings.loading" style={STATUS_STYLE}>
        {t("sync.deviceBindings.loading")}
      </p>
    );
  }

  // A failure is reported with its OWN reason rather than one generic line: the
  // store distinguishes an unreadable map from a locked slot from a vault with
  // no device identity, and the user's next action differs in each case.
  if (view === null && hook.error) {
    return (
      <p data-testid="device-bindings.error" role="alert" style={ERROR_STYLE}>
        {t(hook.error)}
      </p>
    );
  }

  // An unshared vault is a STATE, not a failure: with no group tier there is no
  // key to seal the map under and nobody to bind to a device.
  //
  // **One state wears this refusal now, and it used to wear three.** An `NTV5`
  // vault is the only vault with no group tier: a person-born `NTV7` vault carries
  // one from birth (epoch 1, a one-row owner roster) and the family resolves its
  // tail (`protocol.md` §9.30), so it renders rows like any shared vault. The
  // generation branch that used to live here said that vault "cannot be shared",
  // which the member plane stopped making true, and a panel that keeps claiming a
  // limit after it is lifted is the same defect as offering a control that cannot
  // act.
  if (view === null && !hook.shared) {
    return (
      <p data-testid="device-bindings.unshared" style={HELPER_STYLE}>
        {t("sync.deviceBindings.unshared")}
      </p>
    );
  }

  const hasOwnRow = rows.some((r) => r.is_this_device);

  return (
    <div data-testid="device-bindings" style={ROOT_STYLE}>
      <SettingsSection
        title={t("sync.deviceBindings.heading")}
        testId="device-bindings.section"
      >
        <p data-testid="device-bindings.hint" style={HELPER_STYLE}>
          {t("sync.deviceBindings.hint")}
        </p>

        {/* A claim failure lands here, BESIDE the list rather than in place of
            it: the rows the reader was looking at are still true, and only the
            write failed. */}
        {hook.error ? (
          <p data-testid="device-bindings.error" role="alert" style={ERROR_STYLE}>
            {t(hook.error)}
          </p>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            variant="firstRun"
            icon="hard-drive"
            size="sm"
            title={t("sync.deviceBindings.emptyTitle")}
            body={t("sync.deviceBindings.empty")}
            testId="device-bindings.empty"
          />
        ) : (
          <ul data-testid="device-bindings.list" style={LIST_STYLE}>
            {rows.map((row) => (
              <AttributionRow
                key={row.device_id_hex}
                row={row}
                label={deviceLabel(row.device_id_hex, names, t)}
              />
            ))}
          </ul>
        )}

        {/* The ids nobody's signature backed. A separate list rather than a
            flagged row in the one above, because these are not rows: there is
            no person and no name to put in them, and flattening the two would
            invite exactly the reader confusion the partition exists to stop. */}
        {unverified.length > 0 ? (
          <>
            <ul data-testid="device-bindings.unverified" style={LIST_STYLE}>
              {unverified.map((id) => (
                <li
                  key={id}
                  data-testid="device-bindings.unverified-row"
                  data-device-id={shortHex(id)}
                  style={ROW_STYLE}
                >
                  <span data-testid="device-bindings.unverified-id" style={CODE_STYLE}>
                    {shortHex(id)}
                  </span>
                  <span data-testid="device-bindings.unverified-marker" style={WARNING_STYLE}>
                    {t("sync.deviceBindings.unverified")}
                  </span>
                </li>
              ))}
            </ul>
            <p data-testid="device-bindings.unverified-hint" style={HELPER_STYLE}>
              {t("sync.deviceBindings.unverifiedHint")}
            </p>
          </>
        ) : null}

        {/* The claim affordance. `device_bindings_claim` is otherwise reached
            only by the unlock pipeline's best-effort call, which stands down
            silently on a vault with no group key, no device id and no person
            identity, so a device whose claim did not land has no way back
            without this. Offered when this device has no VERIFIED row of its
            own: `is_this_device` is false everywhere on a vault with no
            enrolled device id, and the honest answer there is the typed
            `NoDeviceId` message rather than a control hidden for a reason the
            user cannot see. */}
        {!hasOwnRow ? (
          <div style={ACTIONS_STYLE}>
            <p data-testid="device-bindings.claim-hint" style={HELPER_STYLE}>
              {t("sync.deviceBindings.claimHint")}
            </p>
            <Button
              type="button"
              variant="secondary"
              data-testid="device-bindings.claim"
              disabled={hook.claiming}
              onClick={() => void hook.claimSelf()}
            >
              {hook.claiming
                ? t("sync.deviceBindings.claiming")
                : t("sync.deviceBindings.claim")}
            </Button>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}

/** One verified row: the device, the person whose own signature claims it, and
 *  nothing that reads as ownership. */
function AttributionRow({
  row,
  label,
}: {
  row: DeviceAttributionRow;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-testid="device-bindings.row"
      data-device-id={shortHex(row.device_id_hex)}
      style={ROW_STYLE}
    >
      <span data-testid="device-bindings.device-label" style={LABEL_STYLE}>
        {label}
      </span>
      {/* ONE RULE FOR EVERY ROW, the roster panel's own: the member's signed
          name where there is one, the short fingerprint where there is not.
          Never a name invented from the device label, and never a blank row.
          The device's label leads, because the device is what the reader came
          for and the claim is what the row says about it. */}
      <span
        data-testid="device-bindings.claimed-by"
        data-named={row.member_name !== null ? "true" : "false"}
        style={LABEL_STYLE}
      >
        {t("sync.deviceBindings.claimedBy", {
          name: row.member_name ?? shortHex(row.person_fingerprint_hex),
        })}
      </span>
      {row.is_this_device ? (
        <span data-testid="device-bindings.this-device" style={BADGE_STYLE}>
          {t("sync.devices.thisDevice")}
        </span>
      ) : null}
    </li>
  );
}
