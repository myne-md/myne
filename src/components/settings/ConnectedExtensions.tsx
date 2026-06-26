// Settings → Account → Connected extensions (ext-foundation-handoff task 7,
// MYND-443).
//
// Lists the live (non-revoked) browser extensions paired with this vault and
// offers a per-row Revoke. Revoke is desktop-authoritative — immediate +
// durable on the Rust side (the token is dropped from the encrypted prefs
// blob). This UI only surfaces the list + the revoke gesture; the extension's
// re-pair prompt is its own side (out of scope here), so the section carries a
// one-line hint that a revoked extension must pair again.
//
// Account is its home (decisions.md 2026-06-21, moved from Privacy): connected
// extensions are account-level paired devices, sitting alongside the vault label,
// change-password, and danger-zone controls. It is an inline section, NOT a 7th
// Settings rail panel.
//
// The list/Revoke wrappers are mocked in tests; in a non-Tauri context (dev)
// `invoke` rejects — treat that as "no connected extensions", never throw.

import { useEffect, useState } from "react";
import {
  listPairedExtensions,
  revokePairedExtension,
  type PairedExtension,
} from "../../lib/clipper-pairing";
import {
  CONNECTED_EXTENSIONS_EMPTY,
  CONNECTED_EXTENSIONS_HELPER,
  CONNECTED_EXTENSIONS_REPAIR_HINT,
  CONNECTED_EXTENSIONS_REVOKE_LABEL,
  CONNECTED_EXTENSIONS_TITLE,
} from "../../lib/load-bearing-copy";
import { Button } from "../primitives/Button";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";
import { BrowserIcon, browserLabel } from "./browser-icons";
import i18n from "../../i18n";

const ROW_STYLE = {
  display: "flex",
  flexDirection: "row" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const LIST_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "var(--space-2)",
  marginTop: "var(--space-1)",
};

// A row's left cluster: the browser glyph + a stacked name / "connected when".
const ROW_TEXT_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  minWidth: 0,
};

// The PRIMARY line — the browser the extension runs in (derived from the id).
const BROWSER_STYLE = {
  fontSize: "var(--text-sm)",
  fontWeight: 500,
  color: "var(--fg-1)",
};

// The SECONDARY line — when the pairing was made (muted).
const WHEN_STYLE = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

/**
 * "Connected <relative time>" from the issue timestamp (Unix seconds), or a bare
 * "Connected" for a pre-feature record with no timestamp. Computed at render —
 * the panel is transient, so no live ticking is needed.
 */
function connectedWhen(pairedAt: number | null): string {
  if (pairedAt === null) return i18n.t("settings.connectedExtensions.when.bare");
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - pairedAt);
  if (secs < 60) return i18n.t("settings.connectedExtensions.when.justNow");
  if (secs < 3600)
    return i18n.t("settings.connectedExtensions.when.minutesAgo", {
      count: Math.floor(secs / 60),
    });
  if (secs < 86400)
    return i18n.t("settings.connectedExtensions.when.hoursAgo", {
      count: Math.floor(secs / 3600),
    });
  const days = Math.floor(secs / 86400);
  if (days < 30)
    return i18n.t("settings.connectedExtensions.when.daysAgo", { count: days });
  return i18n.t("settings.connectedExtensions.when.onDate", {
    date: new Date(pairedAt * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  });
}

export function ConnectedExtensions() {
  const [paired, setPaired] = useState<PairedExtension[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // Fetch the paired list on mount. In a non-Tauri context (dev/tests) invoke
  // rejects — treat that as "none connected", never throw.
  useEffect(() => {
    let alive = true;
    listPairedExtensions()
      .then((rows) => {
        if (alive) setPaired(rows);
      })
      .catch(() => {
        if (alive) setPaired([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function refresh() {
    try {
      setPaired(await listPairedExtensions());
    } catch {
      setPaired([]);
    }
  }

  async function onRevoke(extensionId: string) {
    setBusy(extensionId);
    try {
      await revokePairedExtension(extensionId);
      await refresh();
    } catch {
      // Leave the list as-is; the next mount/refresh re-reads the source of
      // truth. Never surfaces a token or partial state.
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={BLOCK_STYLE} data-testid="settings.connected-extensions">
      <span style={LABEL_STYLE}>{CONNECTED_EXTENSIONS_TITLE}</span>
      <p style={HELPER_STYLE}>{CONNECTED_EXTENSIONS_HELPER}</p>

      {paired.length === 0 ? (
        <p style={HELPER_STYLE} data-testid="settings.connected-extensions-empty">
          {CONNECTED_EXTENSIONS_EMPTY}
        </p>
      ) : (
        <>
          <div style={LIST_STYLE}>
            {paired.map((ext) => (
              <div
                key={ext.extensionId}
                style={ROW_STYLE}
                data-testid="settings.connected-extension-row"
                data-extension-id={ext.extensionId}
                title={ext.extensionId}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    minWidth: 0,
                  }}
                >
                  <BrowserIcon extensionId={ext.extensionId} />
                  <div style={ROW_TEXT_STYLE}>
                    <span style={BROWSER_STYLE}>{browserLabel(ext.extensionId)}</span>
                    <span style={WHEN_STYLE}>{connectedWhen(ext.pairedAt)}</span>
                  </div>
                </div>
                <Button
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void onRevoke(ext.extensionId)}
                  data-testid="settings.revoke-extension"
                  data-extension-id={ext.extensionId}
                >
                  {CONNECTED_EXTENSIONS_REVOKE_LABEL}
                </Button>
              </div>
            ))}
          </div>
          <p style={HELPER_STYLE}>{CONNECTED_EXTENSIONS_REPAIR_HINT}</p>
        </>
      )}
    </div>
  );
}
