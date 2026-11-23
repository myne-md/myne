// Settings → CLI (developer group). The home of the `myne` terminal client's
// settings surface: the access door, the folder exclusion list and the
// rate-limit removal control, all rendered by `CliAccessSettings`.
//
// # Why the CLI has a panel of its own
//
// It used to be a block inside Privacy, behind a panel-internal
// `prefs.developer_mode && has("cliAccess")` render condition, and that
// placement was the open question the `cli-thin-client` PRD left (the PRD
// recommended Privacy; `CliAccessSettings`'s own header recorded the
// resolution). `decisions/ui/0678` supersedes it for one reason: the CLI is a
// client, not one toggle, and this surface grows. Every later CLI setting —
// sidecar version, socket status, PATH repair, an audit log of the commands
// that ran — would otherwise land in Privacy by gravity rather than by
// reasoning, and the panel a user hunts for a terminal setting in is not the
// panel that answers "what can somebody looking at this machine see".
//
// # The gates are the same two, and they have moved twice without changing
//
// `decisions/ui/0678` moved the pair from the block to the rail: a
// `capability: "cliAccess"` entry in the `developer` group, so a client with no
// command socket (web) dropped it and the whole developer group dropped while
// `developer_mode` was off. `decisions/ui/0778`'s sibling reasoning then put
// three doors — the CLI, the browser clipper, an external MCP client — into one
// Connections panel (myne-md/myne#1077), and THAT panel is a capability gate.
// The pair did not travel with it: this component still renders only when
// `capabilities.has("cliAccess") && prefs.developer_mode`, which is the same two
// conditions 0678 recorded, now checked one level down instead of by the rail.
// A placement change is a taxonomy change, and who can reach the command socket
// is not part of a taxonomy.
//
// What deliberately does NOT change: the disclosure copy stays in the row it
// belongs to (`CliAccessSettings`), always visible and never behind a
// disclosure toggle. `docs/threat-model.md` §7 bounds it, and a bound the
// reader has to click for is a bound most readers never see.
//
// # Why `CliAccessSettings` survives as a separate file
//
// This panel is the composition root: it reads `vault.prefs` and hands the
// three values and three setters down. The block stays props-driven, which is
// what lets the story catalogue render it in isolation against fixture props
// (`stories/src/stories/settings.tsx`) rather than needing a live prefs store —
// the same split, and the same reason, as `PrivacyPanel` and its row
// components. One file per panel plus the shared control blocks they compose.

import { useTranslation } from "react-i18next";
import { usePrefs } from "../../hooks/usePrefs";
import { mutationFrom } from "../../lib/prefs";
import { CliAccessSettings } from "./CliAccessSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";

interface CliPanelProps {
  /** Wired by `SettingsModal`. The panel omits it in dev / non-Tauri contexts
   *  where the modal mounts without a toast surface (same contract as
   *  `PrivacyPanel`). */
  onShowToast?: (message: string) => void;
}

export function CliPanel({ onShowToast }: CliPanelProps = {}) {
  const { t } = useTranslation();
  const {
    prefs,
    setCliEnabled,
    setCliExcludedFolders,
    setCliRateLimitDisabled,
  } = usePrefs(onShowToast);

  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* One concern, so one section with no visible heading or rule
          (myne-md/myne#885): the rail entry already names it, the same shape
          the Transcription panel takes. The `<section aria-label>` stays. */}
      <SettingsSectionCounter>
      <SettingsSection title={t("settings.shell.panels.cli")}>
      <CliAccessSettings
        enabled={prefs.cli_enabled}
        excludedFolders={prefs.cli_excluded_folders}
        rateLimitDisabled={prefs.cli_rate_limit_disabled}
        onSetEnabled={(next) => {
          void setCliEnabled(next);
        }}
        onSetExcludedFolders={(folders, seededFrom) => {
          // Diffed against what this panel last saw, not against the current
          // cache. Same reasoning as AiPanel: an exclusion a peer added while
          // the user was editing is in the cache and not in the editor's
          // list, and diffing against the cache would call that a removal
          // (myne-md/myne#613). The CLI exclusion list is an egress control,
          // so the fail-open direction is the terminal reading a folder the
          // user marked hidden.
          void setCliExcludedFolders(mutationFrom(seededFrom, folders), folders);
        }}
        onSetRateLimitDisabled={(next) => {
          void setCliRateLimitDisabled(next);
        }}
      />
      </SettingsSection>
      </SettingsSectionCounter>
    </div>
  );
}
