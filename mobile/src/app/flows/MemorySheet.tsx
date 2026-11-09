// The phone's agent-memory sheet (myne-md/myne#697, task 9).
//
// Bottom-sheet anatomy mirroring `AiHistorySheet` (fixed scrim + bottom
// card, same radii and tokens): the live memory roster with each entry's
// text, delete with an inline two-tap confirm (the
// `archive.folder-delete-confirm` pattern). Editing lives in Settings (the
// desktop split: the chat popover deletes, the settings panel edits).
//
// The desktop `MemoryPopover` twin in sheet form: a popover has no phone
// posture, so the entry point (a memory button beside the history button in
// `AiChatFlow`) opens this instead. Rows come from the host on mount; delete
// reports back out (`onDeleted`) so the caller can drop cached text.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/Button";
import { memoryDelete, memoryList, memoryRead, type MemoryListRow } from "../../lib/memory";

const SCRIM: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  background: "var(--scrim, rgba(0,0,0,0.45))",
};

const CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: "88%",
  background: "var(--bg-1)",
  borderTopLeftRadius: "var(--radius-3)",
  borderTopRightRadius: "var(--radius-3)",
  borderTop: "1px solid var(--line-1)",
};

const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-4)",
};

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

const ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
};

const ROW_TEXT: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const ROW_META: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const META: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const ERROR_TEXT: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

const ROW_ACTIONS: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
};

const STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px))",
  borderTop: "1px solid var(--line-1)",
};

