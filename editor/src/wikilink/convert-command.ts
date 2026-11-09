// R2 "Convert imported wikilinks in this note" — the command runtime (§7.1).
// Reads the active editor view + its WL-5 note-set, plans the conversion
// (`planWikilinkConversion`), shows a MANDATORY diff preview (cloned from the
// attachments diff-preview, §7.1 / WL-10) with an inline path picker for
// ambiguous links, and on confirm rewrites the active buffer in ONE undoable
// transaction. Buffer-only (SYNC-15 trivial); not a C1 violation (user-initiated
// + transparent). The picker emit uses the one `convertedLink`/`emitNoteWikilink`
// (WL-4); candidates come from the resolver (WL-3).

import type { EditorView } from "@codemirror/view";
import { ensureAttachmentInsertStyles, hasDom } from "../attachments/styles";
import { showAttachmentToast } from "../attachments/toast";
import { getActiveEditorView } from "../active-view";
import { readNoteSet } from "./note-set";
import { notePath } from "@myne/editor/host/notes/resolveWikilink";
import {
  convertedLink,
  planWikilinkConversion,
  type ConversionRow,
} from "./convert";
import type { ByteRange } from "@myne/dialect/types";
import i18n from "@myne/editor/i18n";
import { openModal } from "@myne/editor/host/lib/imperative-modal";

interface Rewrite {
  readonly byteRange: ByteRange;
  readonly after: string;
}

export interface ConvertPreviewResult {
  readonly confirmed: boolean;
  readonly rewrites: readonly Rewrite[];
}

/**
 * Show the R2 preview and resolve with the user's decision + the concrete
 * rewrites (rewrite rows + ambiguous rows the user resolved). No byte change
 * here — the caller applies on confirm. No-op `{confirmed:false}` without a DOM.
 */
