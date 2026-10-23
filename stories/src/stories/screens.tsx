// Stories for the top-level screens (myne-md/myne#832 task 7).
//
// Screens take explicit callbacks and read the rest through the seam, so a
// story supplies no-op callbacks and a fixture for the state. This is a starter
// set: every screen not yet covered is recorded as debt by
// `scripts/check-story-coverage.mjs`, and the ratchet means the debt may only
// shrink.

import type { StoryDescriptor } from "../types";
import { Welcome } from "@app/screens/Welcome";
import { FirstRun } from "@app/screens/FirstRun";
import { AccountNumberEntry } from "@app/screens/AccountNumberEntry";
import { StorageLost } from "@app/screens/StorageLost";
import { DeviceRevoked } from "@app/screens/DeviceRevoked";
import { action } from "../actions";


export const SCREEN_STORIES: StoryDescriptor[] = [
  {
    id: "screens/firstrun/default",
    group: "screens",
    surface: "FirstRun",
    state: "default",
    description:
      "The first run (myne-md/myne#911): the identity, with the one phrase that recovers everything and the type-back that proves it was saved. This screen replaced the welcome fork, so the vault that follows has no phrase of its own. Look for one create row and one recover row inside the panel, and that the phrase is not on screen until it is revealed.",
    fullBleed: true,
    tags: ["screens", "first-run", "identity", "onboarding", "phrase", "type-back", "offline", "zero-vault"],
    fixture: "no-vault",
    render: () => (
      <FirstRun
        onIdentityCreated={action("onIdentityCreated")}
        onAbandon={action("onAbandon")}
      />
    ),
  },
  {
    id: "screens/welcome/default",
    group: "screens",
    surface: "Welcome",
    state: "default",
    description:
      "The zero-vault entry screen: the mark, the tagline, ONE create door that starts the first run (identity, then vault), and the two doors that create nothing, restore from a `.myne-backup`, and joining an existing account. The language picker and version sit below. Look for the single primary button and that the old identity/local fork is gone.",
    fullBleed: true,
    tags: ["screens", "welcome", "first-run", "zero-vault", "restore-backup", "join-device", "identity", "onboarding", "language"],
    fixture: "no-vault",
    render: () => (
      <Welcome
        onStart={action("onStart")}
        onRestoreBackup={action("onRestoreBackup")}
        onJoinDevice={action("onJoinDevice")}
      />
    ),
  },
  {
    id: "screens/accountnumberentry/default",
    group: "screens",
    surface: "AccountNumberEntry",
    state: "default",
    description:
      "The web client's first-run identity step. An empty browser has to be told which account to pull, so this is the 27-character account number (`MY-` plus five groups) in its grouped display form; the Damm-32 check character is validated locally before any request, and one message is shown whatever fails.",
    fullBleed: true,
    tags: ["screens", "account-number", "accountnumberentry", "web-only", "first-run", "identity", "damm-32", "validation", "offline"],
    render: () => <AccountNumberEntry onValid={action("onValid")} onCreateAccount={action("onCreateAccount")} />,
  },
  {
    id: "screens/storagelost/evicted-with-unsynced-notes",
    group: "screens",
    surface: "StorageLost",
    state: "evicted-with-unsynced-notes",
    description:
      "The browser lost its local store to an origin eviction, and three notes from the last unsynced answer are listed as gone rather than pending: nothing on the server is damaged and the remedy is a re-download. Look for the honest loss list, and the note that this browser re-enrols as a NEW device and waits for approval.",
    fullBleed: true,
    tags: ["screens", "storage-lost", "evicted", "web-only", "unsynced", "data-loss", "re-download", "opfs", "re-enrol"],
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
    description:
      "`vault.meta` in the local container cannot be read as a vault and there is no unsynced list to show, so the card says that plainly and points at the backup route rather than offering a repair it cannot perform.",
    fullBleed: true,
    tags: ["screens", "storage-lost", "unopenable", "web-only", "corrupted", "meta-unreadable", "backup", "recovery"],
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
    description:
      "This browser was removed from the account elsewhere, so it locked, erased its own local copy and is saying so. It is deliberately not described as a remote wipe: the copy names the real loss (anything unsynced here is gone), and the CTA reloads, which also releases the single-tab Web Lock.",
    fullBleed: true,
    tags: ["screens", "device-revoked", "web-only", "removed-device", "erase", "lock", "reload", "web-lock"],
    render: () => (
      <DeviceRevoked onEraseLocalCopy={async () => {}} onDismiss={action("onDismiss")} />
    ),
  },
];
