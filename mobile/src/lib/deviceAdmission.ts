// SPDX-License-Identifier: AGPL-3.0
//
// The two-sided device admission ceremony, mobile's client half (myne-md/myne#938
// task 11; `decisions/protocol/0735`). One `invoke` per command.
//
// The desktop and web binding lives at `src/lib/deviceAdmission.ts`; this file
// exists because mobile has its own platform seam (`mobile/src/platform/core`)
// and cannot import the desktop one. The five commands and their gating are the
// same commands, so the rules stated there hold here without restating them: the
// two calls that write nothing are `start` and `preview`, and the two that write
// both take the SAS the human saw so a code that changed under them is refused
// with `SasMismatch`.
//
// The phone is usually the JOINING side in this product (its first run is the
// join screen), so `start`/`confirm` are the pair its surface uses.

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

/** JOINING side, step 1 of 2: mint the code and the SAS. Writes nothing. */
export function startDeviceAdmission(
  personIdHex: string,
): Promise<AdmissionMintedView> {
  return invoke<AdmissionMintedView>("plugin:sync|sync_device_admission_start", {
    personIdHex,
  });
}

/**
 * JOINING side, step 2 of 2: persist this device's own secret after its own tap.
 *
 * `true` means the other device had already accepted; `false` is the ordinary
 * pending answer and the screen says "waiting", not "failed".
 */
export function confirmJoiningDevice(confirmedSas: string): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_device_admission_confirm", {
    confirmedSas,
  });
}

/** ADMITTING side, step 1 of 2: derive the SAS from a pasted code. Read-only. */
export function previewDeviceAdmission(
  code: string,
): Promise<AdmissionPreviewView> {
  return invoke<AdmissionPreviewView>("plugin:sync|sync_device_admission_preview", {
    code,
  });
}

/** ADMITTING side, step 2 of 2: install the credential and write the row. */
export function acceptAdmittingDevice(
  code: string,
  confirmedSas: string,
): Promise<AdmissionConfirmedView> {
  return invoke<AdmissionConfirmedView>("plugin:sync|sync_device_admission_accept", {
    code,
    confirmedSas,
  });
}

/** Either side: discard the exchange. Nothing was written before this. */
export async function cancelDeviceAdmission(): Promise<void> {
  await invoke<void>("plugin:sync|sync_device_admission_cancel");
}
