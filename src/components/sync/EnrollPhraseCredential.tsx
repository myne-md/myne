// The 24-cell recovery-phrase credential of the device-enrolment form
// (extracted by phase3-web-client task 32).
//
// # Why it is its own module
//
// Not for reuse — it has exactly one caller. It is separate so the **web build
// can substitute it away entirely** (`web/vite.config.ts`, `ABSENT_SCREENS`).
// `decisions.md` 2026-07-26 forbids the recovery phrase from being typed into
// served code, and enrolment is the third path to it after creation and
// recovery — the one that is easy to miss, because that screen is about adding
// a device rather than about the phrase.
//
// Gating it at runtime was the first attempt and it was not enough:
// `scripts/check-web-no-phrase.mjs` reads the built artefact and found the grid
// still shipped, hidden behind a branch. `protocol.md` §7 is why "hidden" does
// not qualify — the phrase survives every password change, no rotation command
// exists, so one exposure is permanent.

import { type ChangeEvent, type ClipboardEvent, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** 24 words, per `protocol.md` §3.1. */
export const PHRASE_CELL_COUNT = 24;

const FIELD: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-2)" };
const LABEL: CSSProperties = { fontSize: "var(--text-sm)", color: "var(--fg-2)" };
const HINT: CSSProperties = { fontSize: "var(--text-xs)", color: "var(--fg-3)", margin: 0 };
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "var(--space-2)",
};
const CELL_WRAP: CSSProperties = { display: "flex", alignItems: "center", gap: "var(--space-1)" };
const CELL_NUMBER: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  width: "1.4em",
  textAlign: "end",
  fontFamily: "var(--font-mono)",
};
const CELL_INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  outline: "none",
};

export interface EnrollPhraseCredentialProps {
  baseId: string;
  cells: string[];
  onCellChange: (index: number) => (e: ChangeEvent<HTMLInputElement>) => void;
  onCellPaste: (index: number) => (e: ClipboardEvent<HTMLInputElement>) => void;
}

/**
 * The grid only. State, normalisation and submission stay in the form: this
 * module exists to be *removable*, and logic living here would have to be
 * duplicated by the substitute rather than simply omitted.
 *
 * No per-cell validity styling, exactly as `recovery-flow.md` §3.2 requires of
 * the recovery grid: a green/red hint would leak one bit of BIP-39 membership
 * per word to anyone looking at the screen.
 */
export function EnrollPhraseCredential({
  baseId,
  cells,
  onCellChange,
  onCellPaste,
}: EnrollPhraseCredentialProps) {
  const { t } = useTranslation();
  return (
    <div style={FIELD}>
      <span style={LABEL}>{t("sync.enroll.recoveryPhraseLabel")}</span>
      <p style={HINT}>{t("sync.enroll.recoveryPhraseHint")}</p>
      <div style={GRID} data-testid="sync.enroll.phrase-grid">
        {Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => {
          const inputId = `${baseId}-cell-${i}`;
          return (
            <label key={i} htmlFor={inputId} style={CELL_WRAP}>
              <span style={CELL_NUMBER}>{i + 1}</span>
              <input
                id={inputId}
                type="text"
                value={cells[i] ?? ""}
                onChange={onCellChange(i)}
                onPaste={onCellPaste(i)}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="text"
                style={CELL_INPUT}
                aria-label={t("sync.enroll.wordAria", { number: i + 1 })}
                data-testid="sync.enroll.phrase-cell"
                data-index={i + 1}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
