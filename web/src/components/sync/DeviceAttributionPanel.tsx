// The web build's stand-in for the device-attribution panel (myne-md/myne#852).
//
// Its five siblings in this directory are substituted for one reason: a
// recovery-phrase prompt must not enter the served artefact at all, and
// `docs/vision.md` commits that the phrase is kept out by build-time
// substitution rather than by a runtime capability gate. This panel has no
// phrase prompt, so that reason does not reach it. Two others do.
//
// The store it reads is `NTV6`-only and group-tier sealed: a browser holds no
// group key and no person identity, so `device_bindings_list` and
// `device_bindings_claim` are both classified `Class::Unsupported` in
// `web/wasm/src/capability.rs`, and the panel could only ever render a typed
// refusal. And `memberSharing` is absent on web, so `SyncPanel` does not render
// the block at all: leaving the module in the graph would ship member-sharing
// surface no route can reach, which is the weaker claim this directory keeps
// refusing to settle for, and it would spend first-load budget on it.
//
// So this renders nothing, and the panel's rows, its two invoke literals and its
// strings never enter the bundle.

export function DeviceAttributionPanel() {
  return null;
}
