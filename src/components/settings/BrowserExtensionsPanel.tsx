// Settings → Browser extensions. The home of the browser clipper's pairing
// surface: the install toggle and the list of browsers paired with this account,
// both rendered by `ConnectedExtensions`.
//
// # Why it left the Account panel
//
// It was an inline section at the bottom of Account, on the reasoning that a
// pairing token is account-scoped (`decisions/ui/0693` records the placement as
// deliberate, and `design-notes.md` 2026-06-21 moved it there from Privacy).
// The reasoning was right and the destination was wrong: Account answers "who am
// I on this device": the account number, its vaults, the identity behind them.
// A browser extension is software the user connects to the app, not a fact about
// the account. Sitting under the account number, the toggle read as one
// more identity control, and a user looking for "let me clip pages" hunted in
// the panel that answers a different question. Owner report on myne-md/myne#960.
//
// # The gates are the same two, moved from the block to the rail
//
// `PANELS_BASE` carries `capability: "clipper"`, so the rail drops the whole
// entry on a client that cannot host a native-messaging endpoint (the web
// client, `decisions.md` 2026-07-26 makes omission normative), and the block's
// own `capabilities.has("clipper")` guard travels with it so a reachable panel
// can never render an empty section. What the user can reach is unchanged: the
// clipper was absent on web before and is absent on web now.
//
// # One concern, so no visible section heading
//
// The section is named for assistive technology and its rule is suppressed
// (`SettingsSection` does that for the single-section case, myne-md/myne#885):
// the rail entry already names the panel, and a heading repeating it is the
// second copy of one fact this repository keeps deleting.

import { useTranslation } from "react-i18next";
import * as capabilities from "../../platform/capabilities";
import { ConnectedExtensions } from "./ConnectedExtensions";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";

export function BrowserExtensionsPanel() {
  const { t } = useTranslation();

  return (
    <div style={PANEL_ROOT_STYLE}>
      <SettingsSectionCounter>
        <SettingsSection title={t("settings.shell.panels.extensions")}>
          {capabilities.has("clipper") ? (
            <div data-testid="settings.browser-extensions">
              <ConnectedExtensions />
            </div>
          ) : null}
        </SettingsSection>
      </SettingsSectionCounter>
    </div>
  );
}
