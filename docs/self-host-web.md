# Self-hosting the Myne web client

> **Normative.** This document states what a self-hoster of the web client takes
> on and which security properties depend on their configuration. It is the
> web-client counterpart of [`self-host-policy.md`](self-host-policy.md), which
> covers the sync server. Deployment *mechanics* beyond the container's own
> interface — reverse-proxy config, TLS issuance, orchestration — live in the
> `myne-ops` companion; this document embeds no bundle-specific command that is
> not part of the client's own contract.

## What you become by serving it

Running your own copy of the web client changes your position in the threat
model, in one specific and favourable way and one specific and unfavourable one.

**Favourable.** `threat-model.md` **A15** (hostile delivery of the client code)
exists because a web client is re-sent from a server on every page load, with no
signature the browser checks. If you build the bundle and serve it yourself,
**you are your own code-delivery operator** and there is no third party in that
path at all. A15 does not apply to you.

**Unfavourable, and it is the part people skip.** That exemption is *yours*, not
your users'. For anyone else using your instance, **you** are the code-delivery
operator — exactly as the Myne team is for the hosted one. If other people rely
on your deployment, A15 applies to them with you in the role, and the honest
thing is to tell them so.

Everything else is unchanged. The sync server still sees only opaque ciphertext
(TB5), and it makes no difference to that whether the client came from us or
from you.

## What the container is, and why it is not a directory of files

`web/container/Dockerfile` builds an image carrying **the bundle and a server**.
It would have been less work to publish the built bundle and let you serve it —
and it would have been wrong. A meaningful part of the client's security posture
is in the **response headers**, and a static server with default settings drops
all of them silently:

| Header | If it is missing |
|---|---|
| `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` | Cross-origin isolation is off. The client needs it. |
| `Content-Security-Policy` | The zero-third-party guarantee is gone; the bundle is no longer the whole attack surface. |
| `Cross-Origin-Resource-Policy` | Your assets become embeddable by other origins. |
| `Strict-Transport-Security` | The one origin where a MITM is fatal loses its strongest transport defence. |
| `Permissions-Policy` | A substituted bundle could reach the camera or microphone with only a browser prompt in the way. |

**Nothing in the application can detect a missing response header.** A
deployment with none of them looks, to you and to your users, exactly like a
correct one. That is why they are baked into the image rather than described in
a runbook you might not finish reading.

## Deploying

```bash
docker build -f web/container/Dockerfile -t myne-web .
docker run -p 8080:8080 -e MYNE_SYNC_ORIGIN=https://sync.example.org myne-web
```

Put your own TLS terminator in front of it; the container serves plain HTTP on
`PORT` (default 8080) and expects to be reached over HTTPS.

### `MYNE_SYNC_ORIGIN` is required, and the container refuses to start without it

Scheme, host and optional port — nothing else:

```
MYNE_SYNC_ORIGIN=https://sync.example.org
```

It is validated at start-up and the container **exits non-zero** rather than
serving anything if it is missing, a wildcard, plain `http` to a non-loopback
host, or carries a path. Each refusal names its reason. A client that boots and
then cannot reach its sync server is a worse outcome than one that does not
boot.

**Why it is runtime configuration and not a build-time constant.** The bundle
you run must be **byte-identical to the published one** so its hash can be
verified (below). Baking your server's address into it would make every
self-hoster's bundle unique and that verification impossible — so instead the
address is read at container start, and the `connect-src` directive of the
Content-Security-Policy is **generated from it**. Your policy names exactly your
sync origin and is otherwise identical to the hosted instance's; a test asserts
that the two differ in nothing but that one origin.

## Rebuilding and verifying the bundle

This is the part that turns the self-host mitigation from a claim into
something you can check.

1. Check out the commit whose bundle you intend to serve. The record is keyed on
   a commit, not a tag — nothing has been tagged as a release yet.
2. Build the bundle: `pnpm install --frozen-lockfile && pnpm web:build`.
3. Read the hash the build itself wrote. `pnpm web:build` ends in
   `scripts/emit-web-version.mjs`, which emits `web/dist/version.json` carrying
   `bundle_hash` — one SHA-256 over every emitted asset, sorted, path and
   content. You do not hash anything by hand, and an origin serving the bundle
   answers with the same field at `/version.json` (uncached, so it describes the
   build actually being served), so the identical comparison works against a
   running deployment as well as against a fresh build.
4. Compare it against the row for that commit in
   [`web-bundle-hashes.md`](web-bundle-hashes.md) — the public append-only
   record, which also carries a container-based recipe for reproducing a row
   from scratch.

A match means the bundle you are about to serve is the one built from the source
you just read. A mismatch means it is not, and that is worth stopping for.

Two things make that comparison worth making. The record is a **precondition for
the hosted deploy rather than a log kept afterwards** — `check-bundle-record.mjs`
refuses an image whose hash is not already in the table, so a substituted bundle
would have to be published before it could be served. And the reproducibility the
comparison rests on is itself gated: `version.json` carries the *commit's*
timestamp rather than a wall clock, the wasm build remaps every machine-specific
path, and CI rebuilds the wasm artefact twice cold and fails if the two digests
differ (`scripts/wasm-repro-check.sh`) — on a different machine than the author's,
which is most of the value.

## Which security properties depend on you

These are yours to get right; nothing in the client can compensate:

- **Serving over HTTPS.** The container speaks HTTP to your terminator.
- **Not co-hosting the app with anything else on the same origin.** OPFS is
  origin-scoped: any script on that origin can reach the vault storage. Give the
  client its own origin — this is the same reasoning behind the hosted client
  running on `app.myne.md` rather than a path on the marketing site
  (`decisions.md` 2026-07-26).
- **Not weakening the header set.** It is baked in; overriding it at a proxy is
  possible and is your decision to justify.
- **Not logging client IPs at the bundle origin.** The sync server's no-IP
  commitment (`self-host-policy.md`) covers the sync origin. The origin serving
  the bundle is a second place the same metadata appears, and a default access
  log defeats the commitment there.
- **Telling your users whose code they are running**, if the instance is not
  just for you. See the first section.

Two things about client addresses are worth passing on rather than assuming.
Your origin sees them at every page load whether you log them or not, and the
web client has no Tor switch of its own — a user who wants their network
location hidden from both your origin and the sync server opens the client in
Tor Browser, at a cost this repo states plainly in
[`web-tor-browser.md`](web-tor-browser.md).

## Source obligation (AGPL-3.0)

The web client is AGPL-3.0. Serving it over a network engages §13: your users
are entitled to the corresponding source of the version you are running,
including any modifications. If you serve an unmodified released build, pointing
at the public repository and the release tag satisfies this. If you modified it,
your modified source has to be available to them too.

The image carries `org.opencontainers.image.source` as the machine-readable half
of that offer.
