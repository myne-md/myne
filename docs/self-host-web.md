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

**The application cannot detect most of these.** A deployment missing the CSP,
HSTS, CORP or Permissions-Policy looks — to you and to your users — exactly like
a correct one. That is why they are baked into the image rather than described
in a runbook you might not finish reading.

`Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` are the one
exception, and the client now checks them at boot: the browser publishes
`crossOriginIsolated`, and `SharedArrayBuffer` is either constructible or not.
Serve the bundle without them (or behind something that strips them) and the
page refuses to open the vault, naming both headers. It is a hard refusal rather
than a warning because the vault would otherwise unlock normally and then die
at the first HTTP 429 from the sync server — the rate-limit backoff sleeps on
`Atomics.wait`, which needs isolation.

## Deploying

```bash
docker build -f web/container/Dockerfile -t myne-web .
docker run -p 8080:8080 -e MYNE_SYNC_ORIGIN=https://sync.example.org myne-web
```

Put your own TLS terminator in front of it; the container serves plain HTTP on
`PORT` (default 8080) and expects to be reached over HTTPS.

**No `--platform` here, deliberately.** Building to *serve* and building to
*verify* are different jobs: serve your own architecture, natively. Only the
second job needs the reference platform, because it compares a hash against a
published one, and the build host is part of that hash
(`web-bundle-hashes.md`, "Why the build host is part of the hash"). A bundle you
built yourself needs no such comparison, because you are the code-delivery
operator for it, which is the whole point of A15/TB11 not applying to you. Your
users are a different question, answered under "Rebuilding and verifying the
bundle" below.

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

**Why it is runtime configuration and not a build-time constant.** A bundle whose
hash you intend to compare against the published record must be
**byte-identical to the published one** (below). Baking your server's address
into it would make every self-hoster's bundle unique and that comparison
impossible, so instead the address is read at container start, and the
`connect-src` directive of the Content-Security-Policy is **generated from it**.
Your policy names exactly your sync origin and is otherwise identical to the
hosted instance's; a test asserts that the two differ in nothing but that one
origin.

## Rebuilding and verifying the bundle

This is the part that turns the self-host mitigation from a claim into
something you can check.

**Read this first: a published row is a hash of the reference build environment,
not of your machine.** `linux/amd64`, built from `web/container/Dockerfile`. Cargo
hashes the build host's target triple into every crate's `-C metadata`, and that
reaches the emitted wasm, so the same commit built on an arm64 host produces a
different hash from every row in the record. That is not evidence of anything: it
is the toolchain, and no stable-toolchain flag removes it.
[`web-bundle-hashes.md`](web-bundle-hashes.md) carries the full reasoning and the
reference recipe. The consequence for the steps below is that **a native
`pnpm web:build` is the right way to build a bundle to serve, and the wrong way
to produce a number to compare against a row.**

1. Check out the commit whose bundle you intend to serve. The record is keyed on
   a commit, not a tag: nothing has been tagged as a release yet.
2. Build the bundle. To **serve** it, natively:
   `pnpm install --frozen-lockfile && pnpm web:build`. To produce a number you
   can **compare against a row**, build the reference environment instead, which
   any host can enter through emulation:
   `docker buildx build --platform linux/amd64 -f web/container/Dockerfile .`
3. Read the hash the build itself wrote. `pnpm web:build` ends in
   `scripts/emit-web-version.mjs`, which emits `web/dist/version.json` carrying
   `bundle_hash`: one SHA-256 over every emitted asset, sorted, path and
   content. You do not hash anything by hand, and an origin serving the bundle
   answers with the same field at `/version.json` (uncached, so it describes the
   build actually being served), so the identical comparison works against a
   running deployment as well as against a fresh build.
4. Compare it against the row for that commit in
   [`web-bundle-hashes.md`](web-bundle-hashes.md), the public append-only
   record, which also carries the container recipe for reproducing a row from
   scratch.

   **Use that container recipe if you want a comparison that can match.** The
   published rows are container builds, and the bundle is not yet byte-identical
   across build hosts — a local `pnpm web:build` on a different OS or CPU
   architecture produces a different hash from the same commit
   ([#228](https://github.com/myne-md/myne/issues/228), and the record's own
   "three rows for one commit" section shows it measured). Step 2 is still the
   right way to build a bundle to *serve*; it is the wrong way to build one to
   *compare*, and the two were not distinguished here before.

A match means the bundle you are about to serve is the one built from the source
you just read. On a mismatch, rule out the build environment before anything
else: a bundle built outside `linux/amd64` is **expected** to differ, and only a
mismatch from inside the reference environment is worth stopping for. That order
matters because the alternative teaches honest verifiers to ignore the check.

**If other people use your instance, this is not optional in the way it is for
you.** A bundle you built yourself needs no comparison, because you read the
source. Your users did not: to them you are the code-delivery operator, and the
one cross-check available to them is your served `/version.json` against a
published row. An instance built natively on a non-amd64 host serves a hash that
matches no row, so that check is unavailable to them. Build in the reference
environment, or tell them plainly that no published row will match what you
serve.

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
