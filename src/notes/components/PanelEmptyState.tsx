// Shared zero-state for the vault-collection panels (Trash / Archive). A large
// muted glyph + a headline + one explanatory line — a proper empty state instead
// of the single bare sentence the panels used to show (#226 follow-up).

import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";
import {
  EMPTY_BODY_STYLE,
  EMPTY_ICON_STYLE,
  EMPTY_STATE_STYLE,
  EMPTY_TITLE_STYLE,
} from "./notePanelStyles";

export function PanelEmptyState({
  icon,
  title,
  body,
  testId,
}: {
  icon: IconName;
  title: string;
  body: string;
  testId?: string;
}) {
  return (
    <div style={EMPTY_STATE_STYLE} data-testid={testId}>
      <span style={EMPTY_ICON_STYLE}>
        <Icon name={icon} size={40} />
      </span>
      <p style={EMPTY_TITLE_STYLE}>{title}</p>
      <p style={EMPTY_BODY_STYLE}>{body}</p>
    </div>
  );
}
