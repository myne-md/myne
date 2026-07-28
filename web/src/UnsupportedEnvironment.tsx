// The refusal surface for an environment that cannot run the client
// (phase3-web-client task 29).
//
// Rendered INSTEAD of the app, not inside it: nothing else mounts, no Worker
// starts, and no derivation is ever attempted. That ordering is the acceptance
// criterion — "refusal happens before any KDF work" — and it is enforced by
// where this is called from (`main.tsx`), not by a check further in.
//
// Tone follows PRODUCT.md: honest, not alarming. This is a limit of the
// browser, not a failure of the user, and the page says what is missing and
// where to go instead rather than apologising.
//
// Strings go through i18n like every other user-facing string (`src/CLAUDE.md`).
// The English source lives in `environment-gate.ts` and is passed as
// `defaultValue`, so the two cannot drift: the module that decides *which*
// capability is missing is also the one that owns the sentence explaining it,
// and a locale that has not been translated yet renders the honest English
// rather than a raw key.

import { useTranslation } from "react-i18next";
import { explainMissing, NATIVE_HANDOFF, type RequiredCapability } from "./environment-gate";

const PAGE: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
};

const CARD: React.CSSProperties = {
  maxWidth: 560,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const H1: React.CSSProperties = { fontSize: 20, fontWeight: 600, margin: 0 };
const P: React.CSSProperties = { margin: 0, lineHeight: 1.6, color: "var(--fg-2)" };
const LIST: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  color: "var(--fg-2)",
  lineHeight: 1.6,
};

export function UnsupportedEnvironment({ missing }: { missing: RequiredCapability[] }) {
  const { t } = useTranslation();
  return (
    <main style={PAGE} data-testid="web.unsupported-environment">
      <div style={CARD}>
        <h1 style={H1}>{t("web.unsupported.title")}</h1>
        <ul style={LIST} data-testid="web.unsupported-reasons">
          {missing.map((cap) => (
            <li key={cap} data-capability={cap}>
              {t(`web.unsupported.reason.${cap}`, { defaultValue: explainMissing(cap) })}
            </li>
          ))}
        </ul>
        <p style={P} data-testid="web.unsupported-handoff">
          {t("web.unsupported.handoff", { defaultValue: NATIVE_HANDOFF })}
        </p>
      </div>
    </main>
  );
}
