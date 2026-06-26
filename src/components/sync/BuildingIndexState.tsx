// Cold-start "building index…" state (MYND-426 task 7) — shown in the search
// surface until the first local index rebuild completes (post full-reconcile or a
// fresh device enroll, when vault.search/vault.indices are re-derived rather than
// synced, MYND-426 task 3). Progressive-available search is deferred to v1.x;
// v1 shows this honest building state, then search works normally (incremental).
// Penpot skipped per the owner directive; built against design tokens.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../Spinner";

const STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-2)",
  padding: "var(--space-5)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

interface BuildingIndexStateProps {
  /** True while the first local search index is still being built. */
  building: boolean;
}

export function BuildingIndexState({ building }: BuildingIndexStateProps) {
  const { t } = useTranslation();
  if (!building) return null;
  return (
    <div role="status" data-testid="sync.building-index" style={STYLE}>
      <Spinner />
      <span>{t("sync.buildingIndex.label")}</span>
    </div>
  );
}
