import { useTranslation } from "react-i18next";

type ZxcvbnScore = 0 | 1 | 2 | 3 | 4;

interface PasswordStrengthProps {
  score: ZxcvbnScore;
  warning?: string;
  suggestion?: string;
}

// i18n key suffix per score — resolved at render time via t() (never frozen at
// module scope) so a language switch re-renders the strength label.
const SCORE_LABEL_KEY: Record<ZxcvbnScore, string> = {
  0: "tooWeak",
  1: "tooWeak",
  2: "weak",
  3: "fair",
  4: "strong",
};

const SCORE_COLOR: Record<ZxcvbnScore, string> = {
  0: "var(--danger)",
  1: "var(--danger)",
  2: "var(--warning)",
  3: "var(--accent)",
  4: "var(--success)",
};

const SEGMENT_COUNT: Record<ZxcvbnScore, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
};

const TOTAL_SEGMENTS = 4;

export function PasswordStrength({
  score,
  warning,
  suggestion,
}: PasswordStrengthProps) {
  const { t } = useTranslation();
  const filled = SEGMENT_COUNT[score];
  const color = SCORE_COLOR[score];
  const label = t(`password.strength.${SCORE_LABEL_KEY[score]}`);
  const feedback = warning || suggestion;
  const feedbackColor = warning ? "var(--danger)" : "var(--fg-3)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", flex: 1, gap: 2 }}>
          {Array.from({ length: TOTAL_SEGMENTS }).map((_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: i < filled ? color : "var(--paper-3)",
                transition:
                  "background var(--duration-fast) var(--ease-standard)",
              }}
            />
          ))}
        </div>
        <span
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            minWidth: 64,
            textAlign: "end",
          }}
        >
          {label}
        </span>
      </div>
      {feedback && (
        <div
          style={{
            fontSize: 12,
            color: feedbackColor,
            lineHeight: 1.5,
          }}
        >
          {feedback}
        </div>
      )}
    </div>
  );
}
