import { describe, it, expect } from "vitest";
import * as shared from "@myne/copy";
import {
  REMOVE_DEVICE_CONFIRM,
  REMOVE_DEVICE_DISCLOSURE,
  SYNC_INTEGRITY_ALERT,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
  ENROLL_APPROVED_NOTICE,
  LOCAL_ERASE_DISCLOSURE,
} from "../src/lib/load-bearing-copy";

// SYNC-42 structural anti-drift: the desktop load-bearing copy is a verbatim
// re-export of the shared @myne/copy package (mobile imports the SAME source), so
// cross-client paraphrase is impossible by construction. This test fails if a
// local desktop redefinition is ever re-introduced (divergence) OR if the shared
// literal value drifts from its E2E-pinned wording (a decisions.md event).

describe("shared load-bearing copy (SYNC-42)", () => {
  it("desktop re-exports the shared @myne/copy constants — no local divergence", () => {
    expect(REMOVE_DEVICE_CONFIRM).toBe(shared.REMOVE_DEVICE_CONFIRM);
    expect(REMOVE_DEVICE_DISCLOSURE).toBe(shared.REMOVE_DEVICE_DISCLOSURE);
    expect(SYNC_INTEGRITY_ALERT).toBe(shared.SYNC_INTEGRITY_ALERT);
    expect(ENROLL_NON_DISTINGUISHING_BANNER).toBe(shared.ENROLL_NON_DISTINGUISHING_BANNER);
    expect(ENROLL_PENDING_NOTICE).toBe(shared.ENROLL_PENDING_NOTICE);
    expect(ENROLL_APPROVED_NOTICE).toBe(shared.ENROLL_APPROVED_NOTICE);
    expect(LOCAL_ERASE_DISCLOSURE).toBe(shared.LOCAL_ERASE_DISCLOSURE);
  });

  it("pins the exact E2E-literal values (a byte change is a decisions.md event)", () => {
    expect(shared.REMOVE_DEVICE_CONFIRM).toBe("Remove this device from sync?");
    expect(shared.REMOVE_DEVICE_DISCLOSURE).toBe(
      "Removing this device revokes its sync access, so the server stops syncing to it. It does not lock a device that already has your vault and password — removal is not a remote wipe.",
    );
    expect(shared.SYNC_INTEGRITY_ALERT).toBe(
      "Possible sync integrity problem: the server may have sent out-of-date or altered sync data, which Myne did not accept. Your local notes are safe. If this keeps happening, verify your devices.",
    );
    expect(shared.ENROLL_NON_DISTINGUISHING_BANNER).toBe(
      "Account number, password, or recovery phrase is incorrect. Please try again.",
    );
    expect(shared.ENROLL_PENDING_NOTICE).toBe(
      "This device is waiting for approval. Approve it from a device that already has access to start syncing.",
    );
    expect(shared.ENROLL_APPROVED_NOTICE).toBe("This device is now connected and syncing.");
    // Four sentences, in this order and none dropped: effect, what survives,
    // what this is NOT, and the one thing genuinely lost. The third is the
    // REMOVE_DEVICE_DISCLOSURE rule applied to erasure ("not a remote wipe");
    // the fourth is why the typed-DELETE gate stays.
    expect(shared.LOCAL_ERASE_DISCLOSURE).toBe(
      "This erases Myne's copy of your vault from this browser only. Your account and everything already synced stay on the server, and signing in here again brings them back. It is not an account deletion and not a remote wipe. Anything this browser has not synced yet is lost for good.",
    );
  });
});
