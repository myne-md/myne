import { useEffect, useState } from "react";
import { Screen, ScreenScroll, Title, FooterBar, Button, Banner, Spinner, MyneMark } from "../../components";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { ioBanner } from "../../lib/io-banner";
import { HAS_TAURI } from "../../lib/app-window";
import type { VaultSummary } from "../../types/vault-summary";
import type { PickerFlowProps } from "./types";

/**
 * MV-01 · Vault picker — wired. The ≥2-vault startup surface (Stage `picker`).
 * On mount it enumerates discovered vaults (`vault_list`), orders them by
 * last-unlock (SYNC-7), and renders one row per vault. Tapping a row routes to
 * that vault's unlock screen (`onSelect(id, fromPicker=true)`); the footer
 * routes into vault creation (`onCreate`). Carries no secret material — the
 * list is the DENY-list-clean `VaultSummary` projection only.
 */

/** Dot palette for labeled vaults (cycled by position); placeholder rows use a muted dot. */
const DOT_PALETTE = [
  "var(--label-slate)",
  "var(--label-moss)",
  "var(--label-clay)",
  "var(--label-ochre)",
  "var(--label-plum)",
  "var(--label-stone)",
];

/** Browser-dev (no Tauri host) demo data so the picker is navigable under `pnpm dev`. */
const PLACEHOLDER_VAULTS: VaultSummary[] = [
  {
    id: "00000000-0000-7000-8000-000000000001",
    status: { kind: "Exists" },
    label: "Personal",
    last_unlock: Date.now() - 2 * 60 * 1000,
  },
  {
    id: "00000000-0000-7000-8000-000000000002",
    status: { kind: "Exists" },
    label: "Work",
    last_unlock: Date.now() - 26 * 60 * 60 * 1000,
  },
];

/** Relative "opened …" copy from an epoch-ms last-unlock (mirrors the MV-01 static copy). */
function openedWhen(ms: number | null): string {
  if (ms === null) return "Never opened";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 45) return "opened just now";
  const min = Math.round(sec / 60);
  if (min < 2) return "opened a minute ago";
  if (min < 60) return `opened ${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 2) return "opened an hour ago";
  if (hr < 24) return `opened ${hr} hours ago`;
  const day = Math.round(hr / 24);
  if (day < 2) return "opened yesterday";
  if (day < 7) return `opened ${day} days ago`;
  const wk = Math.round(day / 7);
  if (wk < 2) return "opened last week";
  if (wk < 5) return `opened ${wk} weeks ago`;
  const mo = Math.round(day / 30);
  if (mo < 2) return "opened last month";
  if (mo < 12) return `opened ${mo} months ago`;
  const yr = Math.round(day / 365);
  if (yr < 2) return "opened last year";
  return `opened ${yr} years ago`;
}

/** Thin chevron-right (8×14, line-2 stroke) — the MV-01 row affordance. */
function RowChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14">
      <path
        d="M1 1l6 6-6 6"
        stroke="var(--line-2)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VaultRow({
  dot,
  name,
  when,
  italic,
  corrupted,
  onClick,
}: {
  dot: string;
  name: string;
  when: string;
  italic: boolean;
  corrupted: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        textAlign: "left",
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "14px 14px",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          flex: "none",
          width: 30,
          height: 30,
          borderRadius: 7,
          background: "var(--ink-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
          <path d="M8 22 V10 L16 18 L24 10 V22" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ flex: "none", width: 8, height: 8, borderRadius: 2, background: dot }} />
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: italic ? "var(--fg-3)" : "var(--fg-1)",
              fontStyle: italic ? "italic" : undefined,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          {corrupted && (
            <span
              style={{
                flex: "none",
                borderRadius: 999,
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.02em",
                background: "var(--danger-soft)",
                color: "var(--danger)",
              }}
            >
              Corrupted
            </span>
          )}
        </div>
        <div style={{ marginTop: 2, fontSize: 13, color: "var(--fg-3)" }}>{when}</div>
      </div>
      <RowChevron />
    </button>
  );
}

export function PickerFlow({ onSelect, onCreate }: PickerFlowProps) {
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [ioError, setIoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!HAS_TAURI) {
        // Browser dev (no Tauri host) — show demo vaults so the picker is
        // navigable under `pnpm dev`. Real enumeration needs `pnpm tauri dev`.
        if (!cancelled) setVaults(orderByLastUnlock(PLACEHOLDER_VAULTS));
        return;
      }
      const result = await listVaults();
      if (cancelled) return;
      if ("ok" in result) {
        setVaults(orderByLastUnlock(result.ok));
      } else {
        setIoError(ioBanner(result.err.detail.io_error_kind));
        setVaults([]);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Screen>
      <div style={{ flex: "none", padding: "80px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
        <MyneMark size={26} radius={6} />
        <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
      </div>
      <div style={{ flex: "none", padding: "22px 24px 6px" }}>
        <Title style={{ fontSize: 27 }}>Choose a vault</Title>
      </div>

      <ScreenScroll style={{ padding: "10px 16px" }}>
        {vaults === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
            <Spinner />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ioError && <Banner kind="danger">{ioError}</Banner>}
            {vaults.map((vault, i) => {
              const corrupted = vault.status.kind === "Corrupted";
              const labeled = vault.label !== null;
              return (
                <VaultRow
                  key={vault.id}
                  dot={labeled ? DOT_PALETTE[i % DOT_PALETTE.length] : "var(--line-2)"}
                  name={vault.label ?? `Vault ${i + 1}`}
                  when={openedWhen(vault.last_unlock)}
                  italic={!labeled}
                  corrupted={corrupted}
                  onClick={() => onSelect(vault.id, true)}
                />
              );
            })}
          </div>
        )}
      </ScreenScroll>

      <FooterBar style={{ flexDirection: "column", padding: "14px 20px 44px" }}>
        <Button variant="secondary" style={{ height: 48, color: "var(--fg-1)" }} onClick={onCreate}>
          Create another vault
        </Button>
      </FooterBar>
    </Screen>
  );
}
