// Stories for the interactive primitives (myne-md/myne#832 task 6).
//
// These render the REAL components from `src/components/primitives/`, so a token
// or variant change is visible here the moment it lands. Primitives are pure and
// host-free, so no fixture is needed.

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@app/components/primitives/Button";
import { IconButton } from "@app/components/primitives/IconButton";
import { Input } from "@app/components/primitives/Input";
import { Textarea } from "@app/components/primitives/Textarea";
import { Segmented } from "@app/components/primitives/Segmented";
import { Select } from "@app/components/primitives/Select";
import { Switch } from "@app/components/primitives/Switch";
import { Tooltip } from "@app/components/primitives/Tooltip";
import { Spinner } from "@app/components/Spinner";
import { CredentialField } from "@app/components/primitives/CredentialField";
import { EmptyState } from "@app/components/primitives/EmptyState";
import { Skeleton } from "@app/components/primitives/Skeleton";
import { AnchoredPanel } from "@app/components/primitives/AnchoredPanel";
import type { StoryDescriptor } from "../types";
import { action } from "../actions";


/** A row laid out on the app's surface so primitive spacing reads correctly. */
function Row({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        background: "var(--bg-1)",
        color: "var(--fg-1)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {children}
    </div>
  );
}

/** A panel that hangs off its trigger has to be OPEN to be looked at, so the
 *  story carries the trigger's own state (myne-md/myne#848). */
function AnchoredPanelDemo() {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  return (
    <Row>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
        <IconButton
          icon="more-horizontal"
          label="Conversation actions"
          expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      </span>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          padding: "var(--space-1)",
          background: "var(--bg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-1)",
        }}
        testId="story.anchored-panel"
      >
        <Button variant="ghost" onClick={action("onRename")}>
          Rename
        </Button>
        <Button variant="ghost" onClick={action("onDelete")}>
          Delete
        </Button>
      </AnchoredPanel>
    </Row>
  );
}

const BUTTON_VARIANTS = ["primary", "secondary", "ghost", "danger"] as const;

