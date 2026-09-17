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
import { SidebarStateProvider } from "../../src/notes/sidebarState";

/** `usePrefs` consumers crash on a bare `undefined`; answer prefs-shaped. */
const PREFS_STUB = { device_names: {} };

export interface SyncPanelRoute {
  /** What `sync_status` reports. */
  readonly syncState?: string;
  readonly betaTermsAccepted?: boolean;
  /** What `vault_migrate_settle_status` reports. `can_abort` defaults to false. */
  readonly migration?: {
    readonly offerable: boolean;
    readonly pending: boolean;
    readonly can_abort?: boolean;
  };
}

/**
 * Route every command the panel's subtree issues.
 *
 * The device roster ALWAYS rejects `NotEnrolled`, because that is what a
 * token-less device gets and it is what made the old enrol gate stick, so any
 * behaviour difference between two mounts comes from what the caller varied and
 * not from the roster.
 */
export function syncPanelCommandRouter(route: SyncPanelRoute = {}) {
  const {
    syncState = "not_enrolled",
    betaTermsAccepted = true,
    migration = { offerable: false, pending: false },
  } = route;
  return async (cmd: string): Promise<unknown> => {
    if (cmd === "plugin:vault-migrate|vault_migrate_settle_status") {
      return { can_abort: false, ...migration };
    }
    if (cmd === "plugin:sync|sync_list_devices") throw { kind: "NotEnrolled" };
    // The B2B member roster (myne-md/myne#698). The panel renders whenever the
    // `memberSharing` capability is present, so every SyncPanel mount reaches
    // this command; an unanswered one resolves `undefined` and crashes the
    // panel's `.length` read.
    if (cmd === "plugin:sync|sync_list_roster") return [];
    if (cmd === "plugin:sync|sync_status") return { state: syncState };
    if (cmd === "plugin:sync|sync_beta_terms_accepted") return betaTermsAccepted;
    if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
    if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: null };
    if (cmd === "plugin:sync|sync_account_status") return null;
    if (cmd === "plugin:sync|sync_pending_conflicts") return [];
    if (cmd === "plugin:sync|sync_list_quarantine") return [];
    if (cmd === "plugin:notes|note_list") return [];
    return undefined;
  };
}

/** `SyncPanel` reads the selected note through the sidebar context (its conflict
 *  view links to one), so the panel cannot mount bare. */
export function renderSyncPanel(props: ComponentProps<typeof SyncPanel> = {}) {
  return render(
    <SidebarStateProvider>
      <SyncPanel {...props} />
    </SidebarStateProvider>,
  );
}
