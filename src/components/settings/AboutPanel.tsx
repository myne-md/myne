// Settings → About panel: version (compile-time injected from
// `package.json::version` via Vite `define` — see vite-env.d.ts) +
// build channel (Development / Stable from `import.meta.env.MODE`) +
// threat-model link (opens `https://myne.md/threat-model` via
// `opener:default`'s `allow-open-url` for https) + license + the
// Developer mode toggle (developer-mode feature, MYND-593).
//
// **The changelog block is gone** (2026-10-29 owner request: "remove the
// changelog"). It was a permanently disabled button under a sentence promising
// notes "when MYND-119 lands", so the only thing it ever did was take a row on
// the panel the build's identity lives on. A dead control is not a placeholder
// a user can act on; when per-version notes exist they earn their own door.
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
//
// **The diagnostics section left this panel on 2026-10-25** (owner request: "move
// the diagnostic part of About to a tab of its own"). What remains is what this
// build IS: version, channel, commit, hash, updates, developer mode, licence.
// What is going WRONG is `DiagnosticsPanel`, which is a different question
// asked at a different moment, and four blocks of it used to sit under a version
// string.

import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { servedBuildInfo, type BuildInfo } from "../../platform/build-info";
import { openUrl } from "../../platform/opener";
import { has } from "../../platform/capabilities";
import {
  updateCheck,
  getAutoCheck,
  setAutoCheck,
  type UpdateCheckError,
  type UpdateStatus,
} from "../../platform/update";
import { useUpdateFlow } from "../../hooks/updateFlow";
import { LEGAL_LINKS, legalUrl, type LegalDoc } from "../../lib/legal-urls";
import { usePrefs } from "../../hooks/usePrefs";
import { Button } from "../primitives/Button";
import { MyneMark } from "../primitives/MyneMark";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
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

/** Accent text-link hover: shift to the hover-accent (an underlined accent link
 *  needs a color change, not a background block, to register a pointer-over). */
const linkHover = {
  onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
    e.currentTarget.style.color = "var(--accent-hover)";
  },
  onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => {
    e.currentTarget.style.color = "var(--accent)";
  },
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
  transition: "color var(--duration-fast) var(--ease-standard)",
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  alignSelf: "flex-start",
};

const LICENSE_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
  margin: 0,
};

/** A refused install start, under its own row. Danger tone: it stopped something
 *  the row promised, and the fix is on the same row. */
const FLUSH_REFUSED_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--danger)",
  margin: 0,
};

function Block({
  children,
  ...rest
}: {
  children: ReactNode;
  "data-setting-anchor"?: string;
  "data-setting-row"?: string;
}) {
  return (
    <div style={BLOCK_STYLE} {...rest}>
      {children}
    </div>
  );
}

function handleThreatModelClick() {
  openUrl(THREAT_MODEL_URL).catch((err) => {
    if (import.meta.env.DEV) {
      console.warn("AboutPanel: openUrl(threat-model) rejected", err);
    }
  });
}

function handleLegalClick(doc: LegalDoc, locale: string) {
  openUrl(legalUrl(doc, locale)).catch((err) => {
    if (import.meta.env.DEV) {
      console.warn(`AboutPanel: openUrl(${doc}) rejected`, err);
    }
  });
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "status"; status: UpdateStatus }
  | { kind: "failed"; error: UpdateCheckError };

/** Narrow a rejected invoke to the closed update-error union, defaulting to `other`. */
function updateErrorKind(error: unknown): UpdateCheckError {
  return error === "unreachable" ||
    error === "verification" ||
    error === "unsupported" ||
    error === "other"
    ? error
    : "other";
}

