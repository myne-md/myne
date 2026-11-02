// The `SyncPanel` mount harness, shared by every spec about that panel.
//
// The panel's subtree issues eleven commands before it renders anything, and a
// command the router does not answer resolves `undefined`, which crashes a
// `usePrefs` consumer and reads like a component regression rather than a
// missing arm. Each spec therefore carries the whole router, and a twelfth
// command has to be taught to all of them: the one that is missed fails in the
// least informative way there is.
//
// What each spec still owns is the `invoke` mock itself. `vi.mock` is hoisted
// to the top of the file it appears in and closes over a file-local `vi.fn`, so
// it cannot move here; the ROUTER it is pointed at can, and that is the part
// that was duplicated.

import type { ComponentProps } from "react";
import { render } from "@testing-library/react";
import { SyncPanel } from "../../src/components/settings/SyncPanel";
import type { AccountStatus } from "../../src/hooks/useAccountStatus";
import { SidebarStateProvider } from "../../src/notes/sidebarState";

/** `usePrefs` consumers crash on a bare `undefined`; answer prefs-shaped. */
const PREFS_STUB = { device_names: {} };

export interface SyncPanelRoute {
  /** What `sync_status` reports. */
  readonly syncState?: string;
  readonly betaTermsAccepted?: boolean;
  /** What `sync_list_devices` reports. Omit it and the roster refuses
   *  `NotEnrolled`, which is the token-less case every other case relies on. */
  readonly devices?: readonly {
    readonly device_id_hex: string;
    readonly name: string;
    readonly is_current: boolean;
    readonly approved: boolean;
    readonly retired?: boolean;
  }[];
  /** What `sync_person_status` reports (the Identity block's device-local read).
   *  Defaults to "no identity on this device". */
  readonly person?: {
    readonly enrolled?: boolean;
    /** The three-state lifecycle (myne-md/myne#911). `reserved` and `pending`
     *  are the two states that cannot list invites and need registration. */
    readonly state?: "reserved" | "pending" | "enrolled" | null;
    readonly identity_unlocked?: boolean;
    readonly person_id_hex?: string | null;
    readonly identity_code?: string | null;
    readonly sealed_keypair_present?: boolean;
  };
  /** What `vault_migrate_settle_status` reports. `can_abort` defaults to false. */
  readonly migration?: {
    readonly offerable: boolean;
    readonly pending: boolean;
    readonly can_abort?: boolean;
  };
  /**
   * What `sync_member_vault_status` reports — "is the ACTIVE vault one this
   * person joined rather than owns?" (myne-md/myne). Defaults to `false`, which is
   * the owner answer and the pre-change behaviour: the panel then offers the
   * owner's account-number QR and shows the storage row.
   */
  readonly memberVault?: boolean;
  /** What `sync_account_status` reports. `null` (the default) hides the whole
   *  usage block, which is what a server without the route answers. */
  readonly usage?: AccountStatus | null;
  /**
   * What `sync_published_state` reports (myne-md/myne#911 task 8): the DURABLE
   * publish state of the active vault. The panel draws no publish control since
   * myne-md/myne#974 (the cycle publishes on its own), so what a case varies here
   * is the vault's GENERATION: `person_born` is what withholds the legacy
   * add-device form.
   */
  readonly publishState?:
    | {
        readonly published: boolean;
        readonly namespace_hex?: string | null;
        readonly published_at_ms?: number | null;
        readonly person_born?: boolean;
      }
    | null;
}

/**
 * Route every command the panel's subtree issues.
 *
 * The device roster rejects `NotEnrolled` unless a case supplies `devices`,
 * because that is what a token-less device gets and it is what made the old
 * enrol gate stick: any behaviour difference between two mounts comes from what
 * the caller varied and not from the roster. The knob exists because the owner's
 * QR icon is gated on an approved current device, so its PRESENCE cannot be
 * asserted against a roster that always refuses.
 */
