// Styled account-chip vault switcher (MYND-205, multi-vault sub-feature 4
// task 5). Replaces the interim `SwitchVaultTrigger` seam (task 4) with the
// canonical account-chip + dropdown.
//
// Mounts in the sticky sidebar header (the account-chip location — the brand's
// signature element, `docs/design/README.md` "the sidebar header (account chip
// + new-note button) is sticky"), above the "Notes" eyebrow row in `NoteList`.
// The dropdown opens DOWNWARD from there (the bottom-bar predecessor opened
// upward).
//
// The account chip is the brand's signature element (`docs/design/README.md`
// "Account chip"). Clicking it opens a `--shadow-2` dropdown listing every
// discovered vault (`listVaults()`), ordered by last-unlock (top = current).
// Selecting a non-active row calls `onSwitchVault(id)` (App.tsx's `switchVault`
// orchestration: param-less `vault_lock()` → route to the target's unlock
// screen) and shows the transient "switching…" caption on that row; selecting
// the active vault is a no-op. A footer routes to vault creation
// ("Create another vault" → `onCreateAnother` → `editor.create-vault`).
//
// The whole switcher hides when fewer than two vaults exist (nothing to switch
// to — the create path is still reachable from the command palette / picker).
//
// Penpot canon: `flow--vault-switcher (MYND-205)`, page "4c - Navigation &
// Sidebar". Tokens-only (no raw hex, no Tailwind) per `src/CLAUDE.md`.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./primitives/Icon";
import { listVaults, orderByLastUnlock } from "../lib/vault-list";
import { formatRelativeTime, useTick } from "../notes/components/relativeTime";
import type { VaultId } from "../lib/stage";
import type { VaultSummary } from "../types/vault-summary";

interface VaultSwitcherProps {
  /**
   * Switch to the chosen (non-active) vault. App.tsx's `switchVault` fires the
   * param-less `vault_lock()` then routes to the target's unlock screen
   * (SYNC-6/8). Selecting the active vault never calls this (no-op).
   */
  onSwitchVault: (targetVaultId: VaultId) => void;
  /**
   * Route to vault creation from the dropdown's "Create another vault" footer.
   * App.tsx dispatches `editor.create-vault` → the existing vault-creation
   * flow (the same target as the picker's "Create another" affordance).
   */
  onCreateAnother: () => void;
  /**
   * True while a switch's `vault_lock()` IPC is in flight (the "switching…"
   * window). Disables the chip + marks the most-recently-selected row.
   */
  switching: boolean;
}

// ── Account-chip trigger ─────────────────────────────────────────────────

function chipStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    // Notion-style full-width workspace switcher row at the top of the sidebar
    // (MYND-166): mark + vault name (flex) + chevron, left-aligned, no border,
    // subtle `--paper-3` fill on hover/open.
    width: "100%",
    padding: "6px 8px",
    boxSizing: "border-box",
    background: active ? "var(--paper-3)" : "transparent",
    border: 0,
    borderRadius: "var(--radius-2)",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "var(--font-sans)",
  };
}

const CHIP_MARK_STYLE: CSSProperties = {
  width: 22,
  height: 22,
  flexShrink: 0,
  borderRadius: "var(--radius-1)",
  background: "var(--ink-1)",
  color: "var(--paper)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
};

const CHIP_LABEL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--ink-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const CHIP_GLYPH_STYLE: CSSProperties = {
  color: "var(--ink-3)",
  display: "flex",
};

// ── Dropdown menu ────────────────────────────────────────────────────────

const MENU_STYLE: CSSProperties = {
  // Opens downward — the account chip is the sticky sidebar header (top of the
  // left sidebar), so the dropdown drops below it (`docs/design/README.md`
  // "the sidebar header … is sticky"; Penpot `flow--vault-switcher`, page
  // "4c - Navigation & Sidebar"). `fixed` (anchored via menuPos) instead of
  // `absolute` so the sidebar pane's `overflow: hidden` can't clip it.
  position: "fixed",
  minWidth: 260,
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  padding: 6,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  zIndex: 60,
};

function rowStyle(state: "active" | "hover" | "rest"): CSSProperties {
  return {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: 48,
    boxSizing: "border-box",
    padding: 8,
    background:
      state === "active"
        ? "var(--accent-soft)"
        : state === "hover"
          ? "var(--paper-3)"
          : "transparent",
    border: 0,
    borderRadius: "var(--radius-1)",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "var(--font-sans)",
  };
}

