import { useTranslation } from "react-i18next";
import { Icon, MyneMark, LIST_TOP } from "../../../../components";

/** Consistent top bar shared by the Notes / Search / Graph / Files tabs: vault
 *  switcher on the left; command-palette search + Settings gear on the right.
 *  Stays fixed while the tab content below it animates between pages. */
export function AppHeader({ label, onSwitcher, onPalette, onSettings }: { label: string; onSwitcher: () => void; onPalette: () => void; onSettings: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="workspace.app-header" style={{ flex: "none", padding: `${LIST_TOP} 14px 6px 20px`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <button
        onClick={onSwitcher}
        style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", padding: 0, cursor: "pointer", minWidth: 0 }}
      >
        <MyneMark size={22} radius={4} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <button
          onClick={onPalette}
          aria-label={t("commandPalette.dialogLabel")}
          style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <Icon name="search" size={21} color="var(--fg-2)" strokeWidth={1.7} />
        </button>
        <button
          onClick={onSettings}
          aria-label={t("editor.chrome.barItems.settings")}
          style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <Icon name="settings" size={21} color="var(--fg-2)" strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