export function syncPanelCommandRouter(route: SyncPanelRoute = {}) {
  const {
    syncState = "not_enrolled",
    betaTermsAccepted = true,
    person,
    migration = { offerable: false, pending: false },
    memberVault = false,
    usage = null,
    publishState = null,
    devices,
  } = route;
  return async (cmd: string): Promise<unknown> => {
    if (cmd === "plugin:vault-migrate|vault_migrate_settle_status") {
      return { can_abort: false, ...migration };
    }
    // The Identity block's device-local read. Defaults to "no identity here", so
    // the block offers the Add CTA; a case that wants the identity surface sets
    // it.
    if (cmd === "plugin:sync|sync_person_status") {
      return {
        enrolled: false,
        state: null,
        identity_unlocked: false,
        person_id_hex: null,
        identity_code: null,
        sealed_keypair_present: false,
        ...person,
      };
    }
    if (cmd === "plugin:sync|sync_list_devices") {
      // The roster ALWAYS refuses by default, which is what a token-less device
      // gets and what made the old enrol gate stick. `devices` is the one knob
      // that changes it, added for the owner-QR gating: that icon needs an
      // approved current device, so a case asserting its presence has to be able
      // to answer the roster rather than only its refusal.
      if (devices === undefined) throw { kind: "NotEnrolled" };
      return devices;
    }
    // The B2B member roster (myne-md/myne#698). The panel renders whenever the
    // `memberSharing` capability is present, so every SyncPanel mount reaches
    // this command; an unanswered one resolves `undefined` and crashes the
    // panel's `.length` read.
    if (cmd === "plugin:sync|sync_list_roster")
      return { members: [], authority: "owner" };
    // The owner-side invitation list (myne-md/myne#711 task 11), reached when
    // the roster reports owner authority. An unanswered one crashes the panel.
    if (cmd === "plugin:sync|sync_list_vault_invites") return [];
    // The device-attribution panel (myne-md/myne#852 story 11). It renders under
    // the SAME `memberSharing` gate as the roster above, so every mount that
    // reaches `sync_list_roster` reaches this one too. The panel's own hook
    // tolerates an unanswered command (it reads `view?.rows ?? []`), but a
    // router arm is what makes a SyncPanel spec see a real state rather than an
    // accidentally-empty one.
    if (cmd === "plugin:device-binding|device_bindings_list")
      return { rows: [], unverified_device_ids: [] };
    if (cmd === "plugin:sync|sync_status") return { state: syncState };
    // The member-vault probe (myne-md/myne). It gates which account-plane
    // affordances the panel offers, so a spec that varies it is varying the one
    // fact both the QR icon and the usage block read.
    if (cmd === "plugin:sync|sync_member_vault_status") return memberVault;
    if (cmd === "plugin:sync|sync_beta_terms_accepted") return betaTermsAccepted;
    if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
    if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: null };
    if (cmd === "plugin:sync|sync_account_status") return usage;
    if (cmd === "plugin:sync|sync_published_state") {
      if (publishState === null) throw { kind: "NotAvailable" };
      return {
        namespace_hex: null,
        published_at_ms: null,
        person_born: true,
        ...publishState,
      };
    }
    if (cmd === "plugin:sync|sync_pending_conflicts") return [];
    if (cmd === "plugin:sync|sync_list_quarantine") return [];
    if (cmd === "plugin:notes|note_list") return [];
    return undefined;
  };
}

/** `SyncPanel` reads the selected note through the sidebar context (its conflict
 *  view links to one), so the panel cannot mount bare.
 *
 *  A `vaultId` is supplied by default because the member-vault probe is an effect
 *  keyed on it: a panel mounted without one never asks the question at all
 *  (`useMemberVault`), so a spec that varies `memberVault` would be varying a read
 *  its own mount skips. Passing it here keeps that read exercised in every spec,
 *  the owner answer being the router's default. */
export function renderSyncPanel(props: ComponentProps<typeof SyncPanel> = {}) {
  return render(
    <SidebarStateProvider>
      <SyncPanel vaultId="v-harness-active" {...props} />
    </SidebarStateProvider>,
  );
}
