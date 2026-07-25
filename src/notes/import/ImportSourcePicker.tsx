// Import source picker — step 0 of the one generalized import flow (MYND-586).
//
// The single entry point all three surfaces open (palette command, Settings →
// Storage → Import, the one-time onboarding offer). Picking here selects the adapter;
// everything after it is the shared flow.
//
// This step is also where PRE-IMPORT fidelity disclosure belongs: each row states what
// survives and what does not for that source, BEFORE the user commits. The
// post-import half is the generated import-report note (MYND-585). Together they are
// the epic's answer to "the fidelity bar per source, and how it is disclosed".
//
// Every row carries a `data-testid` — the importer UI previously had NONE, which is
// why no import flow could be E2E-driven at all (`src/CLAUDE.md`: "a screen without
// testids is invisible to E2E").

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import {
  IMPORT_SOURCES,
  IMPORT_SOURCE_ORDER,
  type ImportSourceId,
} from "./sourceCatalog";

const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  textAlign: "left",
  cursor: "pointer",
  width: "100%",
};

const NAME: CSSProperties = {
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
};

const DETAIL: CSSProperties = {
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "0.85rem",
  lineHeight: 1.45,
};

export interface ImportSourcePickerProps {
  onPick: (source: ImportSourceId) => void;
  onCancel: () => void;
}

export function ImportSourcePicker({ onPick, onCancel }: ImportSourcePickerProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="import.source-picker">
      <div style={{ ...DETAIL, marginBottom: "var(--space-3)" }}>
        {t("notes.import.picker.intro")}
      </div>
      <div style={LIST} role="list">
        {IMPORT_SOURCE_ORDER.map((id) => {
          const spec = IMPORT_SOURCES[id];
          return (
            <button
              type="button"
              key={id}
              role="listitem"
              style={ROW}
              onClick={() => onPick(id)}
              data-testid="import.source-row"
              data-source={id}
            >
              <span style={NAME}>{t(spec.labelKey)}</span>
              {/* Honest, per-source, and BEFORE the click — not a post-hoc apology. */}
              <span style={DETAIL} data-testid="import.source-survives">
                {t(spec.survivesKey)}
              </span>
              <span style={DETAIL} data-testid="import.source-loses">
                {t(spec.losesKey)}
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-4)" }}>
        <Button variant="ghost" onClick={onCancel} data-testid="import.picker-cancel">
          {t("notes.import.modal.cancel")}
        </Button>
      </div>
    </div>
  );
}
