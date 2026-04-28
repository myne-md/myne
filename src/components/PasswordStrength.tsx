type ZxcvbnScore = 0 | 1 | 2 | 3 | 4;

interface PasswordStrengthProps {
  score: ZxcvbnScore;
  warning?: string;
  suggestion?: string;
}

const SCORE_LABEL: Record<ZxcvbnScore, string> = {
  0: "Too weak",
  1: "Too weak",
  2: "Weak",
  3: "Fair",
  4: "Strong",
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
  const filled = SEGMENT_COUNT[score];
  const color = SCORE_COLOR[score];
  const label = SCORE_LABEL[score];
  const feedback = warning || suggestion;
  const feedbackColor = warning ? "var(--danger)" : "var(--fg-3)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
            fontSize: 11,
            fontWeight: 600,
            color,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            minWidth: 64,
            textAlign: "right",
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
