# Network location on the web client: use Tor Browser

The desktop client has a switch that routes its sync through Tor
([Tor routing mode](glossary.md#tor-routing-mode), `decisions.md` 2026-07-31).
**The web client has no such switch and never will.** This note says what to do
instead, what it buys, and — the part that actually costs you something — what
it takes away.

## Why there is no in-app toggle

The desktop's answer to "route my sync through Tor" is a Tor client Myne spawns
as a **subprocess**, reached over a **loopback TCP socket** using SOCKS5. A page
has neither half: it cannot start a process, it has no raw socket, and it has no
way to point `fetch` at a proxy. This is a platform fact, not a missing feature
— there is nothing to port, so the capability is classified `Unsupported` rather
than `Pending` (`web/wasm/src/capability.rs`).

The client also declines to *report* a routing posture on the web, which is the
less obvious half of the same decision. A tab cannot tell whether the browser
around it is Tor Browser. Answering "not protected" would be a confident lie in
exactly the case where the user did the right thing, so the web client shows no
posture indicator at all rather than a wrong one.

## What to do instead

**Open the client in [Tor Browser](https://www.torproject.org/download/).** No
configuration inside Myne; there is nothing to configure.

This is stronger than the desktop toggle in one specific way. The desktop tunnel
is **per-app** and covers only Myne's own sync egress. Tor Browser routes
everything the browser does — including the request that **fetches the client
code itself** from whichever origin serves it. That origin is a real adversary
position in this threat model (`threat-model.md` **A15 / TB11**: a web client is
re-sent on every page load with no signature the browser checks), and it is a
position the desktop's toggle has no equivalent of, because a desktop build is
installed once rather than delivered on each launch. Under Tor Browser, neither
the code-delivery origin nor the sync origin sees your address.

## What it does not change

Everything in `threat-model.md` §7 about the desktop's Tor mode applies here too,
because none of it is about *how* the tunnel is built:

- **The sync server still sees when you sync, how many blobs you push, how large
  they are, and how many devices you have** (A13, AS15–AS17). Tor adds no
  padding, no jitter and no cover traffic.
- **You are not anonymous to Myne.** The `account_number_hash` is a stable
  pseudonym the server sees on every sync, so an account's syncs stay linkable to
  each other across circuits and across days. This is network-location privacy.
- **Hosted payment stays correlatable.** A payment identity linked to an account
  is not un-linked by changing the address the sync arrives from.
- **The exit node sees which servers you contact.** Endpoints are ordinary
  clearnet hosts; the exit terminates the TCP connection. It sees ciphertext
  under TLS, but it sees *where*.

And one that is specific to the browser, and is not a Tor problem:

- **Certificate trust is the browser's, over Tor exactly as on the clearnet.** A
  browser exposes no certificate-pinning API to page JavaScript, so a web session
  rests on the browser's own trust store and nothing more —
  [permanently](self-host-policy.md#6-certificate-trust), not pending a later
  release. The desktop's "type in the server's fingerprint before the pin is
  captured" ceremony has no web analogue and cannot get one. What defends the
  connection against a hostile exit node is that the exit would need a
  certificate the browser's CA set accepts — the same defence every HTTPS site
  has, no weaker and no stronger.

## Before you rely on it: two things that will surprise you

**Tor Browser discards storage when you close it.** It runs in permanent
private-browsing mode. The web client keeps its encrypted vault in OPFS, which is
part of what gets discarded — so the local copy is gone at the end of every
session. Sync is already required on the web client, so the notes come back on
the next launch; the cost is a **full re-sync every session**, and anything that
had not finished syncing when you closed the browser is **gone**. That is data
loss, not just latency. Expect a smaller storage quota too, which the client's
quota precheck may refuse a large vault against.

**The security slider can stop the client from loading at all.** The client is
JavaScript plus WebAssembly. At **Safest**, Tor Browser disables JavaScript and
WebAssembly, so nothing loads. **Standard** is the level the client is known to
need; **Safer** has historically restricted WebAssembly as well, so check it on
your version before depending on it rather than assuming a blank page is a bug in
Myne.

If you want Tor routing *and* a vault that persists between sessions, the desktop
client with its own toggle is the combination that gives you both.

## Related

- [`glossary.md`](glossary.md#tor-routing-mode) — Tor routing mode, arti sidecar
- [`threat-model.md`](threat-model.md) §7 — what Tor routing changes and what it
  does not (normative; nothing here may exceed it)
- [`self-host-web.md`](self-host-web.md) — if you serve the bundle to other
  people, you are the origin their addresses are exposed to
- [`dev/tor-verification.md`](dev/tor-verification.md) — how the desktop's Tor
  routing is verified against the real network
