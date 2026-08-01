// Settings → About panel: version (compile-time injected from
// `package.json::version` via Vite `define` — see vite-env.d.ts) +
// build channel (Development / Stable from `import.meta.env.MODE`) +
// threat-model link (opens `https://myne.md/threat-model` via
// `opener:default`'s `allow-open-url` for https) + license + the
// Developer mode toggle (developer-mode feature, MYND-593) + disabled
// "View changelog…" (enables with MYND-119).
//
// The Developer mode toggle is the first interactive control this panel has
// ever had — placed beside the build/license/threat-model claims because
// enabling it is what suspends them: it reveals the settings where the user
// leaves the path Myne vouches for (a self-supplied inference model, the
// terminal door onto an unlocked vault, Tor routing). Rendered on every
// client: it used to be hidden wherever the rail's Developer group would
// have had no capability-eligible member, but since #181 the mode also hides
// individual settings inside core panels, and those exist everywhere — see
// the comment on the control itself. Takes effect immediately — no restart,
// no confirmation dialog, matching how `ai_enabled` and every other prefs
// toggle in this app behave.
//
// Penpot canon: `🔴 screen------settings--about` (frame id
// `9fb59646-2811-8082-8007-fd4c5a602b46`).

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { servedBuildInfo, type BuildInfo } from "../../platform/build-info";
import { openUrl } from "../../platform/opener";
import { usePrefs } from "../../hooks/usePrefs";
import { Button } from "../primitives/Button";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
} from "./panel-styles";

const THREAT_MODEL_URL = "https://myne.md/threat-model";

const VERSION_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  margin: 0,
  lineHeight: 1.2,
};

const VERSION_SUBTITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
};

const VALUE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: 0,
};

const LINK_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--accent)",
  textDecoration: "underline",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
  fontFamily: "inherit",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  alignSelf: "flex-start",
};

const LICENSE_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
  margin: 0,
};

function Block({ children }: { children: ReactNode }) {
  return <div style={BLOCK_STYLE}>{children}</div>;
}

function handleThreatModelClick() {
  openUrl(THREAT_MODEL_URL).catch((err) => {
    if (import.meta.env.DEV) {
      console.warn("AboutPanel: openUrl(threat-model) rejected", err);
    }
  });
}

export function AboutPanel() {
  const { t } = useTranslation();
  const { prefs, setDeveloperMode } = usePrefs();
  // The SERVED bundle's identity, where there is one (phase3-web-client task
  // 114). `null` on desktop by construction — a desktop user's build identity is
  // the signed installer they ran, which the version string above already names.
  //
  // On web this is the readout that makes the rest of the integrity chain
  // usable: the bundle is re-delivered on every load, meant to be pinned by a
  // service worker and checkable against a published hash record, and none of
  // that helps if the running client will not say which bundle it is.
  //
  // Presented exactly as the version string is, with no security claim attached
  // — the disclosure of the weakened trust posture is a separate, deliberate
  // decision and is out of this task's scope.
  const [served, setServed] = useState<BuildInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void servedBuildInfo().then((info) => {
      if (!cancelled) setServed(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildChannelLabel =
    import.meta.env.MODE === "development"
      ? t("settings.about.buildChannelDevelopment")
      : t("settings.about.buildChannelStable");

  return (
    <div style={PANEL_ROOT_STYLE}>
      <Block>
        <h3 style={VERSION_TITLE_STYLE}>Myne {__APP_VERSION__}</h3>
        <p style={VERSION_SUBTITLE_STYLE}>{t("settings.about.tagline")}</p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>{t("settings.about.buildChannelLabel")}</span>
        <p style={VALUE_STYLE}>{buildChannelLabel}</p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>{t("settings.about.buildLabel")}</span>
        <p style={VALUE_STYLE} data-testid="about.build-commit">
          {__BUILD_COMMIT__}
        </p>
        {served !== null && (
          <p
            style={{ ...VALUE_STYLE, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}
            data-testid="about.bundle-hash"
          >
            {served.bundleHash}
          </p>
        )}
      </Block>

      <Block>
        <span style={LABEL_STYLE}>{t("settings.about.threatModelLabel")}</span>
        <button
          type="button"
          onClick={handleThreatModelClick}
          style={LINK_STYLE}
        >
          myne.md/threat-model
          <span aria-hidden="true">↗</span>
        </button>
        <p style={HELPER_STYLE}>{t("settings.about.threatModelHelper")}</p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>{t("settings.about.licenseLabel")}</span>
        <p style={LICENSE_BODY_STYLE}>{t("settings.about.licenseBody")}</p>
      </Block>

      {/* Rendered unconditionally (#181). It used to be hidden wherever the
          rail's Developer GROUP would have no capability-eligible member —
          `capabilities.has("localAi")`, i.e. never shown on web. That test
          stopped describing the gate the moment Developer mode also began
          hiding individual settings inside core panels: the Vim toggle exists
          on every client, so on web the old guard removed the only control
          that could reveal it and left the setting permanently unreachable
          (`developer_mode` is device-local, so it cannot arrive by sync
          either). An empty Developer group is now just an empty group — the
          rail already derives its own divider from that — and is no longer a
          reason to withhold the switch. */}
      <SettingRow
        label={t("settings.about.developerModeLabel")}
        helper={t("settings.about.developerModeHelper")}
        control={(helperId) => (
          <Switch
            checked={prefs.developer_mode}
            onChange={(next) => {
              void setDeveloperMode(next);
            }}
            ariaLabel={t("settings.about.developerModeLabel")}
            ariaDescribedBy={helperId}
            testId="about.developer-mode-toggle"
          />
        )}
      />

      <Block>
        <span style={LABEL_STYLE}>{t("settings.about.changelogLabel")}</span>
        <div>
          <Button variant="secondary" disabled>
            {t("settings.about.changelogButton")}
          </Button>
        </div>
        <p style={HELPER_STYLE}>{t("settings.about.changelogHelper")}</p>
      </Block>
    </div>
  );
}
