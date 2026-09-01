// Import source picker — step 0 of the one generalized import flow (MYND-586).
//
// The single entry point all three surfaces open (palette command, Settings →
// Storage → Import, the one-time onboarding offer). Picking here selects the adapter;
// everything after it is the shared flow.
//
// LAYOUT: a card GRID, not a stacked list of paragraphs. The first pass put each
// source's full keeps/loses disclosure on the card, which made the picker a wall of
// text that needed scrolling before you could even see the five options. The
// disclosure did not get dropped — it moved to the setup step, which the user reaches
// *after* choosing and where there is room for it. So the card answers "which one am
// I?" (brand mark + name + one line) and the setup step answers "what will this cost
// me?" — still before anything is committed.
//
// Every element carries a `data-testid`: the importer UI previously had NONE, which is
// why no import flow could be E2E-driven at all (`src/CLAUDE.md`).

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import {
  IMPORT_SOURCES,
  availableSourceOrder,
  type ImportSourceId,
} from "./sourceCatalog";

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))",
  gap: "var(--space-2)",
};

const CARD_BASE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  padding: "var(--space-3)",
  borderRadius: "var(--radius-2)",
  // Longhand, not the `border` shorthand: the hover state overrides only
  // `borderColor`, and mixing shorthand with longhand across rerenders is a React
  // styling-bug warning (and a real source of stuck styles).
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--line-1)",
  background: "var(--bg-2)",
  textAlign: "start",
  cursor: "pointer",
  width: "100%",
  transition: "border-color 120ms ease, background 120ms ease",
};

const NAME: CSSProperties = {
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  lineHeight: 1.3,
};

const SHORT: CSSProperties = {
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.4,
  marginTop: 2,
  display: "block",
};

const INTRO: CSSProperties = {
  margin: 0,
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

export interface ImportSourcePickerProps {
  onPick: (source: ImportSourceId) => void;
  onCancel: () => void;
}

export function ImportSourcePicker({ onPick, onCancel }: ImportSourcePickerProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<ImportSourceId | null>(null);

  return (
    <>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "var(--space-5)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
        data-testid="import.source-picker"
      >
        <p style={INTRO}>{t("notes.import.picker.intro")}</p>

        <div style={GRID} role="list">
          {availableSourceOrder().map((id) => {
            const spec = IMPORT_SOURCES[id];
            const active = hovered === id;
            return (
              <button
                type="button"
                key={id}
                role="listitem"
                style={{
                  ...CARD_BASE,
                  borderColor: active ? "var(--fg-3)" : "var(--line-1)",
                  background: active ? "var(--paper-2)" : "var(--bg-2)",
                }}
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered((h) => (h === id ? null : h))}
                onFocus={() => setHovered(id)}
                onBlur={() => setHovered((h) => (h === id ? null : h))}
                onClick={() => onPick(id)}
                data-testid="import.source-row"
                data-source={id}
              >
                {/* Text-only, no brand marks — reproducing third-party logos
                    (even simplified) is a trademark grey area; nominative use of
                    the NAME is safe (#183). */}
                <span style={{ minWidth: 0 }}>
                  <span style={NAME}>{t(spec.labelKey)}</span>
                  <span style={SHORT} data-testid="import.source-short">
                    {t(spec.shortKey)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          borderTop: "1px solid var(--line-1)",
          padding: "var(--space-3) var(--space-5)",
          display: "flex",
          justifyContent: "flex-end",
          flex: "0 0 auto",
        }}
      >
        <Button variant="ghost" onClick={onCancel} data-testid="import.picker-cancel">
          {t("notes.import.modal.cancel")}
        </Button>
      </div>
    </>
  );
}
