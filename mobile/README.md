# myne-mobile

[Myne](https://github.com/myne-md/myne) mobile clients — **React Native** (iOS + Android).

For the protocol specification, see [`myne/spec/protocol.md`](https://github.com/myne-md/myne/blob/main/spec/protocol.md).

## Status

**Phase 3, not yet started.** This repository will hold the React Native clients with feature parity to the desktop app. Crypto layer: `react-native-libsodium` plus a Rust bridge to `myne-protocol` (path TBD at Phase 3 start).

Mobile has unique constraints — Argon2id parameters may need a per-device profile, and OS keychain integration differs across iOS / Android. The threat model already calls these out as deferred items.

## License

AGPL-3.0. See `LICENSE`.
