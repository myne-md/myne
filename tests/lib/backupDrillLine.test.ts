// @vitest-environment jsdom
//
// The one-time post-backup drill line's dismissal store (myne-md/myne#468,
// task 6). `BackupExportModal` is where the line lives, but the property worth
// pinning — "shown once on this device, then never again" — is in here, and the
// modal cannot be reached in a unit test without stubbing the native save dialog
// and the export IPC, which would test the stubs.
//
// Two failure modes matter, and the second is the one a naive implementation
// gets wrong: a denied `localStorage` must read as "not seen" (better to show
// the line twice than never) and marking must not throw.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_DRILL_LINE_KEY,
  hasSeenBackupDrillLine,
  markBackupDrillLineSeen,
} from "../../src/lib/backup-drill-line";

/** This jsdom environment provides no `localStorage`, so install a minimal
 *  in-memory stand-in for the persistence tests; the denial test removes it. */
function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  // Leave no stub behind for the next file.
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: undefined,
  });
});

describe("the backup drill line's dismissal", () => {
  it("is unseen until marked, then stays seen", () => {
    expect(hasSeenBackupDrillLine()).toBe(false);
    markBackupDrillLineSeen();
    expect(hasSeenBackupDrillLine()).toBe(true);
    expect(window.localStorage.getItem(BACKUP_DRILL_LINE_KEY)).toBe("1");
  });

  it("does not read a foreign key as its own", () => {
    window.localStorage.setItem("myne.web.reload-notice-seen", "1");
    expect(hasSeenBackupDrillLine()).toBe(false);
  });

  it("reads a denied storage as not seen, and marking it does not throw", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("SecurityError");
        },
      },
    });
    expect(hasSeenBackupDrillLine()).toBe(false);
    expect(() => markBackupDrillLineSeen()).not.toThrow();
  });
});
