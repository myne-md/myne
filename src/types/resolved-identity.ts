// Hand-mirror of `core/src/plugins/sync/identity_resolver.rs::ResolvedIdentity`
// (`collab-provenance` task 2). Wire shape `#[serde(tag = "kind")]`, so the variant
// tags are the Rust variant names (PascalCase, like the other error mirrors) and the
// field names are as-is.
//
// TODO(Phase-1-end): replace with a `ts-rs` artifact + a drift check.

/**
 * A resolved identity: a device (named, or the short-code fallback), a person, or
 * Unknown (an old note's actor / an `MY01` snapshot / an actor nobody attributed).
 *
 * `Person` is NOT live-presence-only any more: since `member-devices` task 4 the
 * backend also resolves a DURABLE revision author through the device-binding join
 * (device id -> bound person -> verified roster -> the signed member-name row), so a
 * version-history row can carry a person's name. The name is the person's own chosen
 * display string and is never a proof of authorship: the binding is a label
 * (`decisions/protocol/0669`, which does not lift the limit `0660` states).
 *
 * `Device.name` is the user-chosen device label, `null` when nobody named it, and
 * `Device.code` is always the six-character device code to fall back on.
 * `Person.name` is never empty: the backend drops a blank name row rather than
 * returning one.
 */
export type ResolvedIdentity =
  | { kind: "Device"; name: string | null; code: string }
  | { kind: "Person"; name: string }
  | { kind: "Unknown" };
