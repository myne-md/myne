// The ONE presentation rule over a `ResolvedIdentity` (`member-devices` task 5).
//
// Two surfaces show a resolved author: the version-history list
// (`SnapshotsPanel`) and the live "who's here" roster (`WhoIsHereTab`, fed by
// `PaneView`'s resolver effect). Both READ the same backend resolver, but each
// used to string the three variants together by hand, and the two copies had
// already drifted: history said `Device {{code}}` and presence said the bare
// code, so the same unbound device was named two different ways on one screen.
// The rule lives here so they cannot contradict each other again.
//
// # The rule returns a DESCRIPTOR, not a string
//
// This is the `src/AGENTS.md` rule that module-level data stores i18n KEYS and
// resolves them at the consumer, and the store is where it bites here: the live
// roster's label is written into the MODULE-scope awareness store and the peer is
// marked attributed, so the entry is never rewritten. A resolved STRING there
// freezes the language that was active at the moment the peer appeared, and a
// later language switch leaves that one row in the old language until the peer
// leaves and rejoins. So the rule hands back `IdentityLabel` and every surface
// calls `identityLabelText` with the translator it holds at RENDER time.
//
// The distinction is not cosmetic. An arm that carries a NAME has nothing to
// translate: a person's chosen display string and a device's user-chosen label
// are the user's own words. The one arm that is OUR copy is the device fallback,
// and that is the one `identityLabelText` puts through `t`. Naming the union
// after that difference is what makes "which arms cost a translation" a question
// the type answers rather than a comment that can drift.
//
// # The label is a label, never evidence
//
// Nothing here decides WHOSE device this is. The backend resolver does the
// three-hop join (device id -> bound person -> roster verified -> the signed
// name row, `decisions/protocol/0669`) and hands back a closed variant; this
// module only chooses the copy for it. A `Person` name is the person's own
// chosen display string, not a proof of authorship, and no consumer may
// present it as one (`decisions/protocol/0660`).
//
// # Which copy this module owns, and which it does not
//
// The two surfaces disagree, deliberately and in words, about the ABSENT
// cases: the history list says "Unknown device" for a revision nobody could
// attribute, while the presence roster says "Someone" for a peer whose
// assertion did not verify. Returning `null` keeps that one decision per
// surface, where the surrounding sentence lives.
//
// The `device` arm is the opposite case, and the reason this module exists.
// That arm is where the two surfaces had ALREADY drifted (`Device {{code}}`
// against a bare code), so this module owns that copy and shares ONE key
// (`notes.snapshots.deviceFallback`) rather than returning `null` and letting
// each caller re-invent it. The key is named under the version-history
// namespace because that is where it was first written, and the presence
// roster reads it on purpose; moving it to a neutral namespace is a naming
// follow-up, not a correctness issue.

import type { TFunction } from "i18next";
import type { ResolvedIdentity } from "../../types/resolved-identity";

/**
 * A resolved label, held as data rather than as a rendered string, so a consumer
 * that stores it (the awareness store) cannot freeze a language.
 */
export type IdentityLabel =
  /** A label the USER authored: a person's chosen name, or a device's own
   *  user-chosen label. Rendered verbatim in every language. */
  | { kind: "text"; text: string }
  /** Our copy for a device with no user-chosen label: the six-character device
   *  code, interpolated into the one key above. */
  | { kind: "device"; code: string };

/**
 * The display label for a resolved identity, or `null` when no label can be
 * shown and the caller owes its own absent-copy.
 *
 * Order (`member-devices` task 5, and `0669` for the first arm):
 * an attributed person's own name; else the device's user-chosen label; else
 * the six-character device code, so a row is never blank; else `null` for
 * `Unknown` and for a name that is present but empty.
 */
export function resolvedIdentityLabel(identity: ResolvedIdentity): IdentityLabel | null {
  switch (identity.kind) {
    case "Person":
      return textLabel(identity.name);
    case "Device":
      return textLabel(identity.name) ?? { kind: "device", code: identity.code };
    case "Unknown":
      return null;
  }
}

/**
 * Render a label with the translator in hand at the moment of rendering. The ONE
 * place a label becomes a string, so a surface cannot pick half the rule.
 */
export function identityLabelText(label: IdentityLabel, t: TFunction): string {
  switch (label.kind) {
    case "text":
      return label.text;
    case "device":
      return t("notes.snapshots.deviceFallback", { code: label.code });
  }
}

/** A name-bearing label, or `null` for `null`, `undefined` and `""`: the three
 *  ways a name can be absent. */
function textLabel(name: string | null | undefined): IdentityLabel | null {
  return name !== null && name !== undefined && name.length > 0
    ? { kind: "text", text: name }
    : null;
}
