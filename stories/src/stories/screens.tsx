// Stories for the top-level screens (myne-md/myne#832 task 7).
//
// Screens take explicit callbacks and read the rest through the seam, so a
// story supplies no-op callbacks and a fixture for the state. This is a starter
// set: every screen not yet covered is recorded as debt by
// `scripts/check-story-coverage.mjs`, and the ratchet means the debt may only
// shrink.

import type { StoryDescriptor } from "../types";
import { Welcome } from "@app/screens/Welcome";
import { AccountNumberEntry } from "@app/screens/AccountNumberEntry";
import { StorageLost } from "@app/screens/StorageLost";
import { DeviceRevoked } from "@app/screens/DeviceRevoked";
import { action } from "../actions";


export const SCREEN_STORIES: StoryDescriptor[] = [
  {
    id: "screens/welcome/default",
    group: "screens",
    surface: "Welcome",
    state: "default",
    description: "Welcome, a default state.",
    fullBleed: true,
    tags: ["screens", "welcome", "default"],
    fixture: "no-vault",
    render: () => (
      <Welcome
        onCreateVault={action("onCreateVault")}
        onRestoreBackup={action("onRestoreBackup")}
        onJoinDevice={action("onJoinDevice")}
        onIdentityCreated={action("onIdentityCreated")}
      />
    ),
  },
  {
    id: "screens/accountnumberentry/default",
    group: "screens",
    surface: "AccountNumberEntry",
    state: "default",
    description: "Account Number Entry, a default state.",
    fullBleed: true,
    tags: ["screens", "accountnumberentry", "default"],
    render: () => <AccountNumberEntry onValid={action("onValid")} onCreateAccount={action("onCreateAccount")} />,
  },
  {
    id: "screens/storagelost/evicted-with-unsynced-notes",
    group: "screens",
    surface: "StorageLost",
    state: "evicted-with-unsynced-notes",
    description: "Storage Lost, an evicted-with-unsynced-notes state.",
    fullBleed: true,
    tags: ["screens", "storagelost", "evicted-with-unsynced-notes"],
    render: () => (
      <StorageLost
        kind="evicted"
        unsyncedTitles={["Meeting notes", "Reading list", "Trips"]}
        onReDownload={action("onReDownload")}
        onLock={action("onLock")}
      />
    ),
  },
  {
    id: "screens/storagelost/unopenable-local-only",
    group: "screens",
    surface: "StorageLost",
    state: "unopenable-local-only",
    description: "Storage Lost, an unopenable-local-only state.",
    fullBleed: true,
    tags: ["screens", "storagelost", "unopenable-local-only"],
    render: () => (
      <StorageLost
        kind="unopenable"
        unsyncedTitles={[]}
        onReDownload={action("onReDownload")}
        onLock={action("onLock")}
      />
    ),
  },
  {
    id: "screens/devicerevoked/default",
    group: "screens",
    surface: "DeviceRevoked",
    state: "default",
    description: "Device Revoked, a default state.",
    fullBleed: true,
    tags: ["screens", "devicerevoked", "default"],
    render: () => (
      <DeviceRevoked onEraseLocalCopy={async () => {}} onDismiss={action("onDismiss")} />
    ),
  },
];
