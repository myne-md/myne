// The single toast surface (#238). Subscribes to the store and renders every
// live toast as one collapsed stack in the bottom inline-end corner, raised
// clear of the bottom bar: the newest toast is fully shown, older ones peek
// behind it — scaled down and nudged up — the way Sonner/Vercel stack. All
// toasts share one fixed width, so the stack is visually uniform.
//
// Mounted exactly ONCE (App.tsx). Every toast — React-surface (via the
// headless <Toast> bridge) or the editor's imperative showAttachmentToast (via
// the registered sink) — flows through here, so they all look and stack alike.

import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { Icon } from "../primitives/Icon";
import type { IconName } from "../../lib/icons";
import { useTranslation } from "react-i18next";
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastItem,
  type ToastVariant,
} from "./toastStore";

/** Vertical peek (px) each toast is nudged up behind the one in front. */
const PEEK = 14;
/** Scale shrink per depth. */
const SCALE_STEP = 0.06;
/** Toasts deeper than this are fully hidden behind the stack. */
const MAX_VISIBLE = 3;
/** Exit-slide duration (ms). Matches --duration-base in tokens.css. */
const EXIT_MS = 180;

const VARIANT_ICON: Record<ToastVariant, IconName | null> = {
  neutral: null,
  success: "circle-check",
  error: "circle-alert",
  info: "info",
};

type Phase = "entering" | "visible" | "leaving";
type Row = { item: ToastItem; phase: Phase };

export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const [rows, setRows] = useState<Row[]>([]);
  const [hovered, setHovered] = useState(false);

  // Presence: rows lag the store so a removed toast can play its exit before it
  // leaves the DOM.
  useEffect(() => {
    setRows((prev) => {
      const live = new Set(items.map((i) => i.id));
      const next: Row[] = [];
      // Keep existing rows; mark any whose item left the store as leaving.
      for (const row of prev) {
        if (live.has(row.item.id)) next.push(row);
        else if (row.phase !== "leaving") next.push({ ...row, phase: "leaving" });
        else next.push(row);
      }
      // Append newly-added items as entering.
      const known = new Set(prev.map((r) => r.item.id));
      for (const item of items) {
        if (!known.has(item.id)) next.push({ item, phase: "entering" });
      }
      // Order by id so the newest is always last (front of the stack).
      next.sort((a, b) => a.item.id - b.item.id);
      return next;
    });
  }, [items]);

  // Drop leaving rows once their exit has run.
  useEffect(() => {
    if (!rows.some((r) => r.phase === "leaving")) return;
    const id = window.setTimeout(() => {
      setRows((prev) => prev.filter((r) => r.phase !== "leaving"));
    }, EXIT_MS);
    return () => window.clearTimeout(id);
  }, [rows]);

  if (rows.length === 0) return null;

  const n = rows.length;

  return (
    <ol className="myne-toaster" data-testid="toaster">
      {rows.map((row, i) => (
        <ToastRow
          key={row.item.id}
          row={row}
          posFromFront={n - 1 - i}
          paused={hovered}
          onHover={setHovered}
          onExpire={() => dismissToast(row.item.id)}
          onDismiss={() => dismissToast(row.item.id)}
          onEntered={() =>
            setRows((prev) =>
              prev.map((r) =>
                r.item.id === row.item.id && r.phase === "entering"
                  ? { ...r, phase: "visible" }
                  : r,
              ),
            )
          }
        />
      ))}
    </ol>
  );
}

function ToastRow({
  row,
  posFromFront,
  paused,
  onHover,
  onExpire,
  onDismiss,
  onEntered,
}: {
  row: Row;
  posFromFront: number;
  paused: boolean;
  onHover: (hovered: boolean) => void;
  onExpire: () => void;
  onDismiss: () => void;
  onEntered: () => void;
}) {
  const { t } = useTranslation();
  const { item, phase } = row;

  // entering → visible on the next frame, so the enter transition runs.
  useEffect(() => {
    if (phase !== "entering") return;
    const raf = requestAnimationFrame(() => onEntered());
    return () => cancelAnimationFrame(raf);
    // onEntered is stable enough; keying on phase is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Auto-dismiss — paused while the stack is hovered (so a message being read is
  // never yanked away) and while leaving. Not re-armed by parent re-renders.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    if (phase === "leaving" || paused) return;
    const id = window.setTimeout(() => onExpireRef.current(), item.durationMs);
    return () => window.clearTimeout(id);
  }, [phase, paused, item.durationMs, item.id]);

  const hidden = posFromFront >= MAX_VISIBLE;
  const offscreen = phase !== "visible";
  const scale = Math.max(0.8, 1 - posFromFront * SCALE_STEP);
  const y = -posFromFront * PEEK;
  const slide = offscreen ? "translateX(var(--toast-off-x)) " : "";

  const iconName = VARIANT_ICON[item.variant];

  return (
    <li
      className="myne-toast-row"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        transform: `${slide}translateY(${y}px) scale(${scale})`,
        opacity: offscreen || hidden ? 0 : 1,
        zIndex: 1000 - posFromFront,
        pointerEvents: hidden ? "none" : "auto",
      }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid={item.testId ?? "editor.toast"}
        className={`myne-toast myne-toast--${item.variant}`}
        data-toast-state={phase}
      >
        {iconName !== null && (
          <span className="myne-toast__icon" aria-hidden="true">
            <Icon name={iconName} size={16} />
          </span>
        )}
        {/* The message carries its own testid because reading it positionally
            does not work and silently looks like it does. A toast with an icon
            renders the icon span FIRST, and that span's textContent is empty
            (it holds an SVG), so `toast.querySelector("span").textContent` is
            "" — which a scenario polling for the message reads as "no toast
            yet" until its budget runs out. Four E2E call sites did exactly
            that; the ones that passed were the variants that happen to render
            no icon. */}
        <span className="myne-toast__msg" data-testid="editor.toast-message">
          {item.message}
        </span>
        {item.action !== undefined && (
          <button
            type="button"
            className="myne-toast__action"
            onClick={item.action.onAction}
            data-testid="editor.toast-action"
          >
            {item.action.label}
          </button>
        )}
        <button
          type="button"
          className="myne-toast__dismiss"
          onClick={onDismiss}
          aria-label={t("common.dismiss")}
          data-testid="editor.toast-dismiss"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </li>
  );
}
