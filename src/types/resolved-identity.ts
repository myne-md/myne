// Hand-mirror of `core/src/plugins/sync/identity_resolver.rs::ResolvedIdentity`
// (`collab-provenance` task 2). Wire shape `#[serde(tag = "kind")]`, so the variant
// tags are the Rust variant names (PascalCase, like the other error mirrors) and the
// field names are as-is.
//
// TODO(Phase-1-end): replace with a `ts-rs` artifact + a drift check.

/** A resolved identity: a device (named, or the short-code fallback), a person
 *  (live presence only), or Unknown (an old note's actor / an `MY01` snapshot). */
export type ResolvedIdentity =
  | { kind: "Device"; name: string | null; code: string }
  | { kind: "Person"; name: string }
  | { kind: "Unknown" };
