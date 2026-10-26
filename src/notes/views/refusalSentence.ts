// One sentence per host refusal, for every surface that reports a partial
// result (view-manifests task 10, extended by the board's drag in myne-md/myne#922).
//
// The mapping is EXHAUSTIVE over the mirror, so a new refusal variant is a
// compile error here rather than a silent generic line: the whole point of a
// per-note report is that the reader learns what to redo. That exhaustiveness is
// also why this is one module rather than a helper per surface: the table's bulk
// action and the board's drag report the SAME host refusals, and two copies of a
// closed mapping diverge the moment a variant is added to one of them.
//
// The caller passes `t` rather than this module importing i18n, so it stays a
// pure function and both surfaces resolve the string in their own render.

import type { NoteSetFieldError } from "../../types/note-set-field-error";

export function refusalSentence(
  reason: NoteSetFieldError,
  t: (key: string) => string,
): string {
  switch (reason.kind) {
    case "VaultLocked":
      return t("notes.views.bulk.refusedVaultLocked");
    case "InvalidNoteId":
      return t("notes.views.bulk.refusedInvalidNoteId");
    case "NoteNotFound":
      return t("notes.views.bulk.refusedNoteNotFound");
    case "CannotDecrypt":
      return t("notes.views.bulk.refusedCannotDecrypt");
    case "NotApproved":
      return t("notes.views.bulk.refusedNotApproved");
    case "FieldNotDeclared":
      return t("notes.views.bulk.refusedFieldNotDeclared");
    case "FieldReserved":
      return t("notes.views.bulk.refusedFieldReserved");
    case "FieldChanged":
      return t("notes.views.bulk.refusedFieldChanged");
    case "InvalidField":
      return t("notes.views.bulk.refusedInvalidField");
    case "ValueTooLarge":
      return t("notes.views.bulk.refusedValueTooLarge");
    case "LiveSessionOpen":
      return t("notes.views.bulk.refusedLiveSessionOpen");
    case "PrefsUnreadable":
      return t("notes.views.bulk.refusedPrefsUnreadable");
    case "Io":
      return t("notes.views.bulk.refusedIo");
    case "JoinFailure":
      return t("notes.views.bulk.refusedJoinFailure");
  }
}
