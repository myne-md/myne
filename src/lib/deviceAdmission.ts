// SPDX-License-Identifier: AGPL-3.0
// Joining an account WITHOUT the recovery phrase (`decisions/protocol/0735`).
//
// Two devices, two calls each. The device being added mints its own server-auth
// secret and shows a code; a device that is already signed in reads that code,
// shows the short authentication string for the user to compare against the
// other screen, and on confirmation installs the credential and binds the new
// device's row.
//
// The code carries a credential-equivalent SCRAM verifier, so it is handled like
// a one-time credential rather than like a link: it is shown to the user, it is
// not logged, and the write on the admitting side is bound to the SAS the user
// confirmed.
import { invoke } from "../platform/core";

/** The string the web build's surface roster looks for to prove this module was
 *  substituted OUT of the browser bundle rather than merely left unreachable
 *  (`scripts/check-web-surfaces.mjs`). Nothing else in the tree emits it. */
export const DEVICE_ADMISSION_ABSENCE_MARKER = "device-admission-binding";

/** What the joining device shows, and what it must be able to show again after a
 *  restart (`sync_pending_device_admission`). Snake_case: a returned struct
 *  serializes verbatim, the same convention every other view in `src/lib`
 *  follows. */
export interface AdmissionCodeView {
  code: string;
  sas: string;
  device_id_hex: string;
  /** Whether this device minted a signing key as part of the admission. False on
   *  a platform with no storage rung, where the device still joins but keeps
   *  signing with the person key. */
  has_device_key: boolean;
}

export interface AdmitOutcomeView {
  device_id_hex: string;
  sas: string;
  /** Whether the binding row was written. False when this device holds no
   *  unlocked person identity or the active vault is not B2B yet; the device is
   *  still admitted server-side in both cases. */
  bound: boolean;
}

/** Mint this device's own credential and the code that offers it. */
export function deviceAdmissionCode(personIdHex: string): Promise<AdmissionCodeView> {
  return invoke<AdmissionCodeView>("plugin:sync|sync_device_admission_code", {
    personIdHex,
  });
}

/** The admission this device already started, so an interrupted join resumes. */
export function pendingDeviceAdmission(): Promise<AdmissionCodeView | null> {
  return invoke<AdmissionCodeView | null>("plugin:sync|sync_pending_device_admission", {});
}

/** Admit the device a code describes. `sas` is what the user read on the other
 *  screen, and the write is bound to it. */
export function admitDevice(code: string, sas: string): Promise<AdmitOutcomeView> {
  return invoke<AdmitOutcomeView>("plugin:sync|sync_admit_device", { code, sas });
}

/** Sign this device in with the credential an admitting device installed.
 *  Resolves `false` while the install has not landed yet. */
export function claimDeviceAdmission(): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_claim_device_admission", {});
}
