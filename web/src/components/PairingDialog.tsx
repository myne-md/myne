// The web build's stand-in for the clipper pairing dialog
// (phase3-web-client task 96).
//
// `App.tsx` mounts `<PairingDialog />` GLOBALLY — over every stage — because a
// connect request from the browser extension can arrive at any moment on
// desktop. On web there is no such moment: the clipper is a native-messaging
// host talking to a local relay socket, which a page has no way to reach, and
// `clipper` is in the capability descriptor's ABSENT set.
//
// So this renders nothing, and the real dialog — with its pairing-token
// vocabulary, its TB10 approval copy and the extension-identity strings — never
// enters the bundle. A globally-mounted component is exactly the shape that
// otherwise ships unnoticed: nothing routes to it, so no route audit finds it.

export function PairingDialog() {
  return null;
}
