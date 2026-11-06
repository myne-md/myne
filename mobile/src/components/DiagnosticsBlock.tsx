// Diagnostics on the phone, from the same allowlist the desktop panel uses.
//
// # Why this exists
//
// The desktop has had a Diagnostics panel since 2026-10-25 and the phone has had none, which
// meant a phone could not say what its own sync was doing. On 2026-11-05 that cost a day: a
// published vault could not sign a head, every cycle ran pull-only, and the only surface that
// could have said `vaultAuthority: missing:key_missing_while_bound` was on the other machine.
//
// # What is shared, and what is not
//
// The BLOCK is built by `@myne/diagnostics` (`buildDiagnostics`), the pure allowlist the desktop
// panel also calls, over the vault-doctor mirror in `@myne/vault-doctor`. So a phone's paste and
// a computer's paste carry the same field names in the same order, and a maintainer can diff
// them, which is the whole reason the phone's surface is worth building.
//
// What is per-client is the reading: this file takes the environment from the MOBILE seam. The
// fields that genuinely do not apply here (no OPFS storage estimate on some platforms, no
// cross-origin isolation) are omitted by the builder itself, because it drops a field it has no
// reading for rather than printing a placeholder.
//
// # What is deliberately absent
//
// The diagnostic LOG and its toggle. Mobile answers `diagnosticLog: false`
// (`mobile/src/platform/capabilities.ts`, myne-md/myne#860): the saved file layer and its
// subscriber are desktop-only, and a toggle that writes nothing is worse than one line saying so.
// What the phone DOES have is the platform log: `tracing_subscriber::fmt()` is installed
// unconditionally in `mobile/src-tauri/src/lib.rs`, so the app's traced events reach logcat or the
// Xcode console. This block cannot hand that over, which is what the note under the button says.
//
// Nothing is transmitted. The only consumer is the Copy button the user presses.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { gatherDiagnostics, webViewLabel } from "@myne/diagnostics-gather";
import { invoke } from "../platform/core";
import { writeText as clipboardWriteText } from "../lib/clipboardTransport";
import { copyText } from "@myne/clipboard";
import { Button } from "./Button";
import { showToast } from "./ToastHost";
import { ListGroup } from "./list";

/** The block, read once per mount, through the ONE gather both clients use.
 *
 * The phone answers four of `DiagnosticsEnv` with a "this build has no reading" value rather
 * than a guess, and those omissions are the block's own rule (a field without a reading is
 * absent, never a placeholder): mobile's build injects no commit or bundle hash define, and no
 * global-failure recorder exists on this client, so `none` is the block's spelling for "no
 * failure was recorded" rather than a claim that the build is healthy.
 */
function collect(): Promise<string> {
  return gatherDiagnostics({
    call: invoke,
    // A browser-shaped UA on the phone answers `null`: this client has no GTK fallback.
    webView: webViewLabel(navigator.userAgent, null),
    commit: null,
    bundleHash: null,
    failureCode: "none",
  });
}

/**
 * The diagnostic block and its Copy control, for the Settings sheet.
 *
 * Copy feedback lives ON the control (a tick and a label change for 1.6 s) plus a visually
 * hidden live region, never in a toast: this is the copy pattern the owner asked for everywhere
 * a copy button exists, and the phone is where it matters most, because a toast on a sheet is
 * easy to miss and the next paste is what proves it worked.
 */
export function DiagnosticsBlock() {
  const { t } = useTranslation();
  const [block, setBlock] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void collect()
      .then((value) => {
        if (!cancelled) setBlock(value);
      })
      .catch(() => {
        // Leave the preview empty rather than record a rejection this panel caused.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const onCopy = () => {
    if (block === null) return;
    void copyText(clipboardWriteText, block, {
      // `inline` rather than `toast`, because the confirmation belongs ON the control (a tick and
      // a label change for 1.6 s) plus the hidden live region below: that is the copy pattern the
      // owner asked for everywhere, and a toast over a settings sheet is the easiest thing to
      // miss before pasting.
      onSuccess: {
        kind: "inline",
        run: () => {
          setCopied(true);
        },
      },
      // A FAILURE is the one case that goes to a toast: `copyText`'s own contract keeps the
      // confirmation on the pressed control and reserves the toast for the path where the button
      // cannot say anything true about itself (a control that did nothing and silently went back
      // to its resting label reads as a copy that worked).
      onFailure: {
        kind: "toast",
        run: () => showToast(t("settings.about.diagnosticCopyFailed")),
      },
    });
  };

  return (
    <ListGroup>
      <div style={{ padding: "var(--space-3) var(--space-3)" }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", marginBottom: "var(--space-2)" }}>
          {t("settings.about.diagnosticsIntro")}
        </div>
        <pre
          data-testid="settings.diagnostics.block"
          style={{
            margin: 0,
            padding: "var(--space-2)",
            borderRadius: "var(--radius-2)",
            background: "var(--bg-2)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: "var(--leading-relaxed)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "13rem",
            overflowY: "auto",
          }}
        >
          {block ?? t("settings.about.diagnosticsReading")}
        </pre>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          <Button
            variant="secondary"
            onClick={onCopy}
            disabled={block === null}
            data-testid="settings.diagnostics.copy"
          >
            {copied ? t("settings.about.diagnosticCopied") : t("settings.about.diagnosticCopy")}
          </Button>
          <span
            role="status"
            aria-live="polite"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              overflow: "hidden",
              clip: "rect(0 0 0 0)",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? t("settings.about.diagnosticCopyDone") : ""}
          </span>
        </div>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", marginTop: "var(--space-2)" }}>
          {t("settings.about.diagnosticsLogNote")}
        </div>
        <div
          data-testid="settings.diagnostics.unknown-note"
          style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", marginTop: "var(--space-2)" }}
        >
          {/* The vault's five facts are the one place this block can carry the word
              `unknown`, and it is a real answer there rather than a placeholder: the
              doctor says so when the question was never asked (myne-md/myne#1003).
              Measured on an owner's paste from this client, four in a row read as
              four faults (myne-md/myne#1029). */}
          {t("settings.about.diagnosticUnknownNote")}
        </div>
      </div>
    </ListGroup>
  );
}
