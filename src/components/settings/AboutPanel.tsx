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
import { updateCheck, updateInstall, getAutoCheck, setAutoCheck, type UpdateCheckError, type UpdateStatus } from "../../platform/update";
import { renameFlushHooks } from "../../notes/renameFlushHook";
import { LEGAL_LINKS, legalUrl, type LegalDoc } from "../../lib/legal-urls";
import { usePrefs } from "../../hooks/usePrefs";
import { useDiagnostics } from "../../hooks/useDiagnostics";
import { copyText } from "../../lib/clipboard";
import { collectDiagnostics } from "../../lib/collect-diagnostics";
import { lastGlobalFailure } from "../../lib/global-failure";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { toast } from "../toast/toastStore";
import { Button } from "../primitives/Button";
import { MyneMark } from "../primitives/MyneMark";
import { Switch } from "../primitives/Switch";
import { ControlBlock } from "./ControlBlock";
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

/**
 * The diagnostics preview readout.
 *
 * The field shape (a monospace value on a `--paper-2` inset) without the field
 * behaviour: this `<pre>` is read-only and never resized, so it takes no
 * `resize` and instead sets `white-space: pre-wrap` with `overflow-wrap:
 * anywhere`. The longest line is a 64-hex bundle hash, which has no break
 * opportunity, so without both properties it paints past the panel's right edge
 * in the narrow-dialog state this panel supports.
 */
const PREVIEW_STYLE: CSSProperties = {
  marginTop: "var(--space-1)",
  width: "100%",
  font: "inherit",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--fg-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-2)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
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

/**
 * The crash record's date, in the interface's language.
 *
 * A local `Intl.DateTimeFormat` rather than the shared display store: that store
 * exists so the EDITOR's date fields follow one setting, and this is a single
 * diagnostic fact rendered once in a settings panel. An unreadable record reads
 * as an unknown date rather than as "just now", because a zero here means
 * "present but unreadable" (see `src-tauri/src/logging/crash.rs`).
 */
function formatCrashDate(epochSeconds: number, language: string): string | null {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochSeconds * 1000));
}

