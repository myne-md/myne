// The web build's stand-in for the connected-extensions block
// (phase3-web-client task 96).
//
// `AccountPanel` already renders this behind `capabilities.has("clipper")`, so
// nothing displays it here — but the import still shipped the block AND
// `src/lib/clipper-pairing.ts` with it, putting five `plugin:clipper-pairing|*`
// command names and the pairing vocabulary in a bundle that can never use them.
// Substituted so "absent" is a property of the artefact rather than of the
// render path.
//
// The clipper is a native-messaging host reached through a local relay socket
// (TB10); a page has no way to open one, which is why `clipper` is a decided
// absence and not a missing port.

export function ConnectedExtensions() {
  return null;
}
