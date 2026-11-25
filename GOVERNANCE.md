# Governance

Myne is maintained by two people. This document describes how decisions are
made, what is public, and how these rules change. It covers
[`myne-md/myne`](https://github.com/myne-md/myne); a companion repository
follows it unless that repository carries its own governance file.

## Maintainers

| Maintainer | GitHub | Areas |
| --- | --- | --- |
| Ömer Duran | [@omerdduran](https://github.com/omerdduran) | protocol, desktop core, sync, build and release tooling, infrastructure |
| Furkan Ünsalan | [@furkanunsalan](https://github.com/furkanunsalan) | interface, mobile, website, design system |

Both maintainers have write access and merge rights. A maintainer is added or
removed by agreement of the current maintainers, recorded as a commit to this
file, so the roster and its history are public.

## How decisions are made

Most decisions are made in the open. An issue states the problem, a pull
request carries the change, and the discussion on both is the record.

- **Ordinary changes** merge with at least one maintainer approval and a green
  CI run.
- **Load-bearing changes** start as an issue and need both maintainers'
  approval before merge. Load-bearing means the protocol, the on-disk format,
  cryptography, sync semantics, the threat model, licensing, release or signing
  tooling, or anything that changes a security claim.
- **Disagreement** is recorded on the issue. A change does not land while the
  maintainers disagree about whether it should.
- A maintainer does not approve their own pull request. A trivial fix (a typo,
  a broken link, a CI housekeeping change) may be pushed directly; anything a
  user can notice goes through review.

Myne also keeps a private decision log for design history. A reference such as
`decisions/protocol/0763` is an identifier for a private entry, not a path in
this repository (see [`AGENTS.md`](AGENTS.md) and
[`docs/README.md`](docs/README.md)). The public rationale for a change belongs
in its issue and pull request; when a private decision is relevant, the pull
request summarizes it.

## Review and merge

`develop` is the default branch and the integration branch. Changes land there
by pull request, and `develop` is not force-pushed. Review routing for
security-sensitive paths is in [`.github/CODEOWNERS`](.github/CODEOWNERS).
Every commit carries a `Signed-off-by` trailer and CI enforces it; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Releases and distribution

Myne is source-only. There are no tagged releases, no prebuilt binaries and no
app-store listings; build from source, as [`README.md`](README.md) describes.
Historical binaries are not maintained. [`SOURCE-OFFER.md`](SOURCE-OFFER.md)
says how to obtain the corresponding source for a binary distributed before
the source-only switch.

## Security and conduct

Report vulnerabilities to **security@myne.md** privately, never in a public
issue. [`SECURITY.md`](SECURITY.md) is the policy and carries the response
commitments. Participation is covered by
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md); concerns go through the channel it
names.

Do not paste vault content, an account number, a master password, a recovery
phrase, a token or a key into an issue, a discussion or a pull request.

## Discussions

GitHub Discussions is disabled at present. When it is enabled it is for
questions, ideas and show-and-tell: bug reports belong in issues, and
vulnerabilities go to security@myne.md. It is not a support channel for
third-party forks or modified builds. Maintainers may lock, convert or close a
thread that belongs in another channel, and an answer is not guaranteed. Until
it is enabled, the question issue template described in
[`SUPPORT.md`](SUPPORT.md) is the question channel.

## Continuity

The code is AGPL-3.0-only and the documentation is CC-BY-4.0, so a fork can
continue the work if the maintainers stop. A fork must use its own name and
marks; see [`TRADEMARK.md`](TRADEMARK.md).

## Changing this document

A governance change is a pull request against this file and needs both
maintainers' approval. The commit history is the record.
