// Which device row is ours, and whether it should name itself (myne-md/myne#973).
//
// Both clients render the same approved-device row, so both ask the same three
// questions: which roster row is THIS device, what counts as "it already has a
// name", and when may it adopt one. A per-client answer to any of them is a
// divergence by definition, so the answers live here.
//
// Host-free by construction (`decisions/clients/0716` extends `0580`): the caller
// injects every read and write, so this module decides and the client does.

/** One device roster row, structurally. Both clients' `DeviceEntry` mirrors the
 *  Rust `DeviceEntry`; taking the shape rather than the type keeps this module
 *  free of a client import, which is the entry criterion for living here. */
export interface DeviceRow {
  device_id_hex: string;
  approved: boolean;
  retired: boolean;
  /** Marked by the backend on exactly one row: the device serving this roster. */
  is_current?: boolean;
}

/**
 * Whether the synced `n` map carries a usable name for this device.
 *
 * A whitespace-only value counts as absent. The Rust setter refuses to write one
 * (`decisions/sync/0348` clause 3), so this arm only fires on a hand-edited or
 * foreign-client blob: belt and braces. It sits here because BOTH the row's
 * fallback label and the self-naming decision turn on the same answer, and a
 * second copy of this predicate is how the two would drift apart.
 */
export function hasDeviceName(
  names: Record<string, string> | undefined,
  deviceIdHex: string,
): boolean {
  const stored = names?.[deviceIdHex];
  return stored !== undefined && stored.trim() !== "";
}

/**
 * The roster row for the device this client is running on, or `null`.
 *
 * `approved` and `!retired` are not presentation filters here, they are the
 * security clause: a PENDING device must never name itself, because a name beside
 * an unverified device reads as a trust signal while nothing verifies it, which
 * would weaken the SYNC-40 eye-compare that is the actual defense
 * (`decisions/sync/0348` clause 2). A retired row has no token left to write with.
 */
export function selfDeviceId(devices: readonly DeviceRow[] | null): string | null {
  if (devices === null) return null;
  const self = devices.find((d) => d.is_current === true && d.approved && !d.retired);
  return self === undefined ? null : self.device_id_hex;
}

/**
 * Give this device its platform-suggested name, once, if it has never had one.
 *
 * Why it is needed at all: a name is written at enrollment, so the devices that
 * reach here nameless are the ones enrolled before names existed, the ones left
 * PENDING across an app restart (their enrollment never got to write), and the
 * ones whose enrollment write failed. Without this they keep the id-derived label
 * for the life of the device, and that label is the one thing their row must not
 * print twice (the title is derived from the same six characters as the code
 * line).
 *
 * `readBaseline` returns the device's adopted vault head (`sync_head_fingerprint`),
 * `null` when it has never pulled. That gate is `decisions/sync/0348` clause 2 made
 * mechanical: the enrollment wholesale seed is keyed on `vault.prefs` being
 * ABSENT, so a name written before the first completed cycle silently costs a
 * joining device the account's device-local preferences.
 *
 * Every failure is swallowed. This is a convenience: the fallback row is legible
 * either way, the user can always rename, and a thrown rejection in a Settings
 * effect would be a worse outcome than a device that stays "Device 3f9ac2".
 */
export async function selfNameDevice(input: {
  /** The LOADED roster, or `null`. Never the first paint: see below. */
  devices: readonly DeviceRow[] | null;
  /** The names map from a COMPLETED prefs read. */
  names: Record<string, string> | undefined;
  readBaseline: () => Promise<string | null>;
  /** The platform suggestion, or `null` when the platform is not nameable. */
  suggestName: () => Promise<string | null>;
  writeName: (deviceIdHex: string, name: string) => Promise<void>;
}): Promise<void> {
  const deviceId = selfDeviceId(input.devices);
  // A cached-empty names map that was never loaded would let this overwrite a name
  // a peer had just chosen, so the caller owes a loaded view; `null` devices means
  // the roster read has not landed either.
  if (deviceId === null || hasDeviceName(input.names, deviceId)) return;
  try {
    // Truthiness rather than `=== null`: the absent answer is `null` on every
    // real client, and a host that answered `undefined` would otherwise read as
    // "a head was adopted", which is the direction that must not happen.
    if (!(await input.readBaseline())) return;
    const name = await input.suggestName();
    if (name === null) return;
    await input.writeName(deviceId, name);
  } catch {
    /* Stays unnamed: the row keeps its id-derived label and the pencil still works.
     * This function therefore never rejects, which is why both call sites discard
     * the promise with `void` instead of wrapping it. A rejection is deliberately
     * not rethrown out of a Settings render effect either; the write is a
     * convenience and no surface can act on its failure. */
  }
}
