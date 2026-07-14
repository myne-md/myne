import { useTranslation } from "react-i18next";
import { Icon, MyneMark, Sheet } from "../../../../components";
import { vaultDisplayLabel } from "../../../../lib/vault-label";
import type { VaultSummary } from "../../../../types/vault-summary";

/** Vault switcher sheet (the "Personal ▾" chevron's target). */
export function VaultSwitcher({
  vaults,
  activeId,
  onSelect,
  onCreate,
  onClose,
}: {
  vaults: VaultSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
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
              <MyneMark size={22} radius={4} />
              <span style={{ flex: 1, fontSize: 16, color: "var(--fg-1)" }}>{vaultDisplayLabel(v.label)}</span>
              {active && <Icon name="check" size={18} color="var(--accent)" strokeWidth={2} />}
            </div>
          );
        })}
      </div>
      <button
        onClick={onCreate}
        style={{
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
        }}
      >
        <Icon name="plus" size={18} color="var(--accent)" strokeWidth={2} />
        {t("editor.vaultSwitcher.createNewVault")}
      </button>
        </>
      )}
    </Sheet>
  );
}
