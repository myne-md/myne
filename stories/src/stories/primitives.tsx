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
import type { StoryDescriptor } from "../types";

const noop = () => {};

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
    render: () => (
      <Row>
        <IconButton icon="settings" label="Settings" onClick={noop} />
        <IconButton icon="search" label="Search" onClick={noop} />
        <IconButton icon="trash-2" label="Delete" onClick={noop} />
      </Row>
    ),
  },
  {
    id: "primitives/iconbutton/disabled",
    group: "primitives",
    surface: "IconButton",
    state: "disabled",
    render: () => (
      <Row>
        <IconButton icon="settings" label="Settings" onClick={noop} disabled />
        <IconButton icon="trash-2" label="Delete" onClick={noop} disabled />
      </Row>
    ),
  },
  {
    id: "primitives/input/default",
    group: "primitives",
    surface: "Input",
    state: "default",
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
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Input defaultValue="Not a valid value" invalid />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/input/mono-disabled",
    group: "primitives",
    surface: "Input",
    state: "mono-disabled",
    render: () => (
      <Row>
        <div style={{ width: 280 }}>
          <Input mono defaultValue="MY-ABCD-EFGH-JKMN-PQRS-TVWX" disabled />
        </div>
      </Row>
    ),
  },
  {
    id: "primitives/segmented/default",
    group: "primitives",
    surface: "Segmented",
    state: "default",
    render: () => (
      <Row>
        <Segmented
          ariaLabel="Editor typography"
          value="sans"
          onChange={noop}
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
    render: () => (
      <Row>
        <Switch checked ariaLabel="On" onChange={noop} />
        <Switch checked={false} ariaLabel="Off" onChange={noop} />
        <Switch checked={false} ariaLabel="Disabled placeholder" />
      </Row>
    ),
  },
  {
    id: "primitives/select/default",
    group: "primitives",
    surface: "Select",
    state: "default",
    render: () => (
      <Row>
        <Select
          aria-label="Theme"
          value="system"
          onChange={noop}
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
    render: () => (
      <Row>
        <Spinner />
      </Row>
    ),
  },
];