export function AboutPanel() {
  const { t, i18n } = useTranslation();
  const { prefs, setDeveloperMode } = usePrefs();
  // The SERVED bundle's identity, where there is one (phase3-web-client task
  // 114). `null` on desktop by construction — a desktop user's build identity is
  // the installer they ran, which the version string above already names.
  //
  // On web this is the readout that makes the rest of the integrity chain
  // usable: the bundle is re-delivered on every load, meant to be pinned by a
  // service worker and checkable against a record of released hashes, and none
  // of that helps if the running client will not say which bundle it is. (That
  // record is not public today, and the service worker is not implemented, so
  // both halves of the chain are intent rather than state: docs/threat-model.md
  // §5 and design-notes/security/0534. The readout is still what makes either
  // of them usable later, and what lets a user quote a hash to someone who can
  // check it now.)
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

  // The manual update check. Idle until the user presses the button; a failure
  // is a calm line, never an error dialog.
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const runUpdateCheck = () => {
    setCheck({ kind: "checking" });
    updateCheck()
      .then((status) => {
        setCheck({ kind: "status", status });
      })
      .catch((error: unknown) => {
        setCheck({ kind: "failed", error: updateErrorKind(error) });
      });
  };

  // A manual check that finds an update turns the SAME button into the install
  // (owner request, myne-md/myne#1020). It used to be two controls: the check in
  // the row's slot, and a second primary button appearing underneath it, which
  // made the row grow a control nobody had asked for and left the row's own button
  // looking inert next to it. One control, two states, and the row's height never
  // moves.
  //
  // The SAME flow the notice drives, and no second install path (myne-md/myne#1059).
  //
  // This row used to be the second door onto `updateInstall`: it flushed the panes
  // and installed, without locking the vault and without an `updating` Stage, so
  // pressing it produced a row stuck on "working" while an install ran behind a
  // screen that never appeared — and pressing it while the notice's own install was
  // running produced two downloads of the same artefact over one progress stream.
  // `design-notes/ui/0686` recorded the split as a product decision and called
  // unifying it a decision rather than a fix; the owner took that decision on
  // 2026-11-18, so the row now asks the flow, which flushes, locks, enters the
  // updating screen and installs in that order.
  const flow = useUpdateFlow();
  const installing = flow?.working ?? false;
  const blockedHere = flow?.blocked ?? null;
  const runUpdateInstall = () => {
    // The offered line stays: it is what the row is installing, and the flow's
    // own screens take over from here.
    flow?.confirm();
  };

  const updateOffered =
    check.kind === "status" && check.status.kind === "available";

  const updateChannelLabel =
    __UPDATE_CHANNEL__ === "beta"
      ? t("settings.about.updateChannelBeta")
      : t("settings.about.updateChannelStable");

  const updateStatusText = (() => {
    switch (check.kind) {
      case "checking":
        return t("settings.about.updateChecking");
      case "status":
        return check.status.kind === "up_to_date"
          ? t("settings.about.updateUpToDate")
          : t("settings.about.updateAvailable", { version: check.status.version });
      case "failed":
        return t("settings.about.updateFailed");
      default:
        return t("settings.about.updateIdle");
    }
  })();

  // The device-local automatic-check toggle. Null until the read resolves, so
  // the row does not render a guessed value.
  const [autoCheck, setAutoCheckState] = useState<boolean | null>(null);
  useEffect(() => {
    if (!has("selfUpdate")) return;
    let cancelled = false;
    getAutoCheck()
      .then((value) => {
        if (!cancelled) setAutoCheckState(value);
      })
      .catch(() => {
        // Leave null; the row stays hidden rather than showing a guess.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleAutoCheck = (next: boolean) => {
    setAutoCheckState(next);
    setAutoCheck(next).catch(() => {
      // Revert if the write failed, so the switch reflects what is stored.
      setAutoCheckState(!next);
    });
  };

  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* Four sections (myne-md/myne#885). The build-commit block moves up to sit
          with the version, so "what am I running" is one group and the update
          machinery is another; the only order the grouping changed is that
          block, which used to sit between the two.

          The BUILD-channel row is gone (myne-md/myne#960). It was
          `import.meta.env.MODE === "development" ? "Development build" :
          "Stable"`, so in every shipped build it read a constant "Stable" and
          sat directly above an Update-channel row that reads the real channel
          from `__UPDATE_CHANNEL__`; two rows saying "Stable" make a reader
          wonder which one is theirs. The update channel is the one that can
          differ, and `scripts/check-update-channel.mjs` requires this panel to
          name every non-default channel, so it is the one kept. */}
      <SettingsSection title={t("settings.about.sections.version")}>
        <Block>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
            <MyneMark size={44} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <h3 style={VERSION_TITLE_STYLE}>Myne {__APP_VERSION__}</h3>
              <p style={VERSION_SUBTITLE_STYLE}>{t("settings.about.tagline")}</p>
            </div>
          </div>
        </Block>

        <Block>
          <span style={LABEL_STYLE}>{t("settings.about.buildLabel")}</span>
          {/* Served build first, compile-time define second. On web the commit is
              a property of the SERVED bundle, not of whoever built it: the web
              config pins `__BUILD_COMMIT__` so the bundle takes nothing from its
              build environment (myne-md/myne#458), and `version.json` carries the
              real commit (the document this panel already fetches for the hash).
              Desktop answers `null` from the seam by construction and renders the
              define, which is the identity of the installer that was run.
              Sliced because `version.json` holds the full 40-hex SHA while the
              desktop define is `--short=9`; `"unknown"` survives the slice. */}
          <p style={VALUE_STYLE} data-testid="about.build-commit">
            {(served?.commit ?? __BUILD_COMMIT__).slice(0, 9)}
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
      </SettingsSection>

      {has("selfUpdate") && (
        <SettingsSection title={t("settings.about.sections.updates")}>
          <Block data-setting-anchor="about.update-channel" data-setting-row="true">
            <span style={LABEL_STYLE}>{t("settings.about.updateChannelLabel")}</span>
            <p style={VALUE_STYLE} data-testid="about.update-channel">
              {updateChannelLabel}
            </p>
          </Block>

          {/* A `SettingRow` like its neighbours (myne-md/myne#885 visual pass):
              the button in the control slot on the right, the short status line
              inline, and the long verification paragraph behind the question
              mark, where the settings panels keep the rest of what a row has to
              say. The status line stays inline because it IS the readout.

              ONE control (myne-md/myne#1020): while nothing is on offer it checks,
              and once a version is offered the same button becomes the install.
              A refusal to start says so under the row rather than under a second
              button, because there is no second button. */}
          <SettingRow
            anchorId="about.update"
            testId="about.update-row"
            label={t("settings.about.updateLabel")}
            helper={updateStatusText}
            helperTestId="about.update-status"
            explanation={[t("settings.about.updateHelper")]}
            control={(_helperId, explanationId) =>
              updateOffered ? (
                <Button
                  variant="primary"
                  onClick={runUpdateInstall}
                  disabled={installing}
                  data-testid="about.update-install"
                  aria-describedby={explanationId}
                >
                  {t("settings.about.updateInstallButton")}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={runUpdateCheck}
                  disabled={check.kind === "checking"}
                  data-testid="about.update-check"
                  aria-describedby={explanationId}
                >
                  {t("settings.about.updateCheckButton")}
                </Button>
              )
            }
          >
            {blockedHere !== null && (
              <p style={FLUSH_REFUSED_STYLE} data-testid="about.update-blocked">
                {t(
                  blockedHere === "flush"
                    ? "settings.about.updateFlushFailed"
                    : "settings.about.updateBlocked",
                )}
              </p>
            )}
          </SettingRow>

          {autoCheck !== null && (
            <SettingRow
              label={t("settings.about.updateAutoCheckLabel")}
              helper={t("settings.about.updateAutoCheckHelper")}
              control={(helperId) => (
                <Switch
                  checked={autoCheck}
                  onChange={toggleAutoCheck}
                  ariaLabel={t("settings.about.updateAutoCheckLabel")}
                  ariaDescribedBy={helperId}
                  testId="about.update-auto-check"
                />
              )}
            />
          )}
        </SettingsSection>
      )}

      <SettingsSection title={t("settings.about.sections.legal")}>
        <Block data-setting-anchor="about.threat-model" data-setting-row="true">
          <span style={LABEL_STYLE}>{t("settings.about.threatModelLabel")}</span>
          <button
            type="button"
            onClick={handleThreatModelClick}
            {...linkHover}
            style={LINK_STYLE}
          >
            myne.md/threat-model
            <span aria-hidden="true">↗</span>
          </button>
          <p style={HELPER_STYLE}>{t("settings.about.threatModelHelper")}</p>
        </Block>

        <Block data-setting-anchor="about.legal" data-setting-row="true">
          <span style={LABEL_STYLE}>{t("settings.about.legalLabel")}</span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "var(--space-1)",
            }}
          >
            {LEGAL_LINKS.map(({ doc, labelKey, testId }) => (
              <button
                key={doc}
                type="button"
                onClick={() => {
                  handleLegalClick(doc, i18n.language);
                }}
                {...linkHover}
                style={LINK_STYLE}
                data-testid={testId}
              >
                {t(labelKey)}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          <p style={HELPER_STYLE}>{t("settings.about.legalHelper")}</p>
        </Block>

        <Block data-setting-anchor="about.license" data-setting-row="true">
          <span style={LABEL_STYLE}>{t("settings.about.licenseLabel")}</span>
          <p style={LICENSE_BODY_STYLE}>{t("settings.about.licenseBody")}</p>
        </Block>
      </SettingsSection>

      <SettingsSection title={t("settings.about.sections.developer")}>
        {/* Rendered unconditionally (#181). It used to be hidden wherever the
            rail's Developer GROUP would have no capability-eligible member:
            `capabilities.has("localAi")`, i.e. never shown on web. That test
            stopped describing the gate the moment Developer mode also began
            hiding individual settings inside core panels: the Vim toggle exists
            on every client, so on web the old guard removed the only control
            that could reveal it and left the setting permanently unreachable
            (`developer_mode` is device-local, so it cannot arrive by sync
            either). An empty Developer group is now just an empty group (the
            rail already derives its own divider from that) and is no longer a
            reason to withhold the switch. */}
        <SettingRow
          label={t("settings.about.developerModeLabel")}
          testId="about.developer-mode"
          // 287 characters under a switch that does one thing (myne-md/myne#885).
          // The row keeps what the mode IS; the rest, including the two things a
          // reader actually wants to know before flipping it (that turning it off
          // changes nothing already switched on, and where to switch that off),
          // moves behind the question mark unchanged.
          helper={t("settings.about.developerModeInline")}
          explanation={[t("settings.about.developerModeHelper")]}
          control={(helperId, explanationId) => (
            <Switch
              checked={prefs.developer_mode}
              onChange={(next) => {
                void setDeveloperMode(next);
              }}
              ariaLabel={t("settings.about.developerModeLabel")}
              ariaDescribedBy={
                explanationId === undefined
                  ? helperId
                  : `${helperId} ${explanationId}`
              }
              testId="about.developer-mode-toggle"
            />
          )}
        />
      </SettingsSection>
    </div>
  );
}
