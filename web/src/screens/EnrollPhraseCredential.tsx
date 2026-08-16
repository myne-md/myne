// The web build's substitute for the enrolment phrase grid
// (phase3-web-client task 32).
//
// Renders nothing, and is never rendered: `EnrollDeviceForm` omits the
// recovery-phrase credential where `phraseEnrolment` is absent, so this branch is
// unreachable on web. It exists so the **grid itself is not in the bundle** —
// `decisions.md` 2026-07-26 forbids the phrase from being typed into served
// code, and `scripts/check-web-no-phrase.mjs` reads the built artefact to prove
// it, which a runtime gate could not satisfy.
//
// Typed identically to the module it replaces so the substitution is invisible
// to the caller and `tsc` still checks the call site.

import { type ChangeEvent, type ClipboardEvent } from "react";

export const PHRASE_CELL_COUNT = 24;

export interface EnrollPhraseCredentialProps {
  baseId: string;
  cells: string[];
  onCellChange: (index: number) => (e: ChangeEvent<HTMLInputElement>) => void;
  onCellPaste: (index: number) => (e: ClipboardEvent<HTMLInputElement>) => void;
}

export function EnrollPhraseCredential(_props: EnrollPhraseCredentialProps) {
  return null;
}
