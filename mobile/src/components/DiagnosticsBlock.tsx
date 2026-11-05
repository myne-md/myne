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
// them — which is the whole reason the phone's surface is worth building.
//
// What is per-client is the reading: this file takes the environment from the MOBILE seam. The
// fields that genuinely do not apply here (no OPFS storage estimate on some platforms, no
// cross-origin isolation) are omitted by the builder itself, because it drops a field it has no
// reading for rather than printing a placeholder.
//
// # What is deliberately absent
//
// The diagnostic LOG and its toggle. Mobile answers `diagnosticLog: false`
// (`mobile/src/platform/capabilities.ts`, myne-md/myne#860): the file layer and its subscriber
// are desktop-only, and a toggle that writes nothing is worse than one line saying so.
//
// Nothing is transmitted. The only consumer is the Copy button the user presses.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildDiagnostics, engineLabel, mb, type HostWebView } from "@myne/diagnostics";
import { authorityToken, readVaultDoctor, sessionToken } from "@myne/vault-doctor";
import { invoke } from "../platform/core";
import { writeText as clipboardWriteText } from "../lib/clipboardTransport";
import { copyText } from "@myne/clipboard";
import { Button } from "./Button";
import { ListGroup } from "./list";

/** Which WebView this build runs in. Two clients, two answers, one label vocabulary. */
function hostWebView(): HostWebView | null {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android WebView";
  if (/iPhone|iPad|iPod|Macintosh/i.test(ua)) return "WKWebView";
  return null;
}

/** How long the vault read may take before the block is built without it. */
const DOCTOR_DEADLINE_MS = 2000;

function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The block, read once per mount. Returns `null` until the first read settles. */
async function collect(): Promise<string> {
  const doctor = await withinDeadline(readVaultDoctor(invoke), DOCTOR_DEADLINE_MS);
  let usage: StorageEstimate | null = null;
  try {
    usage = (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    // Permission- and engine-dependent; an unavailable reading drops the two storage lines.
  }
  return buildDiagnostics({
    version: __APP_VERSION__,
    channel: import.meta.env.MODE === "development" ? "Development" : "Stable",
    // Mobile's build injects no commit define: `null` omits the line rather than printing a
    // placeholder, which is the rule the block's own header states.
    commit: null,
    bundleHash: null,
    // Mobile installs no global-failure recorder, so there is no code to report. `none` is the
    // block's own spelling for "no failure was recorded", not a claim that the build is healthy.
    failureCode: "none",
    vaultGeneration: doctor?.generation ?? null,
    vaultAuthority: doctor ? authorityToken(doctor.authority) : null,
    vaultBinding: doctor?.binding ?? null,
    vaultKeyAtRest: doctor?.key_at_rest ?? null,
    vaultSession: doctor ? sessionToken(doctor.session) : null,
    engine: engineLabel(navigator.userAgent, hostWebView()),
    crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
    storageUsedMb: mb(usage?.usage),
    storageQuotaMb: mb(usage?.quota),
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
  const [failed, setFailed] = useState(false);

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
          setFailed(false);
          setCopied(true);
        },
      },
      onFailure: {
        kind: "inline",
        run: () => setFailed(true),
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
        {failed && (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--danger)", marginTop: "var(--space-2)" }}>
            {t("settings.about.diagnosticCopyFailed")}
          </div>
        )}
        <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", marginTop: "var(--space-2)" }}>
          {t("settings.about.diagnosticsLogNote")}
        </div>
      </div>
    </ListGroup>
  );
}
