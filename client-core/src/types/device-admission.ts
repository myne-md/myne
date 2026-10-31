// SPDX-License-Identifier: AGPL-3.0
//
// Manual TS mirror of the three views the two-sided device admission ceremony
// returns (`core/src/plugins/sync/device_admission.rs`; myne-md/myne#938 task
// 11, `decisions/protocol/0735`). Shared by every client because the ceremony is
// `myne-core`'s: desktop and mobile call the SAME command cores, and this is the
// shape `sync_device_admission_{start,preview,accept}` return.
//
// TODO(Phase-1-end): replace this hand-written mirror with a `ts-rs`
// auto-generated artifact plus a CI drift check, like every other file in this
// directory. Until then, a shape change in the Rust view must be reflected here
// in the same change.
//
// **`sas` is the whole point of the two views that carry it.** It is eight hex
// characters and a dash, derived over the WHOLE admission code, so a substituted
// device id, signing half or verifier each move it (`0735` decision 2). The two
// screens show the same string and the human compares them; a surface that
// renders the code instead of the string has replaced a comparison a person can
// actually make with four thousand characters nobody will read.

/** What the JOINING device shows, and nothing it has written. */
export interface AdmissionMintedView {
  /** The `MYNE-DEVICE-1:` code, for the other device to read. Credential-equivalent. */
  code: string;
  /** The eight hex characters (with a dash) both screens display. */
  sas: string;
  /** This device's id, 32 lowercase hex. */
  device_id_hex: string;
  /**
   * False when this platform has no device-key storage rung. Not a fault: the
   * device is admittable and signs `0x02` heads with the person key afterwards,
   * which the surface must say rather than implying the stronger thing.
   */
  has_device_key: boolean;
}

/** What the ADMITTING device shows BEFORE it writes anything. */
export interface AdmissionPreviewView {
  /** The SAS derived from the code in hand. The human compares it. */
  sas: string;
  device_id_hex: string;
  person_id_hex: string;
  /** Whether the joining device declared signing halves. */
  has_device_key: boolean;
}

/** The answer once the admitting device has written. */
export interface AdmissionConfirmedView {
  device_id_hex: string;
  sas: string;
  /**
   * False when the binding row could not be written. The credential IS
   * installed, so the device authenticates; the row is what publishes its
   * signing halves, and the next claim retries it. The surface says "joined,
   * attribution pending" rather than reporting a failure that did not happen.
   */
  binding_written: boolean;
}

/**
 * The `kind` of a thrown `SyncDeviceError`, or `"Internal"` for anything else.
 *
 * The backend tags its enum `{ kind, detail }`, and for this ceremony the two
 * kinds a surface must word differently are `SasMismatch` (the code changed
 * between the screen and the button: a stop, not a retry) and
 * `NoPendingAdmission` (the exchange was cancelled or the vault locked: start
 * again). Everything else is the ordinary sync error surface.
 */
export function deviceAdmissionErrorKind(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    return String((error as { kind: unknown }).kind);
  }
  return "Internal";
}