const ROW_LEAD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const ROW_TEXT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  minWidth: 0,
};

function rowNameStyle(opts: {
  active: boolean;
  fallback: boolean;
}): CSSProperties {
  return {
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: opts.active ? 600 : 500,
    // Fallback ("Vault N") names demote to `--ink-2`; real names are `--ink-1`.
    color: opts.fallback ? "var(--ink-2)" : "var(--ink-1)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

function rowCaptionStyle(saving: boolean): CSSProperties {
  return {
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    color: saving ? "var(--accent)" : "var(--ink-3)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

const DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  border: 0,
  margin: "6px 0",
  alignSelf: "stretch",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  width: "100%",
  boxSizing: "border-box",
  height: 40,
  padding: 8,
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--accent)",
};

export function VaultSwitcher({
  onSwitchVault,
  onCreateAnother,
  switching,
}: VaultSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Open/close is animated (fade + slide), so the menu must outlive `open` by
  // one transition on close. `mounted` keeps the menu in the DOM while the
  // closing transition plays; `visible` is the animation target (true = shown,
  // false = the hidden/translated end-state the transition eases to/from).
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The dropdown is `position: fixed` (anchored under the chip via
  // getBoundingClientRect), not `absolute` — the left SidebarPane now clips
  // its content with `overflow: hidden` (for the collapse/expand animation),
  // which would otherwise crop the menu (and its shadow) since the sidebar can
  // be as narrow as 200px while the menu is ≥260px. Fixed positioning escapes
  // that clip, matching ContextMenu/DecorationPopover.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The row the user just selected to switch to — drives the "switching…"
  // caption + loader on that exact row while `switching` is true.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Re-render on the shared 30s tick so the last-unlock captions stay current.
  useTick();

  // Probe `listVaults()` on mount and on each open so the menu reflects fresh
  // labels (e.g. after a rename in Settings) + last-unlock ordering.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listVaults().then(
        (res) => {
          if (cancelled) return;
          setVaults("ok" in res ? res.ok : []);
        },
        () => {
          if (!cancelled) setVaults([]);
        },
      );
    };
    refresh();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Dismiss on Esc / outside-click while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    // Defer the outside-click listener so the opening click itself doesn't
    // immediately close the menu.
    const id = window.setTimeout(() => window.addEventListener("click", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      window.clearTimeout(id);
    };
  }, [open]);

  // Anchor the fixed-position menu under the chip. Measured before paint
  // (useLayoutEffect) when opening, so the menu never flashes at the wrong
  // spot. The wrapper is always mounted, so its rect is the chip's box even
  // before the menu itself mounts.
  useLayoutEffect(() => {
    if (!open) return;
    const node = containerRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    setMenuPos({ left: rect.left, top: rect.bottom + 6 });
  }, [open]);

  // Drive the open/close transition off `open` (user intent).
  //   open  → mount with the hidden start-state, then flip `visible` after a
  //           DOUBLE rAF. One frame isn't enough: React commits `mounted` and
  //           the rAF can run in the same frame, so the browser never paints
  //           the `opacity:0` start-state and skips the transition. The second
  //           rAF guarantees the start-state is painted before `visible` flips.
  //   close → flip `visible` off (plays the exit transition), then unmount
  //           once it finishes (--duration-base). Reduced-motion zeroes the
  //           duration globally, so the timeout just unmounts a hair later.
  useEffect(() => {
    if (open) {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setVisible(false);
    closeTimer.current = setTimeout(() => {
      setMounted(false);
      closeTimer.current = null;
    }, 180);
    return () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [open]);

  // Clear the per-row pending marker once a switch settles (App flips
  // `switching` back to false on lock resolve/reject).
  useEffect(() => {
    if (!switching) setPendingId(null);
  }, [switching]);

  const ordered = useMemo(
    () => (vaults === null ? [] : orderByLastUnlock(vaults)),
    [vaults],
  );
  // Top row (most-recent last-unlock) is the active/current vault under SYNC-1.
  const activeId = ordered.length > 0 ? ordered[0].id : null;

  // Hide the switcher only when no vault exists (count known, zero entries).
  // At exactly one vault it still renders: the dropdown shows the current vault
  // plus the "Create another vault" footer — the sole affordance for growing a
  // single-vault install into multi-vault (the picker only appears at >=2, so
  // gating the switcher at >=2 too would leave no way to ever create a 2nd
  // vault). Kept present while the count is unknown (vaults === null) to avoid
  // a layout flash.
  if (vaults !== null && ordered.length < 1) return null;

  const chipLabel =
    activeId !== null
      ? ordered[0].label ?? t("vaultSwitcher.vaultFallback", { n: 1 })
      : t("vaultSwitcher.chipFallback");

  return (
    <div style={{ position: "relative", width: "100%" }} ref={containerRef}>
      <button
        type="button"
        disabled={switching}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "var(--paper-3)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
        aria-label={t("vaultSwitcher.switchVaultLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="switcher.chip"
        style={{
          ...chipStyle(open),
          opacity: switching ? 0.6 : 1,
          cursor: switching ? "default" : "pointer",
        }}
      >
        <span style={CHIP_MARK_STYLE} aria-hidden="true">
          M
        </span>
        <span style={CHIP_LABEL_STYLE}>{chipLabel}</span>
        <span style={CHIP_GLYPH_STYLE} aria-hidden="true">
          <Icon name="chevrons-up-down" size={14} />
        </span>
      </button>

      {mounted && vaults !== null && (
        <div
          role="menu"
          style={{
            ...MENU_STYLE,
            left: menuPos.left,
            top: menuPos.top,
            // Fade + slide-down from the chip. Symmetric: the same transition
            // runs on close (visible → false) before the deferred unmount.
            transformOrigin: "top left",
            opacity: visible ? 1 : 0,
            transform: visible ? "translateY(0)" : "translateY(-4px)",
            transition:
              "opacity var(--duration-base) var(--ease-standard), transform var(--duration-base) var(--ease-standard)",
            // While closing (visible=false but still mounted) the menu is
            // invisible but present — don't let it swallow clicks.
            pointerEvents: visible ? "auto" : "none",
          }}
        >
          {ordered.map((v, i) => {
            const isActive = v.id === activeId;
            const isFallback = v.label == null;
            const name = v.label ?? t("vaultSwitcher.vaultFallback", { n: i + 1 });
            const isSaving = switching && pendingId === v.id;
            const isHover = hoveredId === v.id && !isActive;
            const rowState: "active" | "hover" | "rest" = isActive
              ? "active"
              : isHover
                ? "hover"
                : "rest";
            const caption = isSaving
              ? t("vaultSwitcher.switching")
              : v.last_unlock !== null
                ? formatRelativeTime(new Date(v.last_unlock))
                : "";
            return (
              <button
                key={v.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                data-testid="switcher.vault-row"
                data-vault-id={v.id}
                data-active={isActive}
                onClick={() => {
                  if (isActive) {
                    // Selecting the active vault is a no-op; just dismiss.
                    setOpen(false);
                    return;
                  }
                  setPendingId(v.id);
                  setOpen(false);
                  onSwitchVault(v.id);
                }}
                onMouseEnter={() => setHoveredId(v.id)}
                onMouseLeave={() =>
                  setHoveredId((cur) => (cur === v.id ? null : cur))
                }
                style={rowStyle(rowState)}
              >
                <span style={ROW_LEAD_STYLE}>
                  <span style={ROW_TEXT_STYLE}>
                    <span
                      style={rowNameStyle({
                        active: isActive,
                        fallback: isFallback,
                      })}
                    >
                      {name}
                    </span>
                    {caption !== "" && (
                      <span style={rowCaptionStyle(isSaving)}>{caption}</span>
                    )}
                  </span>
                </span>
                {isSaving ? (
                  <Icon
                    name="loader-circle"
                    size={16}
                    style={{ color: "var(--accent)", flexShrink: 0 }}
                  />
                ) : isActive ? (
                  <Icon
                    name="check"
                    size={16}
                    style={{ color: "var(--accent)", flexShrink: 0 }}
                  />
                ) : null}
              </button>
            );
          })}

          <hr style={DIVIDER_STYLE} aria-hidden="true" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCreateAnother();
            }}
            style={FOOTER_STYLE}
            data-testid="switcher.create-cta"
          >
            <Icon name="plus" size={16} style={{ flexShrink: 0 }} />
            <span>{t("vaultSwitcher.createAnother")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
