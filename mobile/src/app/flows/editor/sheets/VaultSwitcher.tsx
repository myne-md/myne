import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { Icon, Sheet, VaultMark } from "../../../../components";
import { vaultDisplayLabel } from "../../../../lib/vault-label";
import { stableVaultNumber } from "../../../../lib/vault-list";
import type { VaultSummary } from "../../../../types/vault-summary";

/** The sheet's footer actions (create / join) — one outlined row each. */
const sheetAction: CSSProperties = {
  marginTop: 12,
  width: "100%",
  height: 48,
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  background: "transparent",
  color: "var(--accent)",
  fontFamily: "var(--font-sans)",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};

/** Vault switcher sheet (the "Personal ▾" chevron's target). */
export function VaultSwitcher({
  vaults,
  activeId,
  onSelect,
  onCreate,
  onJoin,
  onClose,
}: {
  vaults: VaultSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Enter the sync-join flow — the second door, next to create (myne-mobile#40). */
  onJoin: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 2px 12px" }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{t("editor.vaultSwitcher.title")}</div>
        <button
          onClick={close}
          style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
        >
          {t("editor.sheet.done")}
        </button>
      </div>
      <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
        {vaults.map((v, i) => {
          const active = v.id === activeId;
          return (
            <div
              key={v.id}
              data-testid="switcher.vault-row"
              data-vault-id={v.id}
              onClick={() => onSelect(v.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "13px 14px",
                borderTop: i === 0 ? undefined : "1px solid var(--line-1)",
                cursor: "pointer",
              }}
            >
              {/* At most ONE row ever shows a glyph: the icon is encrypted-only
                  (SYNC-3) and the RAM cache holds it for the sole Unlocked vault
                  (SYNC-1), so every other row's wordmark is correctness, not a
                  missing feature. */}
              <VaultMark icon={v.icon} size={22} radius={4} testId="switcher.vault-mark" />
              {/* The SAME number the picker shows (myne-md/myne#411). This
                  passed no ordinal at all, so every unnamed vault read a bare
                  "Vault" and the sheet could offer three rows a user had no way
                  to tell apart. Sharing `stableVaultNumber` also stops the two
                  surfaces disagreeing: a vault that is "Vault 2" on the picker
                  the user just came from must not be "Vault 3" here. */}
              <span style={{ flex: 1, fontSize: 16, color: "var(--fg-1)" }}>
                {vaultDisplayLabel(v.label, stableVaultNumber(vaults, v.id))}
              </span>
              {active && <Icon name="check" size={18} color="var(--accent)" strokeWidth={2} />}
            </div>
          );
        })}
      </div>
      {/* Both doors, not just create (myne-mobile#40): this sheet and the vault
          picker are the only surfaces a device with vaults ever sees, so a
          create-only footer strands "connect to my account" entirely. */}
      <button onClick={onCreate} style={sheetAction}>
        <Icon name="plus" size={18} color="var(--accent)" strokeWidth={2} />
        {t("welcome.createCta")}
      </button>
      <button onClick={onJoin} style={sheetAction} data-testid="switcher.join-account">
        <Icon name="link" size={18} color="var(--accent)" strokeWidth={2} />
        {t("welcome.connect")}
      </button>
        </>
      )}
    </Sheet>
  );
}