export const PRIMITIVE_STORIES: StoryDescriptor[] = [
  {
    id: "primitives/button/variants",
    group: "primitives",
    surface: "Button",
    state: "variants",
    description:
      "The four text-button variants side by side, plus an icon-prefixed secondary: primary, secondary, ghost and danger. Appearance and every interactive state live in the shared stylesheet, so this is the place to check each variant's resting weight and that a leading glyph keeps its baseline.",
    tags: ["primitives", "button", "variants", "primary", "secondary", "ghost", "danger", "icon"],
    render: () => (
      <Row>
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        <Button variant="secondary" icon="plus">
          With icon
        </Button>
      </Row>
    ),
  },
  {
    id: "primitives/button/disabled",
    group: "primitives",
    surface: "Button",
    state: "disabled",
    description:
      "The same four variants in their disabled state: the dimmed fill and non-interactive cursor a caller gets by passing `disabled`. Look for a disabled control that stays legible rather than fading into the panel.",
    tags: ["primitives", "button", "disabled", "dimmed", "non-interactive", "states"],
    render: () => (
      <Row>
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} disabled>
            {variant}
          </Button>
        ))}
      </Row>
    ),
  },
  {
    id: "primitives/iconbutton/default",
    group: "primitives",
    surface: "IconButton",
    state: "default",
    description:
      "Icon-only square buttons on the app's surface: settings, search and delete. Each carries an accessible label, and the stylesheet pairs focus-visible with hover so a tabbing user gets more than a ring on a rail of identical glyphs. A glyph whose meaning needs a word is the wrong control here.",
    tags: ["primitives", "iconbutton", "icon-only", "accessible-name", "focus-ring", "rail"],
    // The authored half of the Documentation page, on the surface where the
    // judgement is real: an icon-only control is the wrong choice the moment the
    // action needs a word (myne-md/myne#847).
    docs: {
      whenNotToUse:
        "Not for an action whose meaning is not already obvious from the icon alone. If a reader would have to hover to find out what it does, the action needs a label, so it needs Button.",
      content: "The label is an accessible name, not visible copy, so it is sentence case and it names the action rather than the glyph.",
      related: ["Button"],
    },
    render: () => (
      <Row>
        <IconButton icon="settings" label="Settings" onClick={action("onClick")} />
        <IconButton icon="search" label="Search" onClick={action("onClick")} />
        <IconButton icon="trash-2" label="Delete" onClick={action("onClick")} />
      </Row>
    ),
  },
  {
    id: "primitives/iconbutton/disabled",
    group: "primitives",
    surface: "IconButton",
    state: "disabled",
    description:
      "Two icon buttons in their disabled state: the dimmed glyph a caller gets by passing `disabled`, still carrying its accessible label so it stays announceable while it is unreachable.",
    tags: ["primitives", "iconbutton", "disabled", "dimmed", "glyph"],
    render: () => (
      <Row>
        <IconButton icon="settings" label="Settings" onClick={action("onClick")} disabled />
        <IconButton icon="trash-2" label="Delete" onClick={action("onClick")} disabled />
      </Row>
    ),
  },
  {
    id: "primitives/input/default",
    group: "primitives",
    surface: "Input",
    state: "default",
    description:
      "The single-line text field at rest, inside a width-constrained box: the shared input fill, hairline and radius. Focus is `:focus` rather than `:focus-visible`, because a clicked-into text field IS focused and must say so.",
    tags: ["primitives", "input", "text-field", "empty", "placeholder", "form"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Input placeholder="Vault name" />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/input/invalid",
    group: "primitives",
    surface: "Input",
    state: "invalid",
    description:
      "The field marked invalid: a value the caller rejected, carrying the flagged border and an explicit `aria-label` so the error is announced as well as painted. Look for the invalid treatment to be distinct from the focus ring.",
    tags: ["primitives", "input", "invalid", "error", "validation", "aria"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Input defaultValue="Not a valid value" invalid aria-label="Example value" />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/input/mono-disabled",
    group: "primitives",
    surface: "Input",
    state: "mono-disabled",
    description:
      "A monospaced, disabled field holding a sample account number in its grouped display form. Monospace is what keeps the dash-separated groups aligned, and disabled is how a known value is shown rather than edited.",
    tags: ["primitives", "input", "mono", "disabled", "account-number", "read-only"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Input mono defaultValue="MY-ABCD-EFGH-JKMN-PQRS-TVWX" disabled aria-label="Account number" />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/textarea/default",
    group: "primitives",
    surface: "Textarea",
    state: "default",
    description:
      "The multi-line field, on the same skin as the single-line `Input`: the shared fill, hairline and radius, with the field's own vertical resize. Used where a value is longer than one line, such as a memory entry under review.",
    tags: ["primitives", "textarea", "multi-line", "form", "review"],
    render: () => (
      <Row>
        <div style={{ width: 420 }}>
          <Textarea
            defaultValue={"Projects: Myne, including the roadmap.\nPrefers short, decision-first answers."}
            rows={3}
            aria-label="Memory entry"
          />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/segmented/default",
    group: "primitives",
    surface: "Segmented",
    state: "default",
    description:
      "A three-way segmented control (radiogroup) with a sliding selection thumb: the shared discrete-choice control for settings, used for up to four options. It measures the active segment's box pre-paint and re-observes its container, so the thumb travels. Look for the fill sitting under the selected segment with each segment as `role=\"radio\"`.",
    tags: ["primitives", "segmented", "radiogroup", "discrete-choice", "thumb", "settings"],
    render: () => (
      <Row>
        <Segmented
          ariaLabel="Editor typography"
          value="sans"
          onChange={action("onChange")}
          options={[
            { value: "sans", label: "Sans" },
            { value: "serif", label: "Serif" },
            { value: "mono", label: "Mono" },
          ]}
        />
      </Row>
    ),
  },
  {
    id: "primitives/switch/on-off-and-disabled",
    group: "primitives",
    surface: "Switch",
    state: "on-off-and-disabled",
    description:
      "The toggle control in all three shapes: on, off, and the disabled placeholder a caller renders by omitting `onChange` or passing `disabled`. It is a button carrying `role=\"switch\"` and `aria-checked`, so the painted state and the announced state come from one attribute. Look for `aria-checked` to match the knob's side.",
    tags: ["primitives", "switch", "toggle", "on-off", "disabled", "aria-checked"],
    render: () => (
      <Row>
        <Switch checked ariaLabel="On" onChange={action("onChange")} />
        <Switch checked={false} ariaLabel="Off" onChange={action("onChange")} />
        <Switch checked={false} ariaLabel="Disabled placeholder" />
      </Row>
    ),
  },
  {
    id: "primitives/select/default",
    group: "primitives",
    surface: "Select",
    state: "default",
    description:
      "The custom dropdown that replaces the operating system select: a trigger matching the input chrome, and a menu rendered through a portal so no scroll or wrap container can clip it. Look for `role=\"listbox\"` and keyboard movement (↑/↓ to move, Enter to choose, Esc to close).",
    tags: ["primitives", "select", "dropdown", "listbox", "portal", "form"],
    render: () => (
      <Row>
        <Select
          aria-label="Theme"
          value="system"
          onChange={action("onChange")}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Row>
    ),
  },
  {
    id: "primitives/tooltip/default",
    group: "primitives",
    surface: "Tooltip",
    state: "default",
    description:
      "A themed hover/focus label on a button. It appears quickly, follows the pointer's x, flips above or below to stay on screen, shows on keyboard focus too, and portals to the body so an `overflow: hidden` ancestor cannot clip it. The trigger keeps its own `aria-label`; the bubble is a visual affordance, not the a11y name.",
    tags: ["primitives", "tooltip", "hover", "focus", "portal", "viewport-aware"],
    render: () => (
      <Row>
        <Tooltip label="Tooltip label" delayMs={0}>
          <Button variant="secondary">Hover target</Button>
        </Tooltip>
      </Row>
    ),
  },
  {
    id: "primitives/anchoredpanel/open",
    group: "primitives",
    surface: "AnchoredPanel",
    state: "open",
    description:
      "A small panel hanging open off its trigger: a portal-to-body surface that escapes any clipping ancestor and owns its own placement, portal and the three ways out. Look for the anchor being the trigger and the panel taking no layout space in the flow.",
    tags: ["primitives", "anchoredpanel", "popover", "portal", "open", "menu"],
    // The authored half of the Documentation page, on the surface where the
    // judgement is real (myne-md/myne#848).
    docs: {
      whenNotToUse:
        "Not for content that belongs in the flow, and not for a full dialog: a ModalShell owns the screen and takes focus, where this panel is dismissed by the next press anywhere.",
      content:
        "For a small panel that hangs off a trigger inside a scrolling or clipping container: it renders in the body, so no ancestor can cut it off, and it owns the dismissal. The panel carries its own chrome; this component owns placement, the portal and the three ways out, and nothing else.",
      related: ["Tooltip", "Select"],
    },
    render: () => <AnchoredPanelDemo />,
  },
  {
    id: "primitives/spinner/default",
    group: "primitives",
    surface: "Spinner",
    state: "default",
    description:
      "The indeterminate progress spinner, for a wait with no known shape or duration. Skeleton states the sibling decisions: under ~200ms show nothing, a known layout gets a skeleton, and an unknown blocking wait is what this is for.",
    tags: ["primitives", "spinner", "loading", "progress", "indeterminate"],
    render: () => (
      <Row>
        <Spinner />
      </Row>
    ),
  },
  {
    id: "primitives/credentialfield/default",
    group: "primitives",
    surface: "CredentialField",
    state: "default",
    description:
      "The credential field: the shared Input and a primary Button composed for the auth screens, empty, with the submit disabled rather than absent so the layout does not reflow under the caret mid-keystroke. Look for the submit staying visible while the field is empty.",
    tags: ["primitives", "credentialfield", "auth", "submit", "disabled", "composed"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <CredentialField
            value=""
            onChange={action("onChange")}
            ariaLabel="Password"
            busyLabel="Unlocking"
            submitLabel="Unlock"
          />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/emptystate/first-run",
    group: "primitives",
    surface: "EmptyState",
    state: "first-run",
    description:
      "The first-run zero state inside a width-constrained card: a glyph, a title and one body sentence pointing at the first action. It is the `firstRun` variant; the component also carries the loading and no-results treatments.",
    tags: ["primitives", "emptystate", "zero-state", "first-run", "placeholder", "onboarding"],
    render: () => (
      <Row>
        <div style={{ width: 360 }}>
          <EmptyState
            variant="firstRun"
            icon="file-text"
            title="No notes yet"
            body="Create your first note to get started."
          />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/emptystate/fault",
    group: "primitives",
    surface: "EmptyState",
    state: "fault",
    description:
      "The same zero state carrying a FAULT rather than an absence, inside a right-panel-width column: the glyph and the title name what is wrong, and the wash behind them tints the surface instead of flooding it. Look for the glow staying a tint at a third of the first-run strength, which is the retune in myne-md/myne#1020; a fault is not more urgent than a first run, it is smaller.",
    tags: ["primitives", "emptystate", "zero-state", "error", "fault", "wash"],
    render: () => (
      <Row>
        {/* A right-panel column, which is where this state actually lives: the
            wash's whole complaint was that it flooded a NARROW pane, so a story
            laid out at canvas width would show the retune as a smudge instead of
            as the tint it is. `display: flex` on the column is what stops the
            child stretching past the width. */}
        <div
          style={{
            width: 320,
            height: 420,
            display: "flex",
            background: "var(--bg-1)",
          }}
        >
          <EmptyState
            variant="error"
            icon="circle-alert"
            size="sm"
            fill
            title="No model"
            body="There is no model here to run. Add one under Settings, AI, Models: download one from Myne's own origin, or point Myne at a file you already have."
          />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/skeleton/default",
    group: "primitives",
    surface: "Skeleton",
    state: "default",
    description:
      "The loading placeholder drawing three text lines: the shape of an answer arriving into its outline rather than shoving the page down when it lands. The convention it serves is in the component header: under ~200ms show nothing, a known layout is a skeleton, an unknown wait is a spinner.",
    tags: ["primitives", "skeleton", "loading", "placeholder", "shimmer", "latency"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Skeleton lines={3} />
        </div>
      </Row>
    ),
  },
];
