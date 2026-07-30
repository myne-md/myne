// The graph pane's settings panel shell (graph-connection-ux-polish task 5):
// a gear button that opens a panel FLOATING over the canvas (never splitting
// the pane — a width change would re-run the layout and re-jumble the graph,
// the exact "flashbang" the warm-start layout work exists to prevent).
//
// Task 5 shipped one control (edge-direction arrows) + reset-to-defaults;
// task 6 adds the remaining seven — appearance (label fade, node size +
// strength, line thickness) and forces (center, repel, link strength, link
// distance) — as two labeled groups inside the same panel body. State
// (open/closed) is local to this component — it never touches `filter` or
// `buildTrigger` in `GraphView.tsx`, so opening/closing the panel never bumps
// the pane's layout-nonce.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { Switch } from "../../components/primitives/Switch";
import type { GraphSettings } from "../graphSettings";
import { ColorGroupEditor } from "./ColorGroupEditor";

const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  marginTop: 4,
};

const SLIDER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--fg-2)",
};

const SLIDER_LABEL_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const SLIDER_VALUE_STYLE: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  color: "var(--fg-3)",
};

/** One `<input type="range">` row — the same raw-slider shape `ViewSettings`
 *  (Saved Views) already established, reused rather than inventing a second
 *  slider component for this panel. */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  testId: string;
  onChange: (next: number) => void;
}) {
  return (
    <label style={SLIDER_ROW_STYLE}>
      <span style={SLIDER_LABEL_ROW_STYLE}>
        {label}
        <span data-testid={`${testId}-value`} style={SLIDER_VALUE_STYLE}>
          {value}
        </span>
      </span>
      <input
        type="range"
        data-testid={testId}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function GraphSettingsPanel({
  settings,
  onChange,
  onReset,
}: {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "absolute", top: 8, right: 8, zIndex: 5 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("notes.graph.settings.openTitle")}
        aria-expanded={open}
        title={t("notes.graph.settings.openTitle")}
        data-testid="editor.graph-settings-gear"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          background: open ? "var(--paper-3)" : "var(--paper)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-1)",
          color: "var(--fg-2)",
          cursor: "pointer",
        }}
      >
        <Icon name="settings" size={14} />
      </button>
      {open && (
        <div
          data-testid="editor.graph-settings-panel"
          style={{
            position: "absolute",
            top: 34,
            right: 0,
            width: 300,
            maxHeight: "min(70vh, 520px)",
            overflowY: "auto",
            background: "var(--paper)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-3, 8px)",
            boxShadow: "var(--shadow-3)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)" }}>
              {t("notes.graph.settings.title")}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("notes.graph.settings.closeTitle")}
              title={t("notes.graph.settings.closeTitle")}
              data-testid="editor.graph-settings-close"
              style={{
                display: "flex",
                background: "transparent",
                border: 0,
                color: "var(--fg-3)",
                cursor: "pointer",
                padding: 2,
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--fg-2)",
              gap: 8,
            }}
          >
            {t("notes.graph.settings.showArrows")}
            <Switch
              checked={settings.showArrows}
              onChange={(next) => onChange({ ...settings, showArrows: next })}
              ariaLabel={t("notes.graph.settings.showArrows")}
              testId="editor.graph-settings-arrows-toggle"
            />
          </label>

          {/* Appearance — render-time only, repaints without a layout re-run. */}
          <span style={SECTION_HEADING_STYLE}>{t("notes.graph.settings.appearanceHeading")}</span>
          <SliderRow
            label={t("notes.graph.settings.labelFadeZoom")}
            value={settings.labelFadeZoom}
            min={0.5}
            max={3}
            step={0.1}
            testId="editor.graph-settings-label-fade"
            onChange={(next) => onChange({ ...settings, labelFadeZoom: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.nodeSize")}
            value={settings.nodeSize}
            min={3}
            max={10}
            step={1}
            testId="editor.graph-settings-node-size"
            onChange={(next) => onChange({ ...settings, nodeSize: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.nodeSizeStrength")}
            value={settings.nodeSizeStrength}
            min={0}
            max={1}
            step={0.1}
            testId="editor.graph-settings-node-size-strength"
            onChange={(next) => onChange({ ...settings, nodeSizeStrength: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.lineThickness")}
            value={settings.lineThickness}
            min={0.5}
            max={4}
            step={0.1}
            testId="editor.graph-settings-line-thickness"
            onChange={(next) => onChange({ ...settings, lineThickness: next })}
          />

          {/* Forces — wired through the layout-request protocol; a change
              re-runs the bounded layout once, warm-started, then freezes. */}
          <span style={SECTION_HEADING_STYLE}>{t("notes.graph.settings.forcesHeading")}</span>
          <SliderRow
            label={t("notes.graph.settings.forceCenter")}
            value={settings.forceCenterStrength}
            min={0}
            max={2}
            step={0.1}
            testId="editor.graph-settings-force-center"
            onChange={(next) => onChange({ ...settings, forceCenterStrength: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.forceRepel")}
            value={settings.forceRepelStrength}
            min={20}
            max={400}
            step={10}
            testId="editor.graph-settings-force-repel"
            onChange={(next) => onChange({ ...settings, forceRepelStrength: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.forceLinkStrength")}
            value={settings.forceLinkStrength}
            min={0}
            max={2}
            step={0.1}
            testId="editor.graph-settings-force-link-strength"
            onChange={(next) => onChange({ ...settings, forceLinkStrength: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.forceLinkDistance")}
            value={settings.forceLinkDistance}
            min={20}
            max={200}
            step={5}
            testId="editor.graph-settings-force-link-distance"
            onChange={(next) => onChange({ ...settings, forceLinkDistance: next })}
          />

          {/* Color groups (graph-connection-ux-polish task 7) — a second
              section, self-contained (reads/writes vault.prefs directly,
              never `settings`/`onChange`). Deliberately independent of the
              appearance/forces reset below: color-group rules are authored
              content, not a physics/appearance tuning knob. */}
          <ColorGroupEditor />

          <button
            type="button"
            onClick={onReset}
            data-testid="editor.graph-settings-reset"
            style={{
              alignSelf: "flex-start",
              fontSize: 12,
              padding: "4px 8px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-1)",
              cursor: "pointer",
            }}
          >
            {t("notes.graph.settings.reset")}
          </button>
        </div>
      )}
    </div>
  );
}