export function MemorySheet({
  onDeleted,
  onClose,
}: {
  /** A row was deleted (after confirm): the caller drops cached text. */
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MemoryListRow[] | null>(null);
  // The host's cap (myne-md/myne#867), never a constant here.
  const [cap, setCap] = useState<number | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());

  async function readTexts(list: MemoryListRow[]): Promise<Record<string, string>> {
    const nextTexts: Record<string, string> = {};
    const failed = new Set<string>();
    for (const row of list) {
      try {
        nextTexts[row.id] = await memoryRead(row.id);
      } catch {
        failed.add(row.id);
      }
    }
    setFailedIds(failed);
    return nextTexts;
  }

  async function refresh(): Promise<void> {
    try {
      const view = await memoryList();
      const list = [...view.rows].sort((a, b) => b.updated_at - a.updated_at);
      setRows(list);
      setCap(view.cap);
      setTexts(await readTexts(list));
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await memoryList();
        const list = [...view.rows].sort((a, b) => b.updated_at - a.updated_at);
        if (cancelled) return;
        setRows(list);
        setCap(view.cap);
        const nextTexts: Record<string, string> = {};
        const failed = new Set<string>();
        for (const row of list) {
          try {
            nextTexts[row.id] = await memoryRead(row.id);
          } catch {
            failed.add(row.id);
          }
          if (cancelled) return;
        }
        setFailedIds(failed);
        setTexts(nextTexts);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, []);

  async function commitDelete(id: string): Promise<void> {
    try {
      await memoryDelete(id);
      setDeletingId(null);
      await refresh();
      onDeleted(id);
    } catch {
      setError(true);
    }
  }

  const seedRows = rows === null ? [] : rows.filter((row) => row.origin === "seed");
  const ordinaryRows = rows === null ? [] : rows.filter((row) => row.origin !== "seed");
  const seedDate =
    seedRows.length === 0
      ? null
      : new Date(Math.max(...seedRows.map((row) => row.created_at))).toLocaleDateString();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-memory-title"
      data-testid="ai.memory-sheet"
      style={SCRIM}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onClose();
          return;
        }
        // Tab-cycle trap: the sheet claims `aria-modal="true"`, so focus
        // must not leave it while open. Wraps last-to-first (and
        // first-to-last on Shift+Tab); a focus outside the card (the mount
        // focus lands on the card itself, `tabIndex={-1}`) is pulled back in.
        if (e.key !== "Tab") return;
        const root = cardRef.current;
        if (root === null) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !root.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div ref={cardRef} tabIndex={-1} style={CARD}>
        <div style={BODY}>
          <h2 id="ai-memory-title" data-testid="ai.memory-title" style={TITLE}>
            {t("settings.memory.heading")}
          </h2>
          {error ? (
            <p data-testid="ai.memory-error" style={ERROR_TEXT}>
              {t("settings.memory.deleteFailed")}
            </p>
          ) : null}
          {/* The count, and at the cap the action that unblocks it
              (myne-md/myne#867). The sheet is where a phone manages entries,
              so it is where a full list has to say so. */}
          {rows !== null && rows.length > 0 ? (
            <>
              <p data-testid="ai.memory-count" style={META}>
                {t("settings.memory.count", { used: rows.length, cap: cap ?? rows.length })}
              </p>
              {cap !== null && rows.length >= cap ? (
                <p data-testid="ai.memory-at-cap" style={META}>
                  {t("settings.memory.atCap")}
                </p>
              ) : null}
            </>
          ) : null}
          {rows !== null && rows.length === 0 ? (
            <p data-testid="ai.memory-empty" style={META}>
              {t("settings.memory.empty")}
            </p>
          ) : null}
          {rows !== null && rows.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }} data-testid="ai.memory-list">
              {ordinaryRows.map((row) => (
                <li key={row.id} style={ROW} data-testid="ai.memory-row">
                  {failedIds.has(row.id) ? (
                    <p style={ROW_TEXT} data-testid="ai.memory-row-unreadable">
                      {t("settings.memory.entryUnreadable")}
                    </p>
                  ) : (
                    <p style={ROW_TEXT}>{texts[row.id] ?? ""}</p>
                  )}
                  <p style={ROW_META}>v{row.version}</p>
                  {deletingId === row.id ? (
                    <div style={ROW_ACTIONS}>
                      <Button
                        variant="danger"
                        full={false}
                        data-testid="ai.memory-delete-confirm"
                        onClick={() => void commitDelete(row.id)}
                      >
                        {t("settings.memory.deleteLabel")}
                      </Button>
                      <Button
                        variant="ghost"
                        full={false}
                        data-testid="ai.memory-delete-cancel"
                        onClick={() => setDeletingId(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div style={ROW_ACTIONS}>
                      <Button
                        variant="secondary"
                        full={false}
                        data-testid="ai.memory-delete"
                        onClick={() => setDeletingId(row.id)}
                      >
                        {t("settings.memory.deleteLabel")}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {seedRows.length > 0 ? (
            <div data-testid="ai.memory-seed-group">
              <h3 data-testid="ai.memory-seed-title" style={{ ...TITLE, fontSize: "var(--text-base)", marginTop: "var(--space-4)" }}>
                {t("settings.memory.seed.groupTitle")}
              </h3>
              <p data-testid="ai.memory-seed-meta" style={META}>
                {t("settings.memory.seed.groupMeta", {
                  date: seedDate ?? "",
                  count: seedRows.length,
                })}
              </p>
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }} data-testid="ai.memory-seed-list">
                {seedRows.map((row) => (
                  <li key={row.id} style={ROW} data-testid="ai.memory-seed-row">
                    {failedIds.has(row.id) ? (
                      <p style={ROW_TEXT} data-testid="ai.memory-row-unreadable">
                        {t("settings.memory.entryUnreadable")}
                      </p>
                    ) : (
                      <p style={ROW_TEXT}>{texts[row.id] ?? ""}</p>
                    )}
                    <p style={ROW_META}>v{row.version}</p>
                    {deletingId === row.id ? (
                      <div style={ROW_ACTIONS}>
                        <Button
                          variant="danger"
                          full={false}
                          data-testid="ai.memory-delete-confirm"
                          onClick={() => void commitDelete(row.id)}
                        >
                          {t("settings.memory.deleteLabel")}
                        </Button>
                        <Button
                          variant="ghost"
                          full={false}
                          data-testid="ai.memory-delete-cancel"
                          onClick={() => setDeletingId(null)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    ) : (
                      <div style={ROW_ACTIONS}>
                        <Button
                          variant="secondary"
                          full={false}
                          data-testid="ai.memory-delete"
                          onClick={() => setDeletingId(row.id)}
                        >
                          {t("settings.memory.deleteLabel")}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div style={STACK}>
          <Button variant="ghost" data-testid="ai.memory-close" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
