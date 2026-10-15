// Memory popover: the discoverable half of the memory surface
// (myne-md/myne#697, Q7). The settings panel is the complete half
// (list/edit/delete/clear/personality); this popover shows the live memory
// beside the conversation the wrong answer came from, with per-entry delete
// and a link into Settings for the rest.
//
// Mounted in the chat header, tab-local boolean like the history modal, so
// every opening re-fetches the roster rather than showing a stale list.
//
// **It hangs off `AnchoredPanel`, and that is the fix for how it used to be
// drawn** (myne-md/myne#867). It was a hand-written `position: absolute` box
// with `right: 0` inside the button's own `position: relative` wrapper, and the
// chat panel is narrower than the box: the card grew leftward past the panel's
// left edge and the panel's `overflow` cut its text off, so a title read as
// "remembers" and a sentence as "ered yet.". No test could see it, because the
// panel and every word in it were in the DOM the whole time. `AnchoredPanel` is
// the primitive whose own header records exactly this failure class; it portals
// the box to the body, where no ancestor's overflow can reach it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AnchoredPanel } from "../../components/primitives/AnchoredPanel";
import { Button } from "../../components/primitives/Button";
import {
  memoryDelete,
  memoryList,
  memoryRead,
  type MemoryListRow,
} from "../../lib/memory";

/**
 * The panel's own chrome. Placement, the portal, the width clamp, the height
 * cap and dismissal all belong to `AnchoredPanel`; what is left here is what
 * this surface looks like. The height is NOT stated because the primitive
 * derives it from the room the anchor has, and a second number here would read
 * as the cap while being overridden by that one, the trap
 * `tests/styles/componentLayer.test.ts` records for the dropdown menus.
 */
const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  width: 300,
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  padding: "var(--space-2)",
};

/** The dialog inside the panel: the keyboard focus target, and the flex column
 *  that lets the roster scroll while the footer stays put. */
const DIALOG_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  flex: 1,
  minHeight: 0,
  // A dialog focused on open is a `tabIndex={-1}` target, and the global
  // `:focus-visible` ring on a container reads as a border around the card.
  outline: "none",
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
  /** The memory button's wrapper. `AnchoredPanel` measures it and places the
   *  card beside it, in the body rather than inside the chat panel. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenSettings: () => void;
  onShowToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MemoryListRow[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loadFailed, setLoadFailed] = useState(false);
  // The host's cap (myne-md/myne#867), so the popover counts against the same
  // denominator the write path enforces.
  const [cap, setCap] = useState<number | null>(null);
  // Per-entry read failures, by id: a corrupt entry renders as unreadable,
  // never as a blank row (report-don't-empty applies per row, not just to
  // the roster: a blank row with a working Delete is indistinguishable from
  // an empty entry).
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management, the MemorySheet twin's posture: focus the dialog on
  // open, return focus to the memory button on close.
  //
  // **Escape is NOT handled here**, and that is a removal rather than an
  // omission: `AnchoredPanel` owns every dismissal it can receive (outside
  // press, Escape, reflow), and a second listener on the same key closed the
  // card twice for one press.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
    // Mount/unmount only: onClose identity must not re-run the teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try {
      const view = await memoryList();
      const list = view.rows;
      setRows(list);
      setCap(view.cap);
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
    <AnchoredPanel
      open
      onClose={props.onClose}
      anchorRef={props.anchorRef}
      minWidth={300}
      align="end"
      style={PANEL_STYLE}
    >
      {/* **The testid stays on the DIALOG, not on the panel** (myne-md/myne#867).
          `role="dialog"`, the accessible name and the focus target all live
          here, and the E2E that waits on `ai.memory-popover` is asserting that a
          dialog is up; splitting the id from the role would leave it asserting
          that a box is up. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t("editor.chrome.rightPanel.aiChat.memoryPopoverTitle")}
        tabIndex={-1}
        data-testid="ai.memory-popover"
        style={DIALOG_STYLE}
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
          {/* The same readout the settings panel carries, at the same place in
              the reading order: how full this is, and at the cap what to do
              about it (myne-md/myne#867). */}
          {rows !== null && rows.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              <span data-testid="ai.memory-popover-count">
                {t("settings.memory.count", { used: rows.length, cap: cap ?? rows.length })}
              </span>
              {cap !== null && rows.length >= cap ? (
                <p data-testid="ai.memory-popover-at-cap" style={TEXT_STYLE}>
                  {t("settings.memory.atCap")}
                </p>
              ) : null}
            </div>
          ) : null}
          {loadFailed ? (
            <div>
              <p data-testid="ai.memory-popover-load-failed" style={TEXT_STYLE}>
                {t("editor.chrome.rightPanel.aiChat.memoryPopoverLoadFailed")}
              </p>
              <Button
                variant="secondary"
                data-testid="ai.memory-popover-retry"
                style={SMALL_BUTTON_STYLE}
                onClick={() => void reload()}
              >
                {t("editor.chrome.rightPanel.aiChat.memoryPopoverRetry")}
              </Button>
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
                <Button
                  variant="secondary"
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
                </Button>
              </div>
            ))
          )}
        </div>
        <div style={FOOTER_STYLE}>
          <Button
            variant="secondary"
            data-testid="ai.memory-popover-settings"
            onClick={props.onOpenSettings}
            style={SMALL_BUTTON_STYLE}
          >
            {t("editor.chrome.rightPanel.aiChat.memoryPopoverSettings")}
          </Button>
          <Button
            variant="secondary"
            data-testid="ai.memory-popover-close"
            onClick={props.onClose}
            style={SMALL_BUTTON_STYLE}
          >
            {t("editor.chrome.rightPanel.aiChat.memoryPopoverClose")}
          </Button>
        </div>
      </div>
    </AnchoredPanel>
  );
}