/**
 * A byte count, for the manifest line.
 *
 * Coarse on purpose, and it matches the block's own storage figures: a
 * maintainer reading it needs the order of magnitude, and a byte-exact number in
 * a settings row is precision nobody acts on.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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
  // The opt-in diagnostic log and the one crash record (myne-md/myne#860).
  // Host-owned rather than prefs, so they carry their own hook; absent on web,
  // where the whole logging half is (a served bundle installs no subscriber),
  // which is why the surface is gated rather than disabled.
  const diagnostics = useDiagnostics();
  // The exact string Copy puts on the clipboard, assembled through the existing
  // block builder and environment collector. Kept in state rather than rendered
  // from a second call, because the preview must be byte-identical to the copy
  // and one source is the only way to guarantee that.
  const [diagnosticBlock, setDiagnosticBlock] = useState<string | null>(null);
  useEffect(() => {
    // NOT gated on the capability: the block and its Copy button render on every
    // client, so the block has to be assembled on every client. Gating this read
    // would leave the web preview permanently empty while the capability
    // descriptor promised a working copy.
    let cancelled = false;
    // The recorded global failure goes in as the block's `failureCode`. This is
    // the second reader of `global-failure.ts`: the installer already runs at
    // boot (`main.tsx`), and until now nothing read what it recorded.
    void collectDiagnostics(lastGlobalFailure() ?? "none")
      .then((block) => {
        if (!cancelled) setDiagnosticBlock(block);
      })
      .catch(() => {
        // An unhandled rejection here would be recorded by the installed global
        // handler as `unhandled-rejection`, which would stamp this panel's own
        // failed promise into the very `failureCode` the block reads back. Leave
        // the preview empty instead; the readout is not worth a global-failure
        // class it did not cause.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Copy reports BOTH outcomes through the one transport (`src/lib/clipboard.ts`),
  // which is the rule `scripts/check-clipboard-feedback.mjs` enforces: a failed
  // copy that looks like a successful one is how a user pastes the previous
  // clipboard contents believing they are their diagnostics.
  const copyDiagnostics = () => {
    if (diagnosticBlock === null) return;
    void copyText(clipboardWriteText, diagnosticBlock, {
      onSuccess: {
        kind: "toast",
        run: () => {
          toast({
            message: t("settings.about.diagnosticCopyDone"),
            variant: "info",
          });
        },
      },
      onFailure: {
        kind: "toast",
        run: () => {
          toast({
            message: t("settings.about.diagnosticCopyFailed"),
            variant: "error",
          });
        },
      },
    });
  };
  // Save asks for a destination first, and reports three outcomes: a CANCELLED
  // dialog is silent, because nothing was attempted; a completed save confirms;
  // and a refused dialog or a failed write reports the failure rather than
  // folding into "cancelled". The manifest re-reads afterwards, because a
  // bundle that included the crash record clears it, so the row above changes
  // as a consequence.
  const saveReportFlow = () => {
    if (diagnosticBlock === null) return;
    void diagnostics.saveReport(diagnosticBlock).then((outcome) => {
      if (outcome === "cancelled") return;
      toast({
        message:
          outcome === "saved"
            ? t("settings.about.diagnosticSaveDone")
            : t("settings.about.diagnosticSaveFailed"),
        variant: outcome === "saved" ? "info" : "error",
      });
    });
  };

  // Reveal and Delete report where the action happened, for the reason the hook
  // gives: the row's own error text names a setting change, so routing a failed
  // folder-open or delete through it would tell the user a control they never
  // touched had failed.
  const revealFlow = () => {
    void diagnostics.reveal().then((opened) => {
      if (opened) return;
      toast({
        message: t("settings.about.diagnosticRevealFailed"),
        variant: "error",
      });
    });
  };

  const clearCrashFlow = () => {
    void diagnostics.clearCrash().then((cleared) => {
      if (cleared) return;
      toast({
        message: t("settings.about.crashRecordClearFailed"),
        variant: "error",
      });
    });
  };

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
  // §5 and docs/decisions/security/0534. The readout is still what makes either
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

  const buildChannelLabel =
    import.meta.env.MODE === "development"
      ? t("settings.about.buildChannelDevelopment")
      : t("settings.about.buildChannelStable");

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

  // A manual check that finds an update must offer the install, not just the
  // sentence: with the automatic check off, the notice's check never runs, so this
  // is the only reachable affordance.
  //
  // This is the SECOND install door, and it is deliberately not the notice's flow
  // (myne-md/myne#870): it flushes and installs without locking the vault, so it
  // has no confirm, no `updating` Stage and no failure surface. The notice's
  // confirm is the path that locks first, and unifying the two is a product
  // decision recorded in `docs/decisions/ui/0686` rather than taken here.
  const [installing, setInstalling] = useState(false);
  const runUpdateInstall = () => {
    setInstalling(true);
    void (async () => {
      // Flush unsaved note edits before the process exits to install, as every
      // other exit path does.
      try {
        await renameFlushHooks().flushOpenPanes();
      } catch {
        // best effort
      }
      updateInstall().catch(() => {
        setInstalling(false);
        setCheck({ kind: "failed", error: "other" });
      });
    })();
  };

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
      <Block>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          <MyneMark size={44} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h3 style={VERSION_TITLE_STYLE}>Myne {__APP_VERSION__}</h3>
            <p style={VERSION_SUBTITLE_STYLE}>{t("settings.about.tagline")}</p>
          </div>
        </div>
      </Block>

      <Block data-setting-anchor="about.build-channel" data-setting-row="true">
        <span style={LABEL_STYLE}>{t("settings.about.buildChannelLabel")}</span>
        <p style={VALUE_STYLE}>{buildChannelLabel}</p>
      </Block>

      {has("selfUpdate") && (
        <>
          <Block data-setting-anchor="about.update-channel" data-setting-row="true">
            <span style={LABEL_STYLE}>{t("settings.about.updateChannelLabel")}</span>
            <p style={VALUE_STYLE} data-testid="about.update-channel">
              {updateChannelLabel}
            </p>
          </Block>

          <Block data-setting-anchor="about.update" data-setting-row="true">
            <span style={LABEL_STYLE}>{t("settings.about.updateLabel")}</span>
            <div>
              <Button
                variant="secondary"
                onClick={runUpdateCheck}
                disabled={check.kind === "checking"}
                data-testid="about.update-check"
              >
                {t("settings.about.updateCheckButton")}
              </Button>
            </div>
            <p style={HELPER_STYLE} data-testid="about.update-status">
              {updateStatusText}
            </p>
            {check.kind === "status" && check.status.kind === "available" && (
              <div>
                <Button
                  variant="primary"
                  onClick={runUpdateInstall}
                  disabled={installing}
                  data-testid="about.update-install"
                >
                  {t("settings.about.updateInstallButton")}
                </Button>
              </div>
            )}
            <p style={HELPER_STYLE}>{t("settings.about.updateHelper")}</p>
          </Block>

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
        </>
      )}

      <Block>
        <span style={LABEL_STYLE}>{t("settings.about.buildLabel")}</span>
        {/* Served build first, compile-time define second. On web the commit is
            a property of the SERVED bundle, not of whoever built it: the web
            config pins `__BUILD_COMMIT__` so the bundle takes nothing from its
            build environment (myne-md/myne#458), and `version.json` carries the
            real commit — the document this panel already fetches for the hash.
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

      {/* myne-md/myne#860. Gated on the capability rather than rendered
          disabled: on web the whole logging half is absent, because a served
          bundle installs no `tracing` subscriber at all
          (`docs/decisions/ops/0366`), so a greyed switch would be an offer the
          platform cannot honour (`decisions.md` 2026-07-26).

          Deliberately NOT behind the Developer-mode toggle. That gate hides
          capabilities a normal user does not configure (a self-supplied
          inference model, the terminal door, Tor routing); this switch is the
          front door of a feature built for the user who has hit a bug, so
          hiding it there would hide it from exactly the person it is for. */}
      {/* The report block renders on EVERY client, deliberately, and it is the
          one part of this surface that is not behind the `diagnosticLog`
          capability. Copying the diagnostics block is the half the issue's scope
          sentence keeps for the web client, and it is the half that matters most
          there, because a browser user cannot open a devtools panel and read a
          failure back to anyone. A capability descriptor that claims this while
          the row sits behind the gate is the "canon and shipped screen disagree"
          failure, caught in review.

          The preview is composed from `ControlBlock`, the canon's documented
          stacked exception for a control that needs the full content width: it
          is the EXACT string Copy writes, rendered from one source, because a
          preview assembled separately is a preview that can lie. */}
      <ControlBlock
        label={t("settings.about.diagnosticBlockLabel")}
        helper={t("settings.about.diagnosticBlockHelper")}
        anchorId="about.diagnostic-report"
        control={
          <>
            <pre style={PREVIEW_STYLE} data-testid="about.diagnostic-block-preview">
              {diagnosticBlock ?? ""}
            </pre>
            <div>
              <Button
                variant="secondary"
                disabled={diagnosticBlock === null}
                onClick={copyDiagnostics}
                data-testid="about.diagnostic-copy"
              >
                {t("settings.about.diagnosticCopy")}
              </Button>
            </div>
          </>
        }
      />

      {has("diagnosticLog") && (
        <>
          <SettingRow
            label={t("settings.about.diagnosticLogLabel")}
            helper={t("settings.about.diagnosticLogHelper")}
            error={diagnostics.error ? t("settings.about.diagnosticLogError") : null}
            anchorId="about.diagnostic-log"
            testId="about.diagnostic-log-row"
            helperTestId="about.diagnostic-log-helper"
            control={(helperId) => (
              <Switch
                checked={diagnostics.enabled}
                disabled={diagnostics.loading}
                onChange={(next) => {
                  void diagnostics.setEnabled(next);
                }}
                ariaLabel={t("settings.about.diagnosticLogLabel")}
                ariaDescribedBy={helperId}
                testId="about.diagnostic-log-toggle"
              />
            )}
          />

          {/* The crash record is shown rather than hidden: privacy requires a
              no-consent artefact's existence to be visible and its lifetime
              bounded, so a row appears whenever one exists and Delete is the
              manual half of that bound (a report that includes it clears it
              too). The row is absent, not disabled, when there is no record,
              because "no crash" is not a control. */}
          {diagnostics.crash !== null && (
            <SettingRow
              label={t("settings.about.crashRecordLabel")}
              helper={t("settings.about.crashRecordHelper", {
                date:
                  formatCrashDate(diagnostics.crash.at_epoch_seconds, i18n.language) ??
                  t("settings.about.crashRecordDateUnknown"),
              })}
              anchorId="about.crash-record"
              testId="about.crash-record-row"
              helperTestId="about.crash-record-helper"
              control={
                <Button
                  variant="secondary"
                  onClick={clearCrashFlow}
                  data-testid="about.crash-record-clear"
                >
                  {t("settings.about.crashRecordClear")}
                </Button>
              }
            />
          )}

          {/* What a saved report WOULD contain, before anything is written, and
              the two actions that move the log off the device: open the folder,
              or save one bundle. This is the disclosure half of the file-save
              decision: the user reads the size and the file count first, and can
              open the log itself with Reveal before deciding. */}
          <ControlBlock
            label={t("settings.about.diagnosticFilesLabel")}
            anchorId="about.diagnostic-report-files"
            control={
              <>
                <p style={HELPER_STYLE} data-testid="about.diagnostic-files-manifest">
                  {diagnostics.manifest === null
                    ? t("settings.about.diagnosticFilesUnknown")
                    : t("settings.about.diagnosticFilesHelper", {
                        count: diagnostics.manifest.log_files,
                        size: formatBytes(diagnostics.manifest.total_bytes),
                      })}
                </p>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <Button
                    variant="secondary"
                    onClick={revealFlow}
                    data-testid="about.diagnostic-reveal"
                  >
                    {t("settings.about.diagnosticReveal")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={diagnosticBlock === null}
                    onClick={saveReportFlow}
                    data-testid="about.diagnostic-save"
                  >
                    {t("settings.about.diagnosticSave")}
                  </Button>
                </div>
              </>
            }
          />
        </>
      )}

      <Block data-setting-anchor="about.changelog" data-setting-row="true">
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
