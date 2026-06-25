// A minimal text-input prompt modal for the editor file-card Rename action
// (MYND-173). Vanilla DOM mounted to `document.body` — the same posture as the
// attachment lightbox / toast / diff-preview surfaces.
//
// Why not `window.prompt`: the Tauri WebView no-ops `window.prompt` (it returns
// `null`), so the file-card's Rename appeared to do nothing. This is the
// in-WebView replacement: a focused input with Rename / Cancel, Enter to
// commit, Esc / backdrop to cancel. Resolves to the entered string, or `null`
// when cancelled.

import i18n from "../../i18n";

/** Open the rename prompt seeded with `currentValue`. Resolves to the entered
 *  value (Rename / Enter) or `null` (Cancel / Esc / backdrop). No-op without a
 *  DOM (node test env) → resolves `null`. */
export function promptForName(currentValue: string): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(input.value);
      }
    };

    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0, 0, 0, 0.32)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "1300",
    });
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) finish(null);
    });

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", i18n.t("editor.attachment.rename.title"));
    dialog.setAttribute("data-testid", "attachment-rename");
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
    label.textContent = i18n.t("editor.attachment.rename.title");
    Object.assign(label.style, {
      fontSize: "13px",
      fontWeight: "600",
      color: "var(--fg-1, #1a1a17)",
      marginBottom: "10px",
    });

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentValue;
    input.setAttribute("data-testid", "attachment-rename.input");
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
    cancel.textContent = i18n.t("editor.attachment.rename.cancel");
    cancel.setAttribute("data-testid", "attachment-rename.cancel");
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
    confirm.textContent = i18n.t("editor.attachment.rename.confirm");
    confirm.setAttribute("data-testid", "attachment-rename.confirm");
    Object.assign(confirm.style, {
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
      fontWeight: "500",
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
    document.body.append(backdrop);

    document.addEventListener("keydown", onKey, true);
    input.focus();
    input.select();
  });
}
