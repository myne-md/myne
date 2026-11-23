// Settings → Diagnostics (2026-10-25 owner request: "move the diagnostic part of
// About to a tab of its own").
//
// It was the last section of `AboutPanel`, which is a panel about WHAT THIS BUILD
// IS (version, build channel, commit, licence, the update machinery). Diagnostics is
// about WHAT IS GOING WRONG, and it is the surface a user reaches for when something
// has already failed: four blocks of it sat under a version string, and the search
// box was the only way to find them without scrolling past the legal links.
//
// **Not behind Developer mode, deliberately, and that is a decision rather than an
// omission** (the comment on the switch below carries it): the gate hides
// capabilities a normal user does not configure, and this is the front door of a
// feature built for the user who has hit a bug.
//
// The i18n keys keep their `settings.about.` prefix. They are catalog ids that no
// user sees, and renaming them would move thirty-three catalogs for a naming
// preference: the honest place to record why a key and its panel disagree is here,
// not in a key name nobody reads.
//
// The rail entry carries NO capability. The report block renders on every client
// on purpose (a browser user cannot open a devtools panel and read a failure back
// to anyone, so the copy is the half that matters most there); only the logging
// half is gated, and a panel that disappeared on web would hide the universal half.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { has } from "../../platform/capabilities";
import { useDiagnostics } from "../../hooks/useDiagnostics";
import { copyText } from "../../lib/clipboard";
import { collectDiagnostics } from "../../lib/collect-diagnostics";
import { lastGlobalFailure } from "../../lib/global-failure";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { toast } from "../toast/toastStore";
import { Button } from "../primitives/Button";
import { Switch } from "../primitives/Switch";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE, PANEL_ROOT_STYLE } from "./panel-styles";

