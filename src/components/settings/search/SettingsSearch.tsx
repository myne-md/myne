// Settings search input (MYND-536). Sits at the TOP of the left rail, above the
// panel tab list. Controlled by the SettingsModal, which owns the query and
// swaps the content pane to results when it is non-empty. Built against the
// DESIGN.md tokens (HotkeysPanel `SEARCH_INPUT_STYLE` precedent).

import {
  forwardRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../primitives/Icon";

// A slim block at the top of the rail; a hairline separates it from the tabs.
const ROW_STYLE: CSSProperties = {
  flex: "0 0 auto",
  padding: "var(--space-3) var(--space-3) var(--space-2)",
  borderBottom: "1px solid var(--line-1)",
  background: "transparent",
};

const FIELD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  width: "100%",
  boxSizing: "border-box",
  padding: "var(--space-1) var(--space-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2, 6px)",
  color: "var(--fg-3)",
  transition:
    "border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)",
};

// Focus lives on the wrapper (the inner input keeps `outline:none`): an accent
// border + a soft accent-tinted ring, driven by onFocus/onBlur since the project
// styles inline (no :focus-within). MYND-536.
const FIELD_FOCUS_STYLE: CSSProperties = {
  borderColor: "var(--accent)",
  boxShadow: "0 0 0 3px var(--accent-soft)",
};

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: "none",
  // Kill WebKit/WebView's native control focus ring on the inner <input> — focus
  // is shown on the wrapper instead. `outline:none` alone doesn't suppress the
  // native ring; appearance:none does. The `:focus-visible` case is covered by a
  // global rule in tokens.css (inline styles can't target it).
  appearance: "none",
  WebkitAppearance: "none",
  boxShadow: "none",
  background: "transparent",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

interface SettingsSearchProps {
  query: string;
  onQueryChange: (next: string) => void;
  /** Keydown on the input — SettingsModal wires arrow/enter/escape (Task 5). */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** id of the active descendant result for aria (Task 5); omitted otherwise. */
  activeDescendantId?: string;
}

export const SettingsSearch = forwardRef<HTMLInputElement, SettingsSearchProps>(
  function SettingsSearch({ query, onQueryChange, onKeyDown, activeDescendantId }, ref) {
    const { t } = useTranslation();
    const [focused, setFocused] = useState(false);
    return (
      <div style={ROW_STYLE}>
        <div style={focused ? { ...FIELD_STYLE, ...FIELD_FOCUS_STYLE } : FIELD_STYLE}>
          <Icon name="search" size={14} />
          <input
            ref={ref}
            type="text"
            role="combobox"
            aria-expanded={query.trim() !== ""}
            // Only reference the listbox while it is actually rendered (a
            // non-empty query); an empty box has no results element to control.
            aria-controls={
              query.trim() !== "" ? "settings-search-results" : undefined
            }
            aria-activedescendant={activeDescendantId}
            aria-label={t("settings.search.ariaLabel")}
            placeholder={t("settings.search.placeholder")}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={INPUT_STYLE}
            data-testid="settings.search-input"
          />
        </div>
      </div>
    );
  },
);
