// In-flight progress chip for attachment render/import (epic MYND-164,
// editor-side dogfooding polish, fix #4).
//
// REPLACES the previous struck/tombstone-borrowing loading style. While an
// attachment is in flight — importing/encrypting at the cursor (paste→stored),
// or loading/decrypting on first render (`attachment://` decrypt) — show a
// CLEAN inline progress chip: a quiet label plus an unobtrusive indeterminate
// hairline. It must read as "in progress", clearly distinct from the
// deleted/broken tombstone (which is muted/struck or danger-tinted).
//
// No spinner cliché, no struck text, no danger/tombstone styling. The animated
// hairline is pure CSS (theme.ts `.cm-attachment-progress-bar`); this module
// only composes the DOM.

import i18n from "@myne/editor/i18n";
import { ensureAttachmentInsertStyles } from "./styles";

/** The three in-flight states the chip can name. */
export type ProgressKind = "importing" | "encrypting" | "loading";

/** The quiet label shown for each in-flight state. */
export function progressLabel(kind: ProgressKind): string {
  switch (kind) {
    case "importing":
      return i18n.t("editor.attachment.progress.importing");
    case "encrypting":
      return i18n.t("editor.attachment.progress.encrypting");
    case "loading":
      return i18n.t("editor.attachment.progress.loading");
  }
}

/** Build the clean progress chip DOM: a quiet label + an indeterminate
 *  hairline. Shared by the CM widget and the optimistic insert placeholder so
 *  the two surfaces are visually identical. */
export function makeProgressChip(kind: ProgressKind): HTMLElement {
  // The indeterminate-hairline @keyframes + reduced-motion rule live in the
  // shared global sheet (can't live in EditorView.theme); ensure it's present.
  ensureAttachmentInsertStyles();

  const chip = document.createElement("span");
  chip.className = "cm-attachment-progress";
  chip.setAttribute("role", "status");
  chip.setAttribute("aria-live", "polite");
  chip.setAttribute("aria-label", progressLabel(kind));

  const label = document.createElement("span");
  label.className = "cm-attachment-progress-label";
  label.textContent = progressLabel(kind);
  chip.appendChild(label);

  // Indeterminate hairline — a subtle animated track (NOT a spinner). The
  // moving segment is a CSS ::after on the track.
  const track = document.createElement("span");
  track.className = "cm-attachment-progress-bar";
  track.setAttribute("aria-hidden", "true");
  chip.appendChild(track);

  return chip;
}
