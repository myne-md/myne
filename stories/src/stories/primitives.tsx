// Stories for the interactive primitives (myne-md/myne#832 task 6).
//
// These render the REAL components from `src/components/primitives/`, so a token
// or variant change is visible here the moment it lands. Primitives are pure and
// host-free, so no fixture is needed.

import type { ReactNode } from "react";
import { Button } from "@app/components/primitives/Button";
import { IconButton } from "@app/components/primitives/IconButton";
import { Input } from "@app/components/primitives/Input";
import { Segmented } from "@app/components/primitives/Segmented";
import { Select } from "@app/components/primitives/Select";
import { Switch } from "@app/components/primitives/Switch";
import { Tooltip } from "@app/components/primitives/Tooltip";
import { Spinner } from "@app/components/Spinner";
import { CredentialField } from "@app/components/primitives/CredentialField";
import { EmptyState } from "@app/components/primitives/EmptyState";
import { Skeleton } from "@app/components/primitives/Skeleton";
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

const BUTTON_VARIANTS = ["primary", "secondary", "ghost", "danger"] as const;

export const PRIMITIVE_STORIES: StoryDescriptor[] = [
  {
    id: "primitives/button/variants",
    group: "primitives",
    surface: "Button",
    state: "variants",
    description: "Button, a variants state.",
    tags: ["primitives", "button", "variants"],
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
    description: "Button, a disabled state.",
    tags: ["primitives", "button", "disabled"],
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
    description: "Icon Button, a default state.",
    tags: ["primitives", "iconbutton", "default"],
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
    description: "Icon Button, a disabled state.",
    tags: ["primitives", "iconbutton", "disabled"],
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
    description: "Input, a default state.",
    tags: ["primitives", "input", "default"],
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
    description: "Input, an invalid state.",
    tags: ["primitives", "input", "invalid"],
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
    description: "Input, a mono-disabled state.",
    tags: ["primitives", "input", "mono-disabled"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Input mono defaultValue="MY-ABCD-EFGH-JKMN-PQRS-TVWX" disabled aria-label="Account number" />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/segmented/default",
    group: "primitives",
    surface: "Segmented",
    state: "default",
    description: "Segmented, a default state.",
    tags: ["primitives", "segmented", "default"],
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
    description: "Switch, an on-off-and-disabled state.",
    tags: ["primitives", "switch", "on-off-and-disabled"],
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
    description: "Select, a default state.",
    tags: ["primitives", "select", "default"],
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
    description: "Tooltip, a default state.",
    tags: ["primitives", "tooltip", "default"],
    render: () => (
      <Row>
        <Tooltip label="Tooltip label" delayMs={0}>
          <Button variant="secondary">Hover target</Button>
        </Tooltip>
      </Row>
    ),
  },
  {
    id: "primitives/spinner/default",
    group: "primitives",
    surface: "Spinner",
    state: "default",
    description: "Spinner, a default state.",
    tags: ["primitives", "spinner", "default"],
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
    description: "Credential Field, a default state.",
    tags: ["primitives", "credentialfield", "default"],
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
    description: "Empty State, a first-run state.",
    tags: ["primitives", "emptystate", "first-run"],
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
    id: "primitives/skeleton/default",
    group: "primitives",
    surface: "Skeleton",
    state: "default",
    description: "Skeleton, a default state.",
    tags: ["primitives", "skeleton", "default"],
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Skeleton lines={3} />
        </div>
      </Row>
    ),
  },
];
