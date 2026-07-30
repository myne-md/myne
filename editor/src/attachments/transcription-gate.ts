// Whether speech-to-text is offered on audio attachments (MYND-592).
//
// A facet of its own rather than a reuse of `aiSlashEnabledFacet`, for two
// reasons that both matter:
//
//   1. **Different switch.** Transcription ships a bundled model, runs entirely
//      on-device and does one bounded thing the user asks for a file at a time.
//      It is a product feature, not part of the AI beta opt-in, and gating it
//      on `ai_enabled` meant turning the AI beta off silently killed it.
//
//   2. **Different scope.** `aiSlashEnabledFacet` folds in the
//      AI-excluded-folder rule, which is about ambient *reading* of note
//      content. Transcribing an attachment is an explicit per-file action, so a
//      folder being excluded from AI reading must not remove the affordance —
//      the Attachments Library reached the same conclusion independently (a
//      library attachment has no single folder to exclude by).
//
// **Defaults to `true`**, matching the preference: the base build offers
// transcription unless the host explicitly says otherwise. Note this is the
// opposite default from the AI facet, and deliberately so — that one is an
// opt-in, this one is an opt-out.
//
// This gate is DISCOVERY, not enforcement. The host re-reads the persisted
// preference at the top of `transcribe` before it decrypts anything, so a
// WebView that ignores this facet gains nothing.

import { Facet } from "@codemirror/state";

export const transcriptionEnabledFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length > 0 ? values[values.length - 1]! : true),
});
