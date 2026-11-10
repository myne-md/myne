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

import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import { Switch } from "../../components/primitives/Switch";
import {
  NODE_SIZE_RANGE,
  NODE_SIZE_STRENGTH_RANGE,
  type GraphSettings,
} from "../graphSettings";
import { ColorGroupEditor } from "./ColorGroupEditor";
import { ScrollArea } from "../../components/primitives/ScrollArea";

const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  marginTop: "var(--space-1)",
};

const SLIDER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
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

/** A collapsible group of settings (myne-md/myne#727), a disclosure, not a
 *  tab: the panel is one list and the groups are its folds. Everything is
 *  expanded on open, so collapsing is a choice the user makes rather than a
 *  state the panel arrives in with its contents hidden.
 *
 *  Deliberately local to this panel rather than a shared primitive: the settings
 *  MODAL's panels group with `ControlBlock` headings and are short enough not to
 *  need folding, so a second adopter would be the point at which the shape is
 *  worth lifting, and inventing the shared version now would be guessing at a
 *  contract from one user.
 */
function SettingsGroup({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          // Negative inline margin so the button's own hit area reaches the
          // panel's padding edge while its text stays on the same optical line
          // as the rows below it.
          marginInline: "calc(var(--space-2) * -1)",
          padding: "var(--space-1) var(--space-2)",
          background: "transparent",
          border: 0,
          borderRadius: "var(--radius-2)",
          color: "var(--fg-3)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        <span style={SECTION_HEADING_STYLE}>{label}</span>
      </button>
      {open && (
        <div
          data-testid={`${testId}-body`}
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function GraphSettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  onReset,
  derivedGroupCount = 0,
  onMaterializeDerived,
  derivedMaterializeFailed = false,
}: {
  open: boolean;
  onClose: () => void;
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onReset: () => void;
  /** Forwarded to the colour-group section; see `ColorGroupEditor`. */
  derivedGroupCount?: number;
  onMaterializeDerived?: () => void;
  derivedMaterializeFailed?: boolean;
}) {
  const { t } = useTranslation();

  if (!open) return null;
  return (
    <div
      data-testid="editor.graph-settings-panel"
      style={{
        // No positioning of its own: it is the second child of the graph pane's
        // overlay column, which is what puts it directly under the control
        // cluster and keeps the two from needing a shared magic offset
        // (myne-md/myne#727). The PANEL is still an OVERLAY rather than a column
        // in the pane's layout, which is the load-bearing half: it takes no
        // width from the canvas, so opening it cannot resize the canvas and
        // re-run the layout.
        width: 300,
        maxHeight: "min(70vh, 520px)",
        // `hidden`, not `auto`: the panel itself never scrolls any more. The
        // header is a sibling of the scroller rather than a `position: sticky`
        // child of it, which is the structural way to keep the title and the
        // close control on screen, a sticky element needs its own background
        // and a stacking decision to stop rows showing through it, and this
        // needs neither.
        overflow: "hidden",
        background: "var(--paper)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-3, 8px)",
        boxShadow: "var(--shadow-3)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-3)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span
          style={{
            flex: "1 1 auto",
            fontSize: 12,
            fontWeight: "var(--weight-semibold)",
            color: "var(--fg-1)",
          }}
        >
          {t("notes.graph.settings.title")}
        </span>
        {/* Reset lives HERE, beside the close control, because it is a
            panel-level action rather than the last row of a list, at the
            bottom it read as one more setting and sat below the fold
            (myne-md/myne#727). */}
        <button
          type="button"
          onClick={onReset}
          data-testid="editor.graph-settings-reset"
          style={{
            fontSize: "var(--text-xs)",
            padding: "3px 8px",
            background: "var(--bg-1)",
            color: "var(--fg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            cursor: "pointer",
          }}
        >
          {t("notes.graph.settings.reset")}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
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

      <ScrollArea
        testId="editor.graph-settings-scroll"
        style={{ flex: "1 1 auto" }}
        contentStyle={{
          padding: "var(--space-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
      >
        <SettingsGroup
          label={t("notes.graph.settings.appearanceHeading")}
          testId="editor.graph-settings-group-appearance"
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--fg-2)",
              gap: "var(--space-2)",
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
            min={NODE_SIZE_RANGE.min}
            max={NODE_SIZE_RANGE.max}
            step={1}
            testId="editor.graph-settings-node-size"
            onChange={(next) => onChange({ ...settings, nodeSize: next })}
          />
          <SliderRow
            label={t("notes.graph.settings.nodeSizeStrength")}
            value={settings.nodeSizeStrength}
            min={NODE_SIZE_STRENGTH_RANGE.min}
            max={NODE_SIZE_STRENGTH_RANGE.max}
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
        </SettingsGroup>

        {/* Forces, wired through the layout-request protocol; a change re-runs
            the bounded layout once, warm-started, then freezes. */}
        <SettingsGroup
          label={t("notes.graph.settings.forcesHeading")}
          testId="editor.graph-settings-group-forces"
        >
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
        </SettingsGroup>

        {/* Color groups (graph-connection-ux-polish task 7), self-contained
            (reads/writes vault.prefs directly, never `settings`/`onChange`),
            and deliberately NOT inside the appearance/forces reset: color-group
            rules are authored content, not a tuning knob. */}
        <SettingsGroup
          label={t("notes.graph.colorGroups.heading")}
          testId="editor.graph-settings-group-colors"
        >
          <ColorGroupEditor
            derivedGroupCount={derivedGroupCount}
            onMaterializeDerived={onMaterializeDerived}
            derivedMaterializeFailed={derivedMaterializeFailed}
          />
        </SettingsGroup>
      </ScrollArea>
    </div>
  );
}
