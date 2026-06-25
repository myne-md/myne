// Mandatory diff-preview modal for import-&-convert (epic MYND-164,
// sub-feature attachment-insert; decision 5, wikilink R2 parity per
// `spec/wikilink.md` §7.1).
//
// R2 mutates note bytes but is NOT a C1 violation precisely because it is
// post-import, user-initiated, AND transparent — a diff preview before commit.
// This module renders that preview as a vanilla-DOM modal (same posture as the
// slash menu / toast: appended to `document.body`, styled by the shared sheet)
// and resolves a Promise with the user's decision. NO byte change happens here;
// the caller (`convert.ts`) applies the rewrite only on `confirm`.

import i18n from "../../i18n";
import { ensureAttachmentInsertStyles, hasDom } from "./styles";

/** One line in the preview: a proposed rewrite, or a skipped ref. */
export type DiffPreviewRow =
  | { readonly kind: "rewrite"; readonly before: string; readonly after: string }
  | { readonly kind: "skipped"; readonly before: string; readonly note: string };

export interface DiffPreviewResult {
  /** `true` = commit the rewrites; `false` = cancel (no byte change). */
  readonly confirmed: boolean;
}

/**
 * Show the diff preview and resolve when the user confirms or cancels.
 * `rewriteCount` is how many rows are actual rewrites — the primary button is
 * disabled when it is 0 (nothing to commit; the user can only cancel). No-op
 * resolve `{confirmed:false}` without a DOM (node test env).
 */
export function showDiffPreview(
  rows: readonly DiffPreviewRow[],
  rewriteCount: number,
): Promise<DiffPreviewResult> {
  if (!hasDom()) {
    return Promise.resolve({ confirmed: false });
  }
  ensureAttachmentInsertStyles();

  return new Promise<DiffPreviewResult>((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "cm-attach-diff-backdrop";

    const modal = document.createElement("div");
    modal.className = "cm-attach-diff";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", i18n.t("editor.attachment.convert.title"));

    const title = document.createElement("div");
    title.className = "cm-attach-diff-title";
    title.textContent = i18n.t("editor.attachment.convert.title");
    modal.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "cm-attach-diff-subtitle";
    subtitle.textContent =
      rewriteCount === 0
        ? i18n.t("editor.attachment.convert.subtitleEmpty")
        : i18n.t("editor.attachment.convert.subtitle", { count: rewriteCount });
    modal.appendChild(subtitle);

    const list = document.createElement("div");
    list.className = "cm-attach-diff-list";
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "cm-attach-diff-row";
      if (row.kind === "rewrite") {
        const before = document.createElement("div");
        before.className = "cm-attach-diff-line cm-attach-diff-before";
        before.textContent = row.before;
        const after = document.createElement("div");
        after.className = "cm-attach-diff-line cm-attach-diff-after";
        after.textContent = row.after;
        rowEl.append(before, after);
      } else {
        const before = document.createElement("div");
        before.className = "cm-attach-diff-line cm-attach-diff-before";
        before.textContent = row.before;
        const skipped = document.createElement("div");
        skipped.className = "cm-attach-diff-skipped";
        skipped.textContent = i18n.t("editor.attachment.convert.skipped", { note: row.note });
        rowEl.append(before, skipped);
      }
      list.appendChild(rowEl);
    }
    modal.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "cm-attach-diff-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cm-attach-diff-btn";
    cancelBtn.textContent = i18n.t("editor.attachment.convert.cancel");
    const commitBtn = document.createElement("button");
    commitBtn.type = "button";
    commitBtn.className = "cm-attach-diff-btn cm-attach-diff-btn-primary";
    commitBtn.textContent = i18n.t("editor.attachment.convert.confirm");
    commitBtn.disabled = rewriteCount === 0;
    actions.append(cancelBtn, commitBtn);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const cleanup = (confirmed: boolean): void => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve({ confirmed });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter" && rewriteCount > 0) {
        e.preventDefault();
        cleanup(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) cleanup(false); // backdrop click = cancel
    });
    cancelBtn.addEventListener("click", () => cleanup(false));
    commitBtn.addEventListener("click", () => cleanup(true));

    // Focus the safe default (Cancel when nothing to commit, else Convert).
    (rewriteCount === 0 ? cancelBtn : commitBtn).focus();
  });
}
