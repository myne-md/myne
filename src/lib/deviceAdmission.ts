// SPDX-License-Identifier: AGPL-3.0
//
// The two-sided device admission ceremony: the client half (myne-md/myne#938
// task 11; `decisions/protocol/0735`). One `invoke` per command, five of them,
// because the ceremony has five states and each one gates a DIFFERENT write.
//
// # The guarantee this file is half of
//
// Each side gates its OWN action behind its OWN tap, and the code enforces it
// rather than the copy: `startDeviceAdmission` and `previewDeviceAdmission` are
// the two calls that write nothing (the Rust cores behind them take no IO handle
// in the mint's case, and only read in the preview's), so a screen that has
// reached either one has persisted nothing. `confirmJoiningDevice` and
// `acceptAdmittingDevice` are the two that write, and both take the SAS the human
// saw and re-derive it from the code in hand, so a code that changed under the
// user is refused with `SasMismatch` and nothing lands.
//
// # What it does NOT claim
//
// This is a client-behaviour guarantee, not a cryptographic mutuality proof:
// there is no signed confirmation token and no server-mediated phase, both
// considered and rejected in the PRD. A peer that skips its own tap is not
// detected by the other side. What the honest client cannot do is complete an
// exchange without both humans, and that is what the tests measure.
//
// # The delivery channel, stated plainly
//
// The code travels by whatever channel the user has: the joining screen shows it
// as text to copy, and the admitting screen accepts a paste. The SAS is what
// makes any channel safe. It is derived over the whole code, so a code that was
// substituted in transit moves the string the human compares and the exchange
// stops. A QR arm (phone scans, desktop displays) is a delivery improvement and
// is deliberately not built here; nothing about the gating changes if it lands.

import { invoke } from "../platform/core";
import type {
  AdmissionConfirmedView,
  AdmissionMintedView,
  AdmissionPreviewView,
} from "@myne/client-core/types/device-admission";

export type {
  AdmissionConfirmedView,
  AdmissionMintedView,
  AdmissionPreviewView,
} from "@myne/client-core/types/device-admission";
export { deviceAdmissionErrorKind } from "@myne/client-core/types/device-admission";

/**
 * JOINING side, step 1 of 2: mint the admission and show its code and SAS.
 *
 * Writes nothing to disk and sends nothing. `personIdHex` comes from the join QR
 * this device scanned, and it is carried so a code naming another account is
 * refused rather than installed into this one.
 */
export function startDeviceAdmission(
  personIdHex: string,
): Promise<AdmissionMintedView> {
  return invoke<AdmissionMintedView>("plugin:sync|sync_device_admission_start", {
    personIdHex,
  });
}

/**
 * JOINING side, step 2 of 2: persist this device's own secret, after its own tap.
 *
 * `Ok(true)` means the admitting device had already accepted, so this device
 * holds a session. `Ok(false)` is the ordinary pending answer and the screen
 * says "waiting for the other device", not an error.
 */
export function confirmJoiningDevice(confirmedSas: string): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_device_admission_confirm", {
    confirmedSas,
  });
}

/**
 * ADMITTING side, step 1 of 2: derive the SAS from a code the user pasted.
 *
 * Read-only by construction, which is what lets the surface show a comparison
 * string without having promised anything yet.
 */
export function previewDeviceAdmission(
  code: string,
): Promise<AdmissionPreviewView> {
  return invoke<AdmissionPreviewView>("plugin:sync|sync_device_admission_preview", {
    code,
  });
}

/**
 * ADMITTING side, step 2 of 2: install the credential and write the binding row,
 * after its own tap and only for the SAS the human confirmed.
 */
export function acceptAdmittingDevice(
  code: string,
  confirmedSas: string,
): Promise<AdmissionConfirmedView> {
  return invoke<AdmissionConfirmedView>("plugin:sync|sync_device_admission_accept", {
    code,
    confirmedSas,
  });
}

/**
 * Either side: discard the exchange. Nothing was written before this, so there
 * is nothing to undo beyond the RAM copy of the minted secret.
 */
export async function cancelDeviceAdmission(): Promise<void> {
  await invoke<void>("plugin:sync|sync_device_admission_cancel");
}
