// Is "Add this device" an honest offer for THIS device? (MYND-635, extended to
// mobile by myne-md/myne-mobile#38)
//
// # Why the answer is a shared module and not an expression in a panel
//
// It was an expression in a panel, twice. Desktop's `SyncPanel` computed it,
// mobile's `SyncHubPanel` computed nothing at all and showed the row to
// everyone — so an already-syncing phone was invited to enrol again. The gate
// had been fixed once already, in the client that shares its tree with the web
// build; the client that keeps its own tree never heard about it. That is the
// whole shape of the bug: not a wrong condition, a condition living in a place
// only one client reads.
//
// So this file holds the predicate and nothing else. It has NO imports, which
// is load-bearing: mobile reaches it through a `@myne/enroll-gate` source alias
// into this repo, and a single import of anything under `src/platform/` or
// `src/hooks/` would drag Tauri-coupled code into that bundle.
//
// # Why it takes a state string rather than a status object
//
// The union is one type now (`src/lib/sync-status-view.ts`, re-exported by both
// clients' hooks: myne-md/myne#1027), and its `state` tag is the serde tag of the
// Rust `SyncRuntimeStatus`. The predicate still takes that tag rather than a
// status object, because a caller holding only a tag must not have to build one
// and stays unattached to either hook.
//
// # Why the arbiter is `sync_status` and not the device roster
//
// The roster is precisely what a device that cannot sync cannot read: a pending
// device holds no token, so `sync_list_devices` fails `NotEnrolled` and the
// roster can never say "you are a member". `sync_status` derives the answer
// from disk — `core/src/plugins/sync/status.rs::status_from`, over
// {endpoint, token, identity} — with no server round trip and no token needed.

/** The `state` tag of the Rust `SyncRuntimeStatus` (`core/src/plugins/sync/status.rs`). */
export type SyncStatusState =
  | "disabled"
  | "not_enrolled"
  | "pending"
  | "idle"
  | "syncing"
  | "error"
  | "uploads_blocked"
  | "conflicts";

/**
 * `true` when enrolling THIS device is a real action rather than dead UI.
 *
 * Pass `status?.state`, so an unread status arrives as `undefined`.
 */
export function canAddThisDevice(state: SyncStatusState | undefined): boolean {
  switch (state) {
    // Not a member. `disabled` is a device with no endpoint yet and
    // `not_enrolled` one with an endpoint and no identity — both are the real
    // enrol entry point, and hiding either would leave a fresh device with no
    // way in at all.
    case "disabled":
    case "not_enrolled":
      return true;

    // Identity persisted, token not yet issued: this device is already in the
    // queue. Enrolling again does not retry — `sync_enroll` mints a FRESH
    // `device_id`, stranding a second pending record that needs its own
    // approval, while the one the user is sitting at still waits.
    case "pending":
      return false;

    // A token is on disk, so this device IS a member and the form is dead UI.
    // `error` belongs here too: a failed cycle is a transport fact, not an
    // invitation to register a second time. A device removed elsewhere lands
    // here as well, and its exit is `sync_reset_local` from the device list
    // ("Reset and add again") — which clears the stale token and returns the
    // status to `not_enrolled`, i.e. back through this same gate.
    case "idle":
    case "syncing":
    case "error":
    case "conflicts":
    // Enrolled and pulling: the device is a member and its credential is fine, so the enrol form
    // is the same dead UI as `idle` (myne-md/myne#1027). Enrolling again would mint a second
    // `device_id` rather than repair the upload path, the repair is the identity phrase entry.
    case "uploads_blocked":
      return false;

    // Status not read yet. Withholding is what keeps the row from flashing on
    // an already-enrolled device during the first poll.
    case undefined:
      return false;

    default: {
      // A state the Rust enum gained and this switch did not: fail closed, and
      // make it a type error here rather than a surprise offer in the UI.
      const exhaustive: never = state;
      void exhaustive;
      return false;
    }
  }
}
