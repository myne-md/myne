// Platform seam — configuration the DEPLOYMENT makes, not the user
// (phase3-web-client task 50).
//
// # What this is for
//
// The web client's sync origin is fixed by whoever runs the container, not
// typed by whoever uses it. That is the whole shape of task 50: the origin is
// runtime configuration so the bundle stays byte-identical to the published one
// (baking a server address in would make every self-hoster's bundle unique and
// its hash unverifiable), and the CSP's `connect-src` is generated from the same
// value at container start so the policy names exactly that server.
//
// The container half of that was built and the client half was not, and the
// gap was invisible from every direction that was checked: the CSP named
// `https://sync.myne.md`, the headers were right, the bundle was right — and
// `sync_get_endpoint` answered `null`, because the only writer of that config
// is `sync_set_endpoint` and nothing had ever called it. A first-run browser
// reached the password screen and failed there with "no sync server
// configured", having sent not one request. Found by driving the deployed
// origin as a user, not by any test in the suite.
//
// # Why a seam member rather than a web-only import
//
// `AccountBootstrap` is shared code. It already asks the core for the
// configured endpoint and treats `null` as a deployment fault; what it needs is
// a second place to look that is EMPTY on desktop, and that is exactly what the
// seam is for. Desktop's answer is `null` by construction — a desktop install
// has no deployment operator, its endpoint is typed by the user in settings and
// verified against public CA roots, and inventing a default here would silently
// point installs at a server nobody chose.

/**
 * The sync origin this deployment is configured for, or `null` where the
 * concept does not apply.
 *
 * Desktop: always `null` — see the header.
 */
export async function deploymentSyncOrigin(): Promise<string | null> {
  return null;
}
