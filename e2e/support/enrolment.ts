// The enrolment state, in the one place every sync suite can reach it.
//
// It lives here rather than in `flows.ts` because `multi-device.ts` needs it too
// and `flows.ts` imports FROM `multi-device.ts`: a helper in either would close an
// import cycle for a four-line wait.

import type { Session } from "./webdriver";

/**
 * Wait until this vault counts as ENROLLED — the device roster has a row and the
 * "not enrolled" prompt is gone.
 *
 * One helper because four places needed the same fact and each was written
 * against `sync.enroll.approved`, the notice INSIDE `EnrollDeviceForm`, which
 * `SyncPanel` unmounts the moment the vault is enrolled: the notice can never
 * paint in the state it describes. Every caller timed out after 30 s while the
 * enrolment had succeeded (the screenshot showed the roster with "This device"
 * under it). A refusal is reported with the product's own sentence rather than
 * as a timeout, so a real enrolment failure still names itself.
 */
export async function waitForEnrolled(
  session: Session,
  timeoutMs = 30_000,
): Promise<void> {
  await session.waitUntil(
    async () => {
      const [refusal] = await session.byTestIdAll("sync.enroll.error");
      if (refusal !== undefined) {
        throw new Error(`enrolment was refused: ${await refusal.textContent()}`);
      }
      const [notEnrolled] = await session.byTestIdAll("sync.device-not-enrolled");
      const [roster] = await session.byTestIdAll("sync.device-row");
      return notEnrolled === undefined && roster !== undefined ? true : null;
    },
    { label: "this device appears in the account's device roster", timeoutMs },
  );
}
