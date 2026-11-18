// The desktop update notice (myne-md/myne#870).
//
// One strip floating at the bottom centre of the editor, in three states: the
// offer, the confirm it expands into, and the pill it falls back to after it has
// announced itself. The container owns which state is live and every side
// effect; this file takes the state as props, so each state is directly
// renderable in a story and a test with nothing faked.
//
// Placement, and why not the toast corner: the toast stack is a set of notices
// that EXPIRE (`src/components/toast/toastStore.ts`, default 2.5s, 6s with an
// action). This offer has to survive until it is answered, so it gets its own
// region and the store's contract stays a true statement about toasts.
//
// No shadow. `docs/design/README.md` admits one in four places and bans it on
// the editor surface, which this floats over, so the hairline border is the
// whole elevation treatment.
//
// The vault consequence is on this surface BEFORE the press, and the press opens
// a confirm instead of starting the install: confirming locks the vault, which
// ends the session, and that is not a one-click decision. `blocked` is how a
// confirm that could not start says so, because the two ways it can refuse (a
// pane that would not save, a vault that would not lock) happen BEFORE the stage
// changes, so the updating screen never mounts and this card is the only surface
// left to report them on.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";

export type UpdateNoticeView = "offer" | "confirm" | "pill";

/** Why a confirmed update never started. Rendered on the confirm itself. */
export type UpdateNoticeBlock = "flush" | "lock" | "stage";

export interface UpdateNoticeProps {
  /** Which state to draw. The container owns the transitions between them. */
  view: UpdateNoticeView;
  /** The version on offer, as the manifest reports it. */
  version: string;
  /**
   * Release notes from the manifest. The host already sends them
   * (`UpdateStatus.available.notes`) and they were rendered nowhere until this
   * surface; nullable, because a manifest may carry none.
   */
  notes?: string | null;
  /** True from the confirm's press until the install resolves. */
  working?: boolean;
  /** Set when the flow refused to start. Null while it has not refused. */
  blocked?: UpdateNoticeBlock | null;
  /** The offer's own press. Expands the notice rather than installing. */
  onRequestUpdate: () => void;
  /** The confirm's press. Flushes the panes, locks the vault, then installs. */
  onConfirm: () => void;
  /** Back out of the confirm, keeping the offer. */
  onCancel: () => void;
  /** Dismiss for the session. */
  onLater: () => void;
  /** Reopening the pill, which is the only way back to the offer. */
  onReopen: () => void;
}

const WRAP_STYLE: CSSProperties = {
  // Full width and centred on the WINDOW, not on the pane area: a bar centred
  // inside the editor drifts sideways with the split handles and reads as a
  // mispositioned element.
  position: "fixed",
  insetInline: 0,
  // `--notice-stack-h` is the height the bottom-centre notice column published
  // while something is showing there (myne-md/myne#1060), so an offer and a
  // warning never land on top of each other. Zero when the column is empty.
  bottom: "calc(var(--notice-stack-h, 0px) + var(--space-5) + var(--space-6))",
  display: "flex",
  justifyContent: "center",
  // The row spans the window, so it must not swallow clicks aimed at the editor
  // behind it. The card re-enables them for itself.
  pointerEvents: "none",
  // Below every modal step on purpose: a dialog opened over the editor covers
  // this, including the Settings panel whose own install button reaches the same
  // flow. `--z-floating` is the rung for a surface that floats over editor
  // content without out-ranking one, and the ladder's rule is to take the rung
  // naming the role rather than a value chosen to beat a neighbour.
  zIndex: "var(--z-floating)",
};

const CARD_STYLE: CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  maxWidth: 420,
  padding: "var(--space-3) var(--space-4)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
};

const TITLE_STYLE: CSSProperties = {
  color: "var(--fg-1)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-semibold)",
};

const NOTES_STYLE: CSSProperties = {
  color: "var(--fg-2)",
  // Four lines then an ellipsis: release notes are prose of unknown length, and
  // an offer that grows to a page is not an offer.
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 4,
  overflow: "hidden",
  whiteSpace: "pre-wrap",
};

const CONSEQUENCE_STYLE: CSSProperties = {
  color: "var(--fg-3)",
};

const BLOCKED_STYLE: CSSProperties = {
  color: "var(--danger)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-1)",
};

const PILL_STYLE: CSSProperties = {
  pointerEvents: "auto",
  // A pill rather than a text button: the caller's style wins on specificity by
  // design (`Button`'s own contract), so the shape lives here and the primitive
  // keeps the focus treatment, the press feedback and the disabled handling.
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-pill)",
  color: "var(--fg-2)",
};

const PILL_VERSION_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--fg-3)",
  marginInlineStart: "var(--space-2)",
};

export function UpdateNotice({
  view,
  version,
  notes,
  working = false,
  blocked = null,
  onRequestUpdate,
  onConfirm,
  onCancel,
  onLater,
  onReopen,
}: UpdateNoticeProps) {
  const { t } = useTranslation();

  if (view === "pill") {
    return (
      <div style={WRAP_STYLE}>
        <Button
          icon="arrow-down"
          style={PILL_STYLE}
          data-testid="update.notice-pill"
          onClick={onReopen}
        >
          <span>{t("update.notice.pill")}</span>
          <span style={PILL_VERSION_STYLE}>{version}</span>
        </Button>
      </div>
    );
  }

  const confirming = view === "confirm";
  return (
    <div style={WRAP_STYLE}>
      <div
        className="myne-update-notice"
        style={CARD_STYLE}
        data-testid={confirming ? "update.notice-confirm" : "update.notice"}
      >
        {/* `status` on the MESSAGE rather than on the card: a live region that
            contains the action buttons re-announces them every time the view
            changes, and the buttons are reachable by Tab regardless. */}
        <div
          role="status"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
        >
          <span style={TITLE_STYLE}>
            {confirming
              ? t("update.notice.confirmTitle")
              : t("update.notice.available", { version })}
          </span>
          {!confirming && notes ? <span style={NOTES_STYLE}>{notes}</span> : null}
          <span style={CONSEQUENCE_STYLE}>
            {confirming
              ? t("update.notice.confirmBody")
              : t("update.notice.consequence")}
          </span>
          {blocked !== null && (
            <span style={BLOCKED_STYLE} data-testid="update.notice-blocked">
              {blocked === "flush"
                ? t("update.notice.flushFailed")
                : blocked === "lock"
                  ? t("update.notice.lockFailed")
                  : t("update.notice.stageFailed")}
            </span>
          )}
        </div>
        <div style={ACTIONS_STYLE}>
          {confirming ? (
            <>
              <Button
                variant="ghost"
                disabled={working}
                onClick={onCancel}
                data-testid="update.notice-cancel"
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={working}
                onClick={onConfirm}
                data-testid="update.notice-confirm-primary"
              >
                {t("update.notice.confirmPrimary")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={onLater}
                data-testid="update.notice-later"
              >
                {t("update.notice.later")}
              </Button>
              <Button
                variant="primary"
                onClick={onRequestUpdate}
                data-testid="update.notice-primary"
              >
                {t("update.notice.primary")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
