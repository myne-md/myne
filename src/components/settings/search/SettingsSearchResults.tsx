// Settings search results (MYND-536). Renders the matches for the current query
// as a panel-grouped listbox, or an explicit empty state. Selecting a row (click,
// or Enter on the keyboard-active row — Task 5) navigates to the owning panel and
// scrolls/flashes the setting (Task 4, via `onSelect`). Code-first against
// DESIGN.md tokens.

import { Fragment, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsIndexEntry } from "./settingsSearchIndex";
import { groupResultsByPanel } from "./resultsGrouping";
import { panelLabelKey } from "./searchSettings";

const ROOT_STYLE: CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const GROUP_HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  margin: "var(--space-3) 0 var(--space-1)",
};

const ROW_BASE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  width: "100%",
  textAlign: "left",
  border: 0,
  background: "transparent",
  cursor: "pointer",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-1, 4px)",
  fontFamily: "var(--font-sans)",
};

const ROW_ACTIVE_STYLE: CSSProperties = {
  ...ROW_BASE_STYLE,
  background: "var(--paper-3)",
};

const ROW_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
};

const EMPTY_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  color: "var(--fg-3)",
  padding: "var(--space-4) var(--space-3)",
};

interface SettingsSearchResultsProps {
  results: SettingsIndexEntry[];
  query: string;
  /** Keyboard-active entry id (Task 5); undefined → no active highlight. */
  activeId?: string;
  onSelect: (entry: SettingsIndexEntry) => void;
}

export function SettingsSearchResults({
  results,
  query,
  activeId,
  onSelect,
}: SettingsSearchResultsProps) {
  const { t } = useTranslation();

  if (results.length === 0) {
    return (
      <div
        id="settings-search-results"
        role="listbox"
        aria-label={t("settings.search.resultsLabel")}
        style={ROOT_STYLE}
      >
        <p role="status" style={EMPTY_STYLE} data-testid="settings.search-empty">
          {t("settings.search.empty", { query })}
        </p>
      </div>
    );
  }

  const groups = groupResultsByPanel(results);

  return (
    <div
      id="settings-search-results"
      role="listbox"
      aria-label={t("settings.search.resultsLabel")}
      style={ROOT_STYLE}
      data-testid="settings.search-results"
    >
      {groups.map((group) => (
        <Fragment key={group.panelId}>
          <div role="presentation" style={GROUP_HEADING_STYLE}>
            {t(panelLabelKey(group.panelId))}
          </div>
          {group.entries.map((entry) => {
            const active = entry.id === activeId;
            return (
              <button
                type="button"
                key={entry.id}
                id={`settings-search-result-${entry.id}`}
                role="option"
                aria-selected={active}
                data-testid="settings.search-result"
                data-setting-id={entry.id}
                data-panel={entry.panelId}
                data-active={active ? "true" : "false"}
                onClick={() => onSelect(entry)}
                style={active ? ROW_ACTIVE_STYLE : ROW_BASE_STYLE}
              >
                <span style={ROW_TITLE_STYLE}>{t(entry.titleKey)}</span>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
