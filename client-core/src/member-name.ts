// SPDX-License-Identifier: AGPL-3.0
//
// The member display-name WRITE decision both clients answer, in one place: which
// of the `sync.memberRoster.nameError*` messages a refused
// `plugin:member-names|member_names_set_mine` earns.
//
// ## Why this is shared rather than duplicated
//
// The mirror it reads (`@myne/client-core/types/member-names-error`) is a closed
// enum, and the store behind it is the SAME `myne-core` codec on both clients, so
// "which refusal was that" is one question with one answer. A per-client copy of a
// six-arm switch over a closed enum is a second place the answer can be lost, and it
// is lost SILENTLY: every arm the second copy forgets falls through to the generic
// message, which still renders a plausible sentence. myne-md/myne#794 is the recorded
// instance of that class on the accept path; this is the same shape one command over.
//
// Two clients ask it today, and the surfaces differ per
// `decisions/clients/0488` while the QUESTION does not: desktop's
// `MemberRosterPanel` row editor and `MemberNameGate`, and the phone's onboarding
// name step (myne-md/myne#851 task 15).
//
// ## Entry criterion (`@myne/client-core/package.json` `"//"`)
//
// Met exactly: both clients answer the same question, and this module touches no host
// at all (`seam: null`): it reads a shape off an error and returns a string.
//
// **The binding is deliberately NOT here.** `setMyMemberName` wraps `invoke`, which
// is host, so it stays per-client (`src/lib/memberNames.ts`,
// `mobile/src/lib/memberNames.ts`) where each client's own platform seam owns it.

import type { MemberNamesError } from "./types/member-names-error";

/**
 * The i18n key for a name-writer failure, one arm per thing the user can act on, so
 * "that name is empty" and "the name store is damaged on this device" never read the
 * same.
 *
 * `NotASharedVault` is unreachable through the onboarding gate (it runs only after an
 * accept landed a shared vault) and is mapped anyway rather than folded into the
 * generic arm: a refusal that reaches the user should say which refusal it was. The
 * desktop row editor can reach it, since the same panel renders on a pre-B2B vault.
 *
 * The key is returned rather than the copy, so the caller resolves it at render time
 * and a language switch re-renders (the module-level-data rule in `src/AGENTS.md`).
 */
export function memberNameErrorKey(error: unknown): string {
  const kind = (error as Partial<MemberNamesError> | null)?.kind;
  switch (kind) {
    case "NameEmpty":
      return "sync.memberRoster.nameErrorEmpty";
    case "NameTooLong":
      return "sync.memberRoster.nameErrorTooLong";
    case "StoreUnreadable":
      return "sync.memberRoster.nameErrorUnreadable";
    case "NotASharedVault":
      return "sync.memberRoster.nameErrorUnshared";
    case "SlotNotUnlocked":
      return "sync.memberRoster.nameErrorLocked";
    default:
      return "sync.memberRoster.nameErrorGeneric";
  }
}
