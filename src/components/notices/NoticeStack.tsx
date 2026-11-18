// The bottom-centre notice slot, and the card that goes in it (myne-md/myne#1060).
//
// ── Why the notices moved here ────────────────────────────────────────────
//
// The sync-integrity alert, the reconcile notice, the credential-ambiguous
// refusal, the stale-sync warning, the Tor transport strip and the rekeyed
// elsewhere strip all rendered as full-width bands above the editor's three-pane
// row. That shape pushes the whole editor down (the note under the cursor moves
// while a banner appears), and it puts the message above the tab strip, which is
// the one part of the surface a reader stops looking at once the caret is in the
// note. The update notice solved both problems already (myne-md/myne#870): one
// card floating at the bottom centre of the window, in its own region, taking no
// clicks aimed at the editor behind it.
//
// So the notices borrow that treatment rather than a second positioning scheme:
// same bottom edge, same centred column, card instead of band, and severity
// carried by the tokens the palette already defines (`--warning`, `--danger`)
// rather than by a new colour per message.
//
// ── Why the stack publishes its height ────────────────────────────────────
//
// The update notice lives at the same edge (it is mounted by `App`, not by the
// editor, so it cannot be reordered from here). While a notice is showing, the
// notice column writes its own height into `--notice-stack-h` on the document
// element, and the update notice's bottom offset adds that variable. One value,
// one writer, and the two can never be drawn on top of each other.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { IconButton } from "../primitives/IconButton";

/** The custom property the update notice reads. Mirrored in `UpdateNotice.tsx`. */
export const NOTICE_STACK_HEIGHT_VAR = "--notice-stack-h";

const STACK_STYLE: CSSProperties = {
  // Fixed to the WINDOW rather than to the editor: a column centred in the pane
  // area drifts sideways with the split handles and reads as misplaced.
  position: "fixed",
  insetInline: 0,
  bottom: "calc(var(--space-5) + var(--space-6))",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "0 var(--space-4)",
  // The column spans the window, so it must not swallow clicks aimed at the
  // editor behind it. Its children re-enable them for themselves.
  pointerEvents: "none",
  // Below every modal step: a dialog opened over the editor covers a notice,
  // which is right — a notice is about the session, and a dialog has the floor.
  zIndex: "var(--z-floating)",
};

export interface NoticeStackProps {
  children: ReactNode;
}

/**
 * The slot. Renders nothing when there is nothing in it, which matters because
 * `SyncBanners` decides its own visibility and hands over a possibly-empty set.
 */
export function NoticeStack({ children }: NoticeStackProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    const root = document.documentElement;
    if (node === null) return undefined;
    const publish = () => {
      // The gap is included: the update notice sits one gap above the top card,
      // not flush against it.
      root.style.setProperty(
        NOTICE_STACK_HEIGHT_VAR,
        `${Math.ceil(node.getBoundingClientRect().height) + 8}px`,
      );
    };
    publish();
    // A card can reflow without a re-render (a wrapped sentence, a rotation), so
    // the height is observed rather than computed once at mount.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(NOTICE_STACK_HEIGHT_VAR);
    };
  }, []);

  return (
    <div style={STACK_STYLE} data-testid="notices.stack" ref={ref}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          width: "100%",
          maxWidth: 520,
          // The cards are the interactive part; the column around them is not.
          pointerEvents: "auto",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export type NoticeSeverity = "warning" | "danger" | "info";

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-4)",
  borderRadius: "var(--radius-3)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  // No shadow: `docs/design/README.md` admits one in four places and bans it on
  // the editor surface, which this floats over. The hairline is the whole
  // elevation treatment, exactly as on the update notice.
};

const SEVERITY_BORDER: Record<NoticeSeverity, string> = {
  warning: "1px solid var(--warning)",
  danger: "1px solid var(--danger)",
  info: "1px solid var(--line-2)",
};

export interface NoticeCardProps {
  severity: NoticeSeverity;
  /** `alert` for something wrong now, `status` for something to be aware of. */
  role?: "alert" | "status";
  testId: string;
  /** Omitted when the notice must not be dismissable; see each call site. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** The dismiss control's own id, when a caller already publishes one (the e2e
   *  suite asserts `sync.stale-dismiss`, and a rename there is a red suite for a
   *  reason nobody would guess). */
  dismissTestId?: string;
  /** Extra `data-*` attributes for the root, for a caller whose tests or a
   *  scenario already read one (the Tor strip publishes `data-posture`). */
  data?: Record<string, string>;
  children: ReactNode;
}

/** One notice. Bands became cards so a message about the session stops looking
 *  like part of the document it floats over. */
export function NoticeCard({
  severity,
  role = "status",
  testId,
  onDismiss,
  dismissLabel,
  dismissTestId,
  data,
  children,
}: NoticeCardProps) {
  return (
    <div
      role={role}
      data-testid={testId}
      data-severity={severity}
      {...Object.fromEntries(
        Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]),
      )}
      style={{ ...CARD_STYLE, border: SEVERITY_BORDER[severity] }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)" }}>
        <span style={{ flex: 1 }}>{children}</span>
        {onDismiss && (
          // The primitive rather than a hand-rolled "×": padding, hover, press
          // and focus are the same decisions every other close control makes.
          <span style={{ flexShrink: 0 }}>
            <IconButton
              icon="x"
              label={dismissLabel ?? ""}
              onClick={onDismiss}
              iconSize={14}
              testId={dismissTestId ?? `${testId}-dismiss`}
            />
          </span>
        )}
      </div>
    </div>
  );
}
