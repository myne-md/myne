# Support

Myne is pre-alpha, source-only software maintained by two people. Support is
best effort: there is no service-level agreement, no guaranteed response time
and no commercial support. The one response commitment in the project is the
security policy in [`SECURITY.md`](SECURITY.md).

## Before asking

- Read [`README.md`](README.md), the specification and threat model under
  [`docs/`](docs/), and [`AGENTS.md`](AGENTS.md) for the build and test rules.
- Search the open and closed issues; the answer may already be there.
- Build from source. No prebuilt binaries are distributed.

## Where to ask

| What | Where |
| --- | --- |
| A bug in a client, the protocol crate, the build or the browser clipper | Open an issue with the **Bug report** template |
| A question about using Myne, or about a design or documentation decision | Open an issue with the **Question** template; GitHub Discussions will be the home for this once it is enabled |
| A vulnerability | Email **security@myne.md** privately; see [`SECURITY.md`](SECURITY.md) |
| A conduct concern | Follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) |
| Licensing, reuse or the source offer | Email **legal@myne.md**, or read [`LICENSING.md`](LICENSING.md) and [`SOURCE-OFFER.md`](SOURCE-OFFER.md) |

Issues and pull requests are written in English so the record stays
searchable.

## What is supported

- The current `develop` branch. Myne is pre-alpha and the on-disk format is not
  stable; there are no backports and no maintained older versions.
- Linux is what CI builds and tests. macOS and Windows build instructions are
  in the repository, but those platforms are not covered by CI; reports from
  them are welcome and are treated as unverified until someone reproduces them.
- The sync server lives in the companion `myne-server` repository and is
  supported there. Myne runs no sync service, so there is no hosted account to
  support. A self-hosted instance is supported by its operator.
- Forks and modified builds are supported by whoever publishes them. Report a
  problem there first.

## What to include

- The commit you built from (or the version string, if you did not build it).
- Operating system and version, and the display server on Linux.
- What you expected, what happened, and the steps that reproduce it.
- The smallest relevant log excerpt. Redact tokens, keys, account numbers and
  note content before pasting.

Never include vault content, an account number, a master password, a recovery
phrase, a token or a key in an issue, a discussion or a pull request. A
maintainer will never ask for them.
