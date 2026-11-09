// A minimal text-input prompt modal for the editor attachment surfaces
// (MYND-173). Vanilla DOM mounted to `document.body` — the same posture as the
// attachment lightbox / toast / diff-preview surfaces.
//
// PARAMETERISED, not rename-only (myne#409). It started as the file card's
// Rename prompt with its title, confirm label and testids hardcoded. The embed
// layout menu then reused it for "Custom size…" and "Edit alt text…", which
// silently titled both dialogs "Rename attachment": including the
// `role="dialog"` accessible name, so a screen-reader user was told they were
// renaming a file while typing alt text: and gave all three the same testids,
// so no test could tell them apart.
//
// Why not `window.prompt`: the Tauri WebView no-ops `window.prompt` (it returns
// `null`), so the file-card's Rename appeared to do nothing. This is the
// in-WebView replacement: a focused input with Rename / Cancel, Enter to
// commit, Esc / backdrop to cancel. Resolves to the entered string, or `null`
// when cancelled.

import i18n from "@myne/editor/i18n";
import { openModal } from "@myne/editor/host/lib/imperative-modal";

/** How one text prompt names itself. Every field is required: a prompt with a
 *  borrowed title is the bug this interface exists to prevent. */
export interface TextPromptCopy {
  /** i18n key for the dialog's heading AND its accessible name. */
  readonly titleKey: string;
  /** i18n key for the confirm button. */
  readonly confirmKey: string;
  /** `data-testid` stem: the dialog, plus `.input` / `.cancel` / `.confirm`. */
  readonly testidPrefix: string;
}

const RENAME_COPY: TextPromptCopy = {
  titleKey: "editor.attachment.rename.title",
  confirmKey: "common.rename",
  testidPrefix: "attachment-rename",
};

/** Open the rename prompt seeded with `currentValue`. Resolves to the entered
 *  value (Rename / Enter) or `null` (Cancel / Esc / backdrop). No-op without a
 *  DOM (node test env) → resolves `null`. */
export function promptForName(currentValue: string): Promise<string | null> {
  return promptForText(currentValue, RENAME_COPY);
}

/** Open a text prompt that names itself through `copy`. Same resolution
 *  contract as {@link promptForName}: the entered string, or `null` on cancel.
 *  An empty string is a REAL value and is NOT a cancellation. */
export function promptForText(
  currentValue: string,
  copy: TextPromptCopy,
): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };

    const modal = openModal({
      backdropStyle: {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "1300",
      },
      onDismiss: () => finish(null),
      onEnter: (e) => {
        e.preventDefault();
        e.stopPropagation();
        finish(input.value);
      },
    });
    const backdrop = modal.backdrop;

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", i18n.t(copy.titleKey));
    dialog.setAttribute("data-testid", copy.testidPrefix);
    Object.assign(dialog.style, {
      width: "360px",
      maxWidth: "90vw",
      padding: "16px",
      background: "var(--paper, #faf8f3)",
      border: "1px solid var(--line-2, #c8c7c1)",
      borderRadius: "var(--radius-3, 8px)",
      boxShadow: "var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12))",
      fontFamily: "var(--font-sans)",
    });

    const label = document.createElement("div");
    label.textContent = i18n.t(copy.titleKey);
    Object.assign(label.style, {
      fontSize: "13px",
      fontWeight: "var(--weight-semibold)",
      color: "var(--fg-1, #1a1a17)",
      marginBottom: "10px",
    });

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentValue;
    input.setAttribute("data-testid", `${copy.testidPrefix}.input`);
    Object.assign(input.style, {
      width: "100%",
      boxSizing: "border-box",
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
      color: "var(--fg-1, #1a1a17)",
      background: "var(--bg-1, #fff)",
      border: "1px solid var(--accent, #2c4a7a)",
      borderRadius: "var(--radius-1, 4px)",
      padding: "6px 8px",
      outline: "none",
    });

    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "12px",
    });

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = i18n.t("common.cancel");
    cancel.setAttribute("data-testid", `${copy.testidPrefix}.cancel`);
    Object.assign(cancel.style, {
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
      padding: "6px 12px",
      borderRadius: "var(--radius-1, 4px)",
      border: "1px solid var(--line-2, #c8c7c1)",
      background: "transparent",
      color: "var(--fg-1, #1a1a17)",
      cursor: "pointer",
    });
    cancel.addEventListener("click", () => finish(null));

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = i18n.t(copy.confirmKey);
    confirm.setAttribute("data-testid", `${copy.testidPrefix}.confirm`);
    Object.assign(confirm.style, {
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
      fontWeight: "var(--weight-medium)",
      padding: "6px 12px",
      borderRadius: "var(--radius-1, 4px)",
      border: "1px solid var(--accent, #2c4a7a)",
      background: "var(--accent, #2c4a7a)",
      color: "var(--accent-on, #fff)",
      cursor: "pointer",
    });
    confirm.addEventListener("click", () => finish(input.value));

    row.append(cancel, confirm);
    dialog.append(label, input, row);
    backdrop.append(dialog);

    // Trap + restore focus (MYND-93).
    modal.installTrap(dialog, input);
    input.select();
  });
}
