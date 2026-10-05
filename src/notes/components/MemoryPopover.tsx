// Memory popover: the discoverable half of the memory surface
// (myne-md/myne#697, Q7). The settings panel is the complete half
// (list/edit/delete/clear/personality); this popover shows the live memory
// beside the conversation the wrong answer came from, with per-entry delete
// and a link into Settings for the rest.
//
// Mounted in the chat header, tab-local boolean like the history modal, so
// every opening re-fetches the roster rather than showing a stale list.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  memoryDelete,
  memoryList,
  memoryRead,
  type MemoryListRow,
} from "../../lib/memory";

const OVERLAY_STYLE: CSSProperties = {
  position: "absolute",
  // The popover is anchored to the memory button (a `position: relative`
  // wrapper in the chat header), so it opens DOWNWARD from the header into the
  // chat area. The old `bottom: 100%` opened upward, which worked only because
  // the popover used to live near the composer at the bottom of the tab.
  top: "100%",
  right: 0,
  marginTop: "var(--space-1)",
  zIndex: 30,
  width: 300,
  // The right panel narrows below 300px on small viewports: without this cap
  // the overlay spills past the viewport edge and its own Close button stops
  // being hit-testable (myne-md/myne#697 review). The cap keeps every control
  // inside the clickable area.
  maxWidth: "calc(100vw - 24px)",
  // Viewport-capped: a short window still fits the whole overlay, and the
  // roster scrolls inside while the Close row stays pinned (see SCROLL_STYLE
  // / FOOTER_STYLE below).
  maxHeight: "min(320px, calc(100vh - 96px))",
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  padding: "var(--space-2)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  flexShrink: 0,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
};

const TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const SMALL_BUTTON_STYLE: CSSProperties = {
  font: "inherit",
  fontSize: "var(--text-xs)",
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  cursor: "pointer",
  alignSelf: "flex-start",
};

export function MemoryPopover(props: {
  onClose: () => void;
  onOpenSettings: () => void;
  onShowToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MemoryListRow[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loadFailed, setLoadFailed] = useState(false);
  // Per-entry read failures, by id: a corrupt entry renders as unreadable,
  // never as a blank row (report-don't-empty applies per row, not just to
  // the roster: a blank row with a working Delete is indistinguishable from
  // an empty entry).
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management, the MemorySheet twin's posture: focus the dialog on
  // open, return focus to the memory button on close, Escape closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
    // Mount/unmount only: onClose identity must not re-run the teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await memoryList();
      setRows(list);
      const next: Record<string, string> = {};
      const failed = new Set<string>();
      for (const row of list) {
        try {
          next[row.id] = await memoryRead(row.id);
        } catch {
          failed.add(row.id);
        }
      }
      setTexts(next);
      setFailedIds(failed);
      setLoadFailed(false);
    } catch {
      // Report, never collapse to empty (§9.25.3 report-don't-empty): the
      // panel offers deletes over the store it just failed to read, so a
      // failed read must not look like an empty roster.
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div
      style={{ position: "relative" }}
      data-testid="ai.memory-popover-anchor"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t("editor.chrome.rightPanel.aiChat.memoryPopoverTitle")}
        tabIndex={-1}
        style={{ ...OVERLAY_STYLE }}
        data-testid="ai.memory-popover"
      >
        <div style={SCROLL_STYLE}>
          <div
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-medium)",
              color: "var(--fg-3)",
            }}
          >
            {t("editor.chrome.rightPanel.aiChat.memoryPopoverTitle")}
          </div>
          {loadFailed ? (
            <div>
              <p data-testid="ai.memory-popover-load-failed" style={TEXT_STYLE}>
                {t("editor.chrome.rightPanel.aiChat.memoryPopoverLoadFailed")}
              </p>
              <button
                type="button"
                data-testid="ai.memory-popover-retry"
                style={SMALL_BUTTON_STYLE}
                onClick={() => void reload()}
              >
                {t("editor.chrome.rightPanel.aiChat.memoryPopoverRetry")}
              </button>
            </div>
          ) : rows === null ? null : rows.length === 0 ? (
            <p data-testid="ai.memory-popover-empty" style={TEXT_STYLE}>
              {t("editor.chrome.rightPanel.aiChat.memoryPopoverEmpty")}
            </p>
          ) : (
            rows.slice(0, 8).map((row) => (
              <div key={row.id} style={ROW_STYLE} data-testid="ai.memory-popover-row">
                {failedIds.has(row.id) ? (
                  <p style={TEXT_STYLE} data-testid="ai.memory-popover-row-unreadable">
                    {t("editor.chrome.rightPanel.aiChat.memoryPopoverEntryFailed")}
                  </p>
                ) : (
                  <p style={TEXT_STYLE}>{texts[row.id] ?? ""}</p>
                )}
                <button
                  type="button"
                  data-testid="ai.memory-popover-delete"
                  onClick={() => {
                    void memoryDelete(row.id)
                      .then(() => {
                        props.onShowToast(
                          t("editor.chrome.rightPanel.aiChat.memoryPopoverDeleted"),
                        );
                        void reload();
                      })
                      .catch(() => {
                        props.onShowToast(
                          t("editor.chrome.rightPanel.aiChat.memoryPopoverDeleteFailed"),
                        );
                      });
                  }}
                  style={SMALL_BUTTON_STYLE}
                >
                  {t("editor.chrome.rightPanel.aiChat.memoryPopoverDelete")}
                </button>
              </div>
            ))
          )}
        </div>
        <div style={FOOTER_STYLE}>
          <button
            type="button"
            data-testid="ai.memory-popover-settings"
            onClick={props.onOpenSettings}
            style={SMALL_BUTTON_STYLE}
          >
            {t("editor.chrome.rightPanel.aiChat.memoryPopoverSettings")}
          </button>
          <button
            type="button"
            data-testid="ai.memory-popover-close"
            onClick={props.onClose}
            style={SMALL_BUTTON_STYLE}
          >
            {t("editor.chrome.rightPanel.aiChat.memoryPopoverClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
