// SPDX-License-Identifier: AGPL-3.0
//
// The join-a-vault-on-this-device DECISION both clients answer, in one place:
// which of the `identityHome.joinError*` messages a refused
// `sync_member_join_vault` earns.
//
// ## Why this is shared rather than duplicated
//
// It is the accept path's question with a DIFFERENT answer, which is exactly why a
// second copy would be wrong rather than redundant. `sync_member_join_vault` is
// reached by a member's SECOND device (myne-md/myne#852 task 7): the invite row it
// acts on is already claimed, there is no out-of-band owner code to collect, and
// `BadRequest` therefore no longer means "the pasted code did not verify" but "this
// device could not establish which owner to verify against". Copying
// `acceptInviteErrorKey` here would render, on every trust-anchor refusal, an
// instruction to paste a code the screen deliberately does not ask for. That is the
// myne-md/myne#794 failure one command over, and it is silent the same way: the
// union's arms are strings, and a `default` arm rendering a plausible sentence
// type-checks.
//
// Two clients ask it (desktop's `IdentityHome`, the phone's second-device flow),
// and `docs/decisions/clients/0488` is explicit that the SURFACES differ while the
// question does not.
//
// ## Entry criterion (`@myne/client-core/package.json` `"//"`)
//
// Met exactly: both clients answer the same question, and this module touches no
// host at all (`seam: null`): it reads a shape off an error and returns a string.
//
// **The binding is deliberately NOT here.** `personJoinVault` wraps `invoke`, which
// is host, so it stays per-client (`src/lib/personAccount.ts`,
// `mobile/src/lib/personAccount.ts`) where each client's own platform seam owns it.
//
// **No type is imported, on purpose.** `SyncDeviceError` has no shared TS mirror:
// `src/hooks/useEnroll.ts` and `src/hooks/useDevices.ts` each carry a private partial
// copy of the arms they read. Taking `unknown` and switching on `kind` is the
// established shape for this enum (`accept-invite.ts`), and it also means a payload
// that is not this enum at all lands on the generic sentence rather than throwing
// inside the mapper.

/**
 * The i18n key for a refused join, one arm per thing the user can act on.
 *
 * `Transport` is the arm that matters most and reads as copy rather than plumbing:
 * the recipient-scoped invite list and the person-addressed group package are both
 * relay reads, so an invite that has not reached this device yet, a group package
 * the owner has not published yet, and a busy unlock slot all arrive here, and all of
 * them succeed on a retry. The sentence says so, because the alternative is a user
 * concluding the vault is unreachable.
 *
 * `VaultAlreadyHeld` is its own arm because its remedy is the OPPOSITE of the
 * `BadRequest` one, and the two used to be the same refusal: this device already has
 * the vault, so there is nothing to add and nothing to fix. Folded in, one of the two
 * users is sent to do the wrong thing, which is the myne-md/myne#794 shape again.
 *
 * `BadRequest` deliberately does NOT distinguish a missing pin from a mismatched one
 * (`decisions/protocol/0672`, `0675`): both are the same user-visible fact, that this
 * device has no owner it can trust for this vault yet. The copy names the one thing
 * that fixes it, which is opening the vault once on a device that already has it.
 *
 * `NotEnrolled` covers both "no person identity is stored here" and "the phrase is
 * not this device's person", which are one sentence: the identity being asked for is
 * not the one the phrase carries.
 *
 * The KEY is returned rather than the copy, so this module freezes no language at module
 * scope (the module-level-data rule in `src/AGENTS.md`). It does NOT promise that the string
 * is resolved at render time, and a reader who takes that as a property of this module is
 * misled: BOTH callers resolve it at the event and hold the result in state (`IdentityHome`
 * and `IdentityFlow` each do `setX(t(key(error)))`), so a language switch does not
 * retranslate a banner already on screen. That is the app's behaviour for every error banner
 * and it belongs to the callers; this module's contribution is only that nothing here is
 * fixed to one language.
 */
export function memberJoinVaultErrorKey(error: unknown): string {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  switch (kind) {
    case "VaultAlreadyHeld":
      return "identityHome.joinErrorAlreadyHeld";
    case "BadRequest":
      return "identityHome.joinErrorBadRequest";
    case "NotEnrolled":
      return "identityHome.joinErrorNotEnrolled";
    case "NotConfigured":
      return "identityHome.joinErrorNotConfigured";
    case "Unauthenticated":
      return "identityHome.joinErrorUnauthenticated";
    case "Transport":
      return "identityHome.joinErrorTransport";
    default:
      return "identityHome.joinError";
  }
}