export function showWikilinkConvertPreview(
  rows: readonly ConversionRow[],
): Promise<ConvertPreviewResult> {
  if (!hasDom()) return Promise.resolve({ confirmed: false, rewrites: [] });
  ensureAttachmentInsertStyles();

  return new Promise<ConvertPreviewResult>((resolve) => {
    const chosen = new Map<number, string>(); // ambiguous row index → noteUuid
    const ambiguousIdx = rows
      .map((r, i) => (r.kind === "ambiguous" ? i : -1))
      .filter((i) => i >= 0);
    const rewriteableCount = rows.filter((r) => r.kind !== "skipped").length;

    const cleanup = (confirmed: boolean): void => {
      host.close();
      resolve({ confirmed, rewrites: confirmed ? buildRewrites() : [] });
    };
    const host = openModal({
      backdropClass: "cm-attach-diff-backdrop",
      onDismiss: () => cleanup(false), // Esc / backdrop click = cancel
      onEnter: (e) => {
        if (!commitBtn.disabled) {
          e.preventDefault();
          cleanup(true);
        }
      },
    });
    const backdrop = host.backdrop;
    const modal = document.createElement("div");
    modal.className = "cm-attach-diff";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", i18n.t("editor.wikilink.convert.title"));

    const title = document.createElement("div");
    title.className = "cm-attach-diff-title";
    title.textContent = i18n.t("editor.wikilink.convert.title");
    modal.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "cm-attach-diff-subtitle";
    const needsChoice = ambiguousIdx.length;
    subtitle.textContent =
      rewriteableCount === 0
        ? i18n.t("editor.wikilink.convert.nothingToConvert")
        : i18n.t("editor.wikilink.convert.rewriteCount", { count: rewriteableCount }) +
          (needsChoice > 0
            ? i18n.t("editor.wikilink.convert.choiceClause", { count: needsChoice })
            : ".");
    modal.appendChild(subtitle);

    const list = document.createElement("div");
    list.className = "cm-attach-diff-list";

    const updateCommit = (): void => {
      commitBtn.disabled =
        rewriteableCount === 0 || ambiguousIdx.some((i) => !chosen.has(i));
    };

    rows.forEach((row, i) => {
      const rowEl = document.createElement("div");
      rowEl.className = "cm-attach-diff-row";
      const before = document.createElement("div");
      before.className = "cm-attach-diff-line cm-attach-diff-before";
      before.textContent = row.before;
      rowEl.append(before);

      if (row.kind === "rewrite") {
        const after = document.createElement("div");
        after.className = "cm-attach-diff-line cm-attach-diff-after";
        after.textContent = row.after;
        rowEl.append(after);
      } else if (row.kind === "skipped") {
        const skipped = document.createElement("div");
        skipped.className = "cm-attach-diff-skipped";
        skipped.textContent = i18n.t("editor.wikilink.convert.skipped", { reason: row.reason });
        rowEl.append(skipped);
      } else {
        // ambiguous — inline candidate picker (WL-10). Confirm gated until chosen.
        const select = document.createElement("select");
        select.style.fontFamily = "var(--font-mono)";
        select.style.fontSize = "12px";
        select.style.marginTop = "4px";
        select.style.maxWidth = "100%";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = i18n.t("editor.wikilink.convert.chooseTarget");
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);
        for (const cand of row.candidates) {
          const opt = document.createElement("option");
          opt.value = cand.noteUuid;
          opt.textContent = notePath(cand);
          select.appendChild(opt);
        }
        select.addEventListener("change", () => {
          if (select.value === "") chosen.delete(i);
          else chosen.set(i, select.value);
          updateCommit();
        });
        rowEl.append(select);
      }
      list.appendChild(rowEl);
    });
    modal.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "cm-attach-diff-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cm-attach-diff-btn";
    cancelBtn.textContent = i18n.t("common.cancel");
    const commitBtn = document.createElement("button");
    commitBtn.type = "button";
    commitBtn.className = "cm-attach-diff-btn cm-attach-diff-btn-primary";
    commitBtn.textContent = i18n.t("editor.wikilink.convert.convert");
    actions.append(cancelBtn, commitBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    updateCommit();

    const buildRewrites = (): Rewrite[] => {
      const out: Rewrite[] = [];
      rows.forEach((row, i) => {
        if (row.kind === "rewrite") {
          out.push({ byteRange: row.byteRange, after: row.after });
        } else if (row.kind === "ambiguous") {
          const pickedId = chosen.get(i);
          const note = row.candidates.find((n) => n.noteUuid === pickedId);
          if (note !== undefined) {
            out.push({ byteRange: row.byteRange, after: convertedLink(note, row.ref) });
          }
        }
      });
      return out;
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    commitBtn.addEventListener("click", () => {
      if (!commitBtn.disabled) cleanup(true);
    });
    // Trap + restore focus (MYND-93).
    host.installTrap(modal, rewriteableCount === 0 ? cancelBtn : commitBtn);
  });
}

/**
 * Apply the rewrites in ONE transaction (descending `from` so offsets stay
 * valid) — one undo step.
 *
 * `expectedSource` is the document the rewrites were PLANNED against
 * (myne#325). Every span is verified to still hold the exact bytes it was
 * planned from before anything is written; a span that moved or changed makes
 * the whole conversion decline.
 *
 * That check is the point of the function. The offsets are captured before an
 * untimed confirmation modal — it stays open until the user has picked a target
 * for every ambiguous row — and the note's bytes can change under it without
 * any user action: a sync pull, a snapshot restore, or a task written from a
 * list surface all call `reloadOpenNote`, and none of them are stopped by the
 * modal's focus trap.
 *
 * Applying unmapped offsets after that was silent corruption: if the document
 * GREW, every rewrite landed early — the original `[[Some Note]]` survived
 * untouched while a same-length span of unrelated prose was destroyed and
 * replaced, in one transaction, and autosaved on the next idle tick. The module
 * promises byte-preservation outside the matched ref spans, and the whole point
 * of the mandatory diff preview is that the user approves the edit they get.
 * If the document SHRANK, `ChangeSet.of` threw a `RangeError` inside the click
 * handler's promise chain, which nothing catches — no rewrite, no toast, no
 * error shown at all.
 *
 * Declining rather than re-mapping is deliberate: a mapped span would still be
 * the RIGHT position for a preview the user is no longer looking at. The
 * conversion is re-runnable and cheap, and re-reading the preview against the
 * document as it now stands is the only honest way to approve it.
 *
 * Returns whether the rewrites were applied.
 */
export function applyWikilinkRewrites(
  view: EditorView,
  rewrites: readonly Rewrite[],
  expectedSource?: string,
): boolean {
  if (rewrites.length === 0) return false;
  const doc = view.state.doc;
  if (expectedSource !== undefined) {
    for (const r of rewrites) {
      const { start, end } = r.byteRange;
      if (start < 0 || end > doc.length || start >= end) return false;
      if (doc.sliceString(start, end) !== expectedSource.slice(start, end)) return false;
    }
  }
  const ordered = [...rewrites].sort((a, b) => b.byteRange.start - a.byteRange.start);
  const changes = ordered.map((r) => ({
    from: r.byteRange.start,
    to: r.byteRange.end,
    insert: r.after,
  }));
  view.dispatch({ changes, userEvent: "wikilink.convert" });
  return true;
}

/** The R2 command entry point (called by the disabled-no-more palette action). */
export async function runWikilinkConvert(): Promise<void> {
  const view = getActiveEditorView();
  if (view === null) return;
  // The document the plan is taken against — and the one every rewrite is
  // verified against after the modal closes (myne#325).
  const planned = view.state.doc.toString();
  const rows = planWikilinkConversion(planned, readNoteSet(view.state));
  if (rows.length === 0) {
    showAttachmentToast(i18n.t("editor.wikilink.convert.noneToConvert"));
    return;
  }
  const { confirmed, rewrites } = await showWikilinkConvertPreview(rows);
  if (!confirmed || rewrites.length === 0) return;
  if (!applyWikilinkRewrites(view, rewrites, planned)) {
    // The note changed under the modal, so the preview no longer describes the
    // edit that would be written. Say so instead of writing something else.
    showAttachmentToast(i18n.t("editor.wikilink.convert.staleDocument"), "error");
    return;
  }
  view.focus();
  const n = rewrites.length;
  showAttachmentToast(i18n.t("editor.wikilink.convert.convertedToast", { count: n }), "success");
}
