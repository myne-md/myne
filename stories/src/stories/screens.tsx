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

const noop = () => {};

export const SCREEN_STORIES: StoryDescriptor[] = [
  {
    id: "screens/welcome/default",
    group: "screens",
    surface: "Welcome",
    state: "default",
    fixture: "no-vault",
    render: () => (
      <Welcome
        onCreateVault={noop}
        onRestoreBackup={noop}
        onJoinDevice={noop}
        onIdentityCreated={noop}
      />
    ),
  },
  {
    id: "screens/accountnumberentry/default",
    group: "screens",
    surface: "AccountNumberEntry",
    state: "default",
    render: () => <AccountNumberEntry onValid={noop} onCreateAccount={noop} />,
  },
  {
    id: "screens/storagelost/evicted-with-unsynced-notes",
    group: "screens",
    surface: "StorageLost",
    state: "evicted-with-unsynced-notes",
    render: () => (
      <StorageLost
        kind="evicted"
        unsyncedTitles={["Meeting notes", "Reading list", "Trips"]}
        onReDownload={noop}
        onLock={noop}
      />
    ),
  },
  {
    id: "screens/storagelost/unopenable-local-only",
    group: "screens",
    surface: "StorageLost",
    state: "unopenable-local-only",
    render: () => (
      <StorageLost
        kind="unopenable"
        unsyncedTitles={[]}
        onReDownload={noop}
        onLock={noop}
      />
    ),
  },
  {
    id: "screens/devicerevoked/default",
    group: "screens",
    surface: "DeviceRevoked",
    state: "default",
    render: () => (
      <DeviceRevoked onEraseLocalCopy={async () => {}} onDismiss={noop} />
    ),
  },
];