/**
 * The diagnostics preview readout.
 *
 * The field shape (a monospace value on a `--paper-2` inset) without the field
 * behaviour: this `<pre>` is read-only and never resized, so it takes no
 * `resize` and instead sets `white-space: pre-wrap` with `overflow-wrap: anywhere`.
 * The longest line is a 64-hex bundle hash, which has no break opportunity, so
 * without both properties it paints past the panel's right edge in the
 * narrow-dialog state the Settings shell supports.
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
 * diagnostic fact rendered once in a settings panel. An unreadable record reads as
 * an unknown date rather than as "just now", because a zero here means "present but
 * unreadable" (see `src-tauri/src/logging/crash.rs`).
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
 * Coarse on purpose, and it matches the block's own storage figures: a maintainer
 * reading it needs the order of magnitude, and a byte-exact number in a settings row
 * is precision nobody acts on.
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

export function DiagnosticsPanel() {
  const { t, i18n } = useTranslation();
  // The opt-in diagnostic log and the one crash record (myne-md/myne#860).
  // Host-owned rather than prefs, so they carry their own hook; absent on web, where
  // the whole logging half is (a served bundle installs no subscriber), which is why
  // the surface is gated rather than disabled.
  const diagnostics = useDiagnostics();
  // The exact string Copy puts on the clipboard, assembled through the existing
  // block builder and environment collector. Kept in state rather than rendered from
  // a second call, because the preview must be byte-identical to the copy and one
  // source is the only way to guarantee that.
  const [diagnosticBlock, setDiagnosticBlock] = useState<string | null>(null);
  useEffect(() => {
    // NOT gated on the capability: the block and its Copy button render on every
    // client, so the block has to be assembled on every client. Gating this read
    // would leave the web preview permanently empty while the capability descriptor
    // promised a working copy.
    let cancelled = false;
    // The recorded global failure goes in as the block's `failureCode`. This is the
    // second reader of `global-failure.ts`: the installer already runs at boot
    // (`main.tsx`), and until this panel existed nothing read what it recorded.
    void collectDiagnostics(lastGlobalFailure() ?? "none")
      .then((block) => {
        if (!cancelled) setDiagnosticBlock(block);
      })
      .catch(() => {
        // An unhandled rejection here would be recorded by the installed global
        // handler as `unhandled-rejection`, which would stamp this panel's own failed
        // promise into the very `failureCode` the block reads back. Leave the preview
        // empty instead; the readout is not worth a global-failure class it did not
        // cause.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Copy reports BOTH outcomes through the one transport (`src/lib/clipboard.ts`),
  // which is the rule `scripts/check-clipboard-feedback.mjs` enforces: a failed copy
  // that looks like a successful one is how a user pastes the previous clipboard
  // contents believing they are their diagnostics.
  const copyDiagnostics = () => {
    if (diagnosticBlock === null) return;
    void copyText(clipboardWriteText, diagnosticBlock, {
      onSuccess: {
        kind: "toast",
        run: () => {
          toast({ message: t("settings.about.diagnosticCopyDone"), variant: "info" });
        },
      },
      onFailure: {
        kind: "toast",
        run: () => {
          toast({ message: t("settings.about.diagnosticCopyFailed"), variant: "error" });
        },
      },
    });
  };
  // Save asks for a destination first, and reports three outcomes: a CANCELLED
  // dialog is silent, because nothing was attempted; a completed save confirms; and a
  // refused dialog or a failed write reports the failure rather than folding into
  // "cancelled". The manifest re-reads afterwards, because a bundle that included the
  // crash record clears it, so the row above changes as a consequence.
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
  // folder-open or delete through it would tell the user a control they never touched
  // had failed.
  const revealFlow = () => {
    void diagnostics.reveal().then((opened) => {
      if (opened) return;
      toast({ message: t("settings.about.diagnosticRevealFailed"), variant: "error" });
    });
  };
  const clearCrashFlow = () => {
    void diagnostics.clearCrash().then((cleared) => {
      if (cleared) return;
      toast({ message: t("settings.about.crashRecordClearFailed"), variant: "error" });
    });
  };
  // The log row's error text, split by what failed. A READ failure gets its own
  // sentence because the change sentence says "Myne could not change that setting",
  // which is false of a read that runs on mount with the switch still off and
  // untouched: the row would report a failed change beside an untouched control.
  const diagnosticLogError =
    diagnostics.error === null
      ? null
      : diagnostics.error.source === "read"
        ? t("settings.about.diagnosticLogReadError")
        : t("settings.about.diagnosticLogError");

  return (
    // `SettingsSectionCounter` around a panel whose only section repeats the
    // panel's own name: the counter's documented "alone in its topic" arm drops the
    // visible heading and keeps the `<section aria-label>` and the seam. Without it
    // the rail would say Diagnostics and the panel would say it again three pixels
    // lower.
    <SettingsSectionCounter>
    <div style={PANEL_ROOT_STYLE} data-testid="settings.diagnostics-panel">
      <SettingsSection title={t("settings.about.sections.diagnostics")}>
        <ControlBlock
          label={t("settings.about.diagnosticBlockLabel")}
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
              error={diagnosticLogError}
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
                because "no crash" is not a control.

                A REFUSED read is the third state, and it renders its own line
                rather than nothing: an absent row would be indistinguishable from
                the host answering "no record", which is the one thing a no-consent
                artefact's disclosure must not hide. Delete is not offered here,
                because it is the record's absence that is unknown. */}
            {diagnostics.crashReadFailed ? (
              <Block data-setting-anchor="about.crash-record" data-setting-row="true">
                <span style={LABEL_STYLE}>{t("settings.about.crashRecordLabel")}</span>
                <p style={HELPER_STYLE} data-testid="about.crash-record-read-failed">
                  {t("settings.about.crashRecordReadFailed")}
                </p>
              </Block>
            ) : diagnostics.crash !== null ? (
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
            ) : null}

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
      </SettingsSection>
    </div>
    </SettingsSectionCounter>
  );
}
