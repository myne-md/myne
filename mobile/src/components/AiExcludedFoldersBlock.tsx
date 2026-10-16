// The AI excluded-folders control on mobile (local-ai epic MYND-408, reached
// this client in myne-md/myne#880).
//
// # Why this block exists
//
// `ai_excluded_folders` is the list the AI REFUSAL PATH honours: the core calls
// `hooks.ai_policy_changed(view.ai_enabled, &view.ai_excluded_folders)` and
// every AI surface short-circuits through the shared predicate
// (`src/lib/aiExcludedFolders.ts::isNoteAiExcluded`, the frontend mirror of the
// Rust `folder_matches_excluded`). This client already ENFORCED it and reported
// the count; it could not AUTHOR it. So the control that decides where AI may
// read was authored only from a computer, which is the shape this row closes.
//
// # Verbs, not a whole set, and that is a correctness requirement
//
// The write is a set-union mutation (`SetMutation`), never the whole list. The
// sync stamper derives removals from `before \ after`, so a caller holding a
// stale view would claim a deletion it never made and travel it to every device.
// `mutationFrom(before, after)` derives the verbs from the CALLER'S OWN two
// values, so an entry the caller never saw is in neither and is claimed by
// neither. That is also what makes a concurrent desktop addition survive a phone
// write that removes a different folder.
//
// # Monotone by classification, and deliberately so
//
// `sync-protocol.md` §10.2 classifies this field
// `SetUnion { folded: true, removals_propagate: false }`: it is an egress
// control rather than a preference, so an exclusion present on ANY device
// survives every merge. The consequence is a product limitation worth stating
// rather than hiding: removing an exclusion means removing it everywhere, or the
// peer's copy comes straight back. The block says so instead of implying a
// local removal.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TextField } from "./inputs";
import { mutateAiExcludedFolders, mutationFrom } from "../lib/prefs";

const ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  padding: "var(--space-3)",
  borderTop: "1px solid var(--line-1)",
} as const;

const GROUP_STYLE = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
} as const;

const HINT_STYLE = {
  marginTop: "var(--space-3)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
} as const;

const ADD_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
} as const;

// The platform's minimum touch target, `--m-touch` (myne-md/myne#867 review,
// D6): a bare text control is only as tall as one line of small text, a
// roughly 12px target for the one press that saves or removes. The glyph stays
// where it was; the box around it grows.
const REMOVE_STYLE = {
  background: "none",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  padding: 0,
  minWidth: "var(--m-touch)",
  minHeight: "var(--m-touch)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

const ADD_STYLE = {
  background: "none",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  color: "var(--fg-1)",
  cursor: "pointer",
  padding: "var(--space-2) var(--space-3)",
} as const;

/** The next set, and the verbs that take the caller there from `before`.
 *
 *  **Already excluded is not an edit.** Appending it again would commit a
 *  duplicate, and the list renders one row per entry, so the duplicate is two
 *  rows with one key and one testid. The desktop twin's picker guards this
 *  (`AiPanel.appendExcludedFolder`: "already excluded: not a no-op to say so
 *  twice"), and the typed box here needs it for the same reason.
 */
export function excludeFolder(before: readonly string[], folder: string): string[] {
  const clean = folder.trim();
  if (!clean || before.includes(clean)) return [...before];
  return [...before, clean];
}

export function includeFolder(before: readonly string[], folder: string): string[] {
  return before.filter((f) => f !== folder);
}

export function AiExcludedFoldersBlock({
  folders,
  onToast,
}: {
  folders: readonly string[];
  /** The sheet's toast. A failed write here is REPORTED rather than swallowed:
   *  `ai_excluded_folders` is the AI egress control, so a user who believes they
   *  excluded a folder while `vault.prefs` still holds the old set has been told
   *  something false about where AI may read. The desktop twin reports the same
   *  failure through `usePrefs`'s `onShowToast`. */
  onToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  /** Commit one desired next-set, sending the VERBS derived from the caller's
   *  own before and after. */
  const commit = (next: string[]) => {
    if (next.length === folders.length && next.every((f, i) => f === folders[i])) return;
    void mutateAiExcludedFolders(mutationFrom(folders, next)).catch(() => {
      // The rendered list comes from `folders`, which a failed write leaves
      // unchanged, so the UI already shows disk truth. What it cannot show is
      // that the write did not land, and that is what the toast is for.
      onToast?.(t("settings.saveSettingError"));
    });
  };

  const add = () => {
    const next = excludeFolder(folders, draft);
    // Cleared either way: leaving a duplicate in the box would make the control
    // look like it had accepted something.
    setDraft("");
    if (next.length === folders.length) return;
    commit(next);
  };

  return (
    <div data-testid="settings.aiExcludedFolders">
      <div style={HINT_STYLE}>{t("settings.ai.excludedFoldersHelper")}</div>
      {folders.length === 0 ? (
        <div style={HINT_STYLE} data-testid="settings.aiExcludedFolders.empty">
          {t("settings.ai.excludedFoldersEmpty")}
        </div>
      ) : (
        <div style={GROUP_STYLE}>
          {folders.map((folder, index) => (
            <div
              key={folder}
              style={{ ...ROW_STYLE, borderTop: index === 0 ? "none" : ROW_STYLE.borderTop }}
              data-testid={`settings.aiExcludedFolders.row-${folder}`}
            >
              <span>{folder}</span>
              <button
                type="button"
                data-testid={`settings.aiExcludedFolders.remove-${folder}`}
                aria-label={t("settings.ai.excludedFoldersRemoveLabel", { folder })}
                onClick={() => commit(includeFolder(folders, folder))}
                style={REMOVE_STYLE}
              >
                {t("settings.ai.excludedFoldersRemove")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={ADD_ROW_STYLE}>
        <TextField
          testId="settings.aiExcludedFolders.add"
          label={t("settings.ai.excludedFoldersAddLabel")}
          value={draft}
          onChange={setDraft}
          onEnter={add}
          style={{ background: "var(--bg-2)", flex: 1 }}
        />
        <button
          type="button"
          data-testid="settings.aiExcludedFolders.add-commit"
          onClick={add}
          style={ADD_STYLE}
        >
          {t("settings.ai.excludedFoldersAdd")}
        </button>
      </div>
      {/* The monotone-union consequence, stated rather than implied: an
          exclusion present on any device survives every merge, so removing one
          means removing it everywhere. */}
      <div style={HINT_STYLE} data-testid="settings.aiExcludedFolders.monotone-notice">
        {t("settings.ai.excludedFoldersMonotoneNotice")}
      </div>
    </div>
  );
}
