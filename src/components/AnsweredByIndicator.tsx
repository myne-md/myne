// "Answered by …" — the persistent, quiet indicator of which backend produced
// an answer (ai-remote-providers myne#415 task 15, SYNC-13).
//
// **It renders for LOCAL answers too, and that is the design.** An indicator
// that appears only for remote ones is a warning badge: it trains people to
// read its absence as "safe" and its presence as "alarm", and the moment it
// becomes routine they stop seeing it. What SYNC-13 asked for is a persistent
// statement of fact — where this answer came from — which is only informative
// if it is always there.
//
// **Quiet, on purpose.** No colour alarm, no icon, no dismissal, no toast, no
// interaction. It is `--fg-3` at `--text-xs`: legible when looked for, silent
// when not. A remote answer names the provider, because "remote" without a
// name tells the user nothing they can act on.
//
// **Shared, not chat-specific.** #191 converges the AI failure/provenance
// surfaces and mounts this same component; that is why it lives in
// `src/components/` rather than beside one consumer.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/**
 * Where an answer came from. Mirrors the host's `BackendClass`, plus the
 * provider name a remote answer carries — the datum, not a rendering choice.
 *
 * The three arms are the three trust boundaries a user could be in: in-process
 * (no boundary crossed), a program on this machine (TB12), and off-device
 * (TB13). Collapsing any two would make the indicator say something untrue for
 * one of them.
 */
export type AnsweredBy =
  | { kind: "in-process" }
  | { kind: "local-runtime"; name: string }
  | { kind: "remote"; provider: string };

const STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  // No background, no border, no icon: this is a caption, not a badge.
  margin: 0,
  lineHeight: 1.4,
};

interface AnsweredByIndicatorProps {
  answeredBy: AnsweredBy;
  /** Override the testid where a second surface mounts this (#191). */
  testId?: string;
}

export function AnsweredByIndicator({
  answeredBy,
  testId = "ai.answered-by",
}: AnsweredByIndicatorProps) {
  const { t } = useTranslation();

  const text =
    answeredBy.kind === "in-process"
      ? t("ai.answeredBy.inProcess")
      : answeredBy.kind === "local-runtime"
        ? t("ai.answeredBy.localRuntime", { name: answeredBy.name })
        : t("ai.answeredBy.remote", { provider: answeredBy.provider });

  return (
    <p
      data-testid={testId}
      // The KIND as a stable attribute so a test — and #191's convergence work
      // — can assert which state was rendered without matching translated
      // prose. It is a closed vocabulary, never a runtime-derived value.
      data-answered-by={answeredBy.kind}
      style={STYLE}
    >
      {text}
    </p>
  );
}
