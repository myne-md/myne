// Connections: the one panel that answers "what else can reach this vault"
// (myne-md/myne#1077, task 18 of the 0.19 block).
//
// ── Why the three sections share a panel ────────────────────────────────────
// The CLI, the browser clipper and an external MCP client are three doors into
// the same vault, and each used to live somewhere else: the CLI under Developer,
// the clipper beside the account, the MCP grant inside the AI panel. A person
// asking "what can read my notes" had to know which feature owned the answer.
// One panel, three sections, one place to look.
//
// ── Two gates, not one, and the difference is deliberate ──────────────────
// The panel is a CAPABILITY gate (`anyOf` on the rail entry): a client that can
// host none of the three doors omits the whole tab rather than greying it. What
// the sections add on top is their own history. The clipper is a normal feature
// and sits behind its capability alone (`decisions/ui/0778`). The CLI keeps the
// `developer_mode` gate `decisions/ui/0678` gave it, because the section it
// holds opens a command socket on the machine: merging the three doors into one
// panel was a taxonomy change, and 0678's point was that a taxonomy change does
// not move who can reach the door.
//
// ── What it does NOT do ─────────────────────────────────────────────────────
// It owns no state and no copy of its own beyond its three headings. Each section
// is the surface that already existed, so a change to how the CLI is configured
// has one place to happen.

import { useTranslation } from "react-i18next";
import * as capabilities from "../../platform/capabilities";
import { usePrefs } from "../../hooks/usePrefs";
import { setCliEnabled } from "../../lib/prefs";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";
import { CliPanel } from "./CliPanel";
import { BrowserExtensionsPanel } from "./BrowserExtensionsPanel";
import { McpSection } from "./McpSection";

export interface ConnectionsPanelProps {
  onShowToast?: (message: string) => void;
  onDialogOpenChange?: (open: boolean) => void;
}

export function ConnectionsPanel({ onShowToast, onDialogOpenChange }: ConnectionsPanelProps) {
  const { t } = useTranslation();
  const { prefs } = usePrefs(onShowToast);

  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.connections">
      <SettingsSectionCounter>
        {capabilities.has("cliAccess") && prefs.developer_mode && (
          <CliPanel onShowToast={onShowToast} />
        )}
        {capabilities.has("clipper") && <BrowserExtensionsPanel />}
        {capabilities.has("externalMcp") && (
          <SettingsSection title={t("settings.connections.mcp")}>
            <McpSection
              onDialogOpenChange={onDialogOpenChange}
              enabled={prefs.cli_enabled}
              onSetEnabled={(next) => {
                void setCliEnabled(next);
              }}
              onShowToast={onShowToast}
            />
          </SettingsSection>
        )}
      </SettingsSectionCounter>
    </div>
  );
}
