// The 24-cell recovery-phrase credential of the device-enrolment form
// (extracted by phase3-web-client task 32).
//
// # Why it is its own module
//
// It is a shared primitive. The member roster, the member-vault unlock, the
// identity-only and the migration callers all use it with their own
// caller-specific test IDs, so the 24-cell anatomy lives in one place.
//
// # It was separated for a second reason, and that reason is gone
//
// It was also separated so the web build could substitute it away entirely
// (`web/vite.config.ts`), because `decisions.md` 2026-07-26 forbade the recovery
// phrase from being typed into served code and `scripts/check-web-no-phrase.mjs`
// grepped the built artefact for this module's `data-testid`. Both are retired
// (`decisions.md` 2026-10-18, entry 0704): the substitution entry is removed, the
// grep is deleted, and this module ships on every client. It is still not
// RENDERED on web for enrolment, because `phraseEnrolment` is an absent
// capability there — but "not rendered" and "not in the artefact" are different
// claims, and only the first is true now.
//
// `protocol.md` §7 is why the phrase deserves the care either way: it survives
// every password change, no rotation command exists, and one exposure is
// therefore permanent.

import { type ChangeEvent, type ClipboardEvent, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** 24 words, per `protocol.md` §3.1. */
export const PHRASE_CELL_COUNT = 24;

const FIELD: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-2)" };
const LABEL: CSSProperties = { fontSize: "var(--text-sm)", color: "var(--fg-2)" };
const HINT: CSSProperties = { fontSize: "var(--text-xs)", color: "var(--fg-3)", margin: 0 };
// `minmax(0, 1fr)`, not `1fr`: a `1fr` track is `minmax(auto, 1fr)`, and the
// `auto` floor is each cell's MIN-CONTENT width — a text input's intrinsic
// width (`size`, 20 characters), which `min-width: 0` on the input does not
// reduce, because that only moves the floor rather than the content size. Four
// of those overflowed the panel and pushed the fourth column (words 4/8/12/16/
// 20/24) off the right edge, unreachable in every surface that mounts this
// grid. Zero floors the track; `minWidth: 0` on the wrap lets the item shrink
// to it (myne-md/myne#764).
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: "var(--space-2)",
};
const CELL_WRAP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minWidth: 0,
};
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
  label?: string;
  hint?: string;
  disabled?: boolean;
  gridTestId?: string;
  cellTestId?: (index: number) => string;
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
  label,
  hint,
  disabled = false,
  gridTestId = "sync.enroll.phrase-grid",
  cellTestId = () => "sync.enroll.phrase-cell",
}: EnrollPhraseCredentialProps) {
  const { t } = useTranslation();
  const labelId = `${baseId}-label`;
  const hintId = `${baseId}-hint`;
  return (
    <div style={FIELD}>
      <span id={labelId} style={LABEL}>
        {label ?? t("sync.enroll.recoveryPhraseLabel")}
      </span>
      <p id={hintId} style={HINT}>
        {hint ?? t("sync.enroll.recoveryPhraseHint")}
      </p>
      <div style={GRID} data-testid={gridTestId} aria-labelledby={labelId}>
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
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="text"
                style={CELL_INPUT}
                aria-label={t("sync.enroll.wordAria", { number: i + 1 })}
                aria-describedby={hintId}
                data-testid={cellTestId(i)}
                data-index={i + 1}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
