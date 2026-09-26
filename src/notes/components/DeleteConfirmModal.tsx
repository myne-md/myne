// `<DeleteConfirmModal>` — destructive confirmation for note delete.
//
// Design canon: Penpot `screen------delete-confirm-modal` (id
// `01376058-0c2f-8002-8008-0662574a8abb`), `flow--notes-sidebar` board.
// Pattern reuses the `<SettingsModal>` backdrop+modal envelope.
//
// Per Q14 d1 (modal confirmation, destructive irreversible) +
// `decisions.md` 2026-05-07 "Note delete cryptographic erase" (hard-
// delete; no soft-trash until MYND-133 / v0.2).
//
// PRD stories 35-38: title, body and warning copy, and the two-button row with
// the destructive `var(--warning)` fill.
//
// The KEYBOARD contract those stories originally specified was reversed by
// myne-md/myne#628; `docs/decisions/ui/0564` is the record and the effect below
// carries the reasoning. In one line: focus starts on the destructive button and
// Enter follows the focus ring, so the ring always names what Enter does.
// Escape, the backdrop and Tab-to-Cancel are the ways out.

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/**
 * One frame at 60 Hz, in milliseconds. The floor under the Enter guard's
 * "the dialog has been on screen long enough to have been read" test; see the
 * effect that uses it for why a paint alone is not enough of a signal.
 */
const ARM_AFTER_MS = 16;

// Shared modal backdrop envelope — also imported by `<TrashPanel>` so the two
// trash-related modals don't re-declare the same fixed-inset dim layer.
export const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const MODAL_STYLE: CSSProperties = {
  width: 380,
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-5)",
  fontFamily: "var(--font-sans)",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-md)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  margin: 0,
  marginBottom: "var(--space-3)",
};

const BODY_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-2)",
  margin: 0,
  marginBottom: "var(--space-1)",
  wordBreak: "break-word",
};

const BODY_WARNING_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  margin: 0,
  marginBottom: 20,
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
};

const BUTTON_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  padding: "8px 14px",
  borderRadius: "var(--radius-2)",
  cursor: "pointer",
  border: "1px solid transparent",
};

const CANCEL_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE_STYLE,
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-2)",
};

const DELETE_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE_STYLE,
  background: "var(--warning)",
  color: "var(--accent-on)",
  border: "1px solid var(--warning)",
};

export type DeleteConfirmModalProps = {
  /**
   * Single-note mode: the note title (or null → "Untitled"), rendered quoted
   * as the body line. Omit when supplying a custom `body` (e.g. empty-trash).
   */
  noteTitle?: string | null;
  /** Heading override. Default: "Delete this note?". */
  title?: string;
  /** Body line override (shown above the warning). Default: the quoted note title. */
  body?: string;
  /**
   * Warning line override (shown below the body, muted). Default:
   * "This cannot be undone." Pass a softer line for recoverable actions (e.g.
   * a folder delete that only soft-trashes its notes).
   */
  warning?: string;
  /** Confirm-button label override. Default: "Delete". */
  confirmLabel?: string;
  /**
   * Confirm-button `data-testid` override (curated-prop testid discipline,
   * src/AGENTS.md "Test observability"). Default: `"delete-confirm.confirm"`.
   * Callers whose E2E contract names a scoped confirm id (e.g. the
   * recovered-notes `sync.recovered-delete-confirm`) pass it here.
   */
  confirmTestId?: string;
  /**
   * Cancel-button `data-testid` override, symmetric with {@link confirmTestId}.
   * Default: `"delete-confirm.cancel"`. Callers whose E2E contract names a
   * scoped cancel id (e.g. the Archive folder-delete `archive.folder-delete-cancel`)
   * pass it here.
   */
  cancelTestId?: string;
  /**
   * Which button receives initial focus. Default `"confirm"`: the ring lands
   * on the destructive button, so Enter and the ring name the same action and
   * Escape (or the backdrop, or Tab to Cancel) is the way out
   * (myne-md/myne#628).
   *
   * `"cancel"` moves the ring back to Cancel, and because Enter follows the
   * ring, Enter there cancels. One call site uses it: the recovered-note delete
   * in `src/components/sync/RecoveredNotes.tsx`, which destroys the last copy
   * anywhere (quarantine is not in the `.myne-backup` container), so the
   * deliberate act there is a click or a Tab rather than a reflex.
   */
  initialFocus?: "cancel" | "confirm";
  /**
   * The activating gesture was a KEY rather than a pointer, so the key that
   * opened this dialog may still be down. Enter then refuses to confirm until
   * an Enter keyup has been seen: a held key emits repeats and no keyup, so it
   * cannot answer a dialog it opened.
   *
   * Default `false`, because for a pointer-opened dialog the first Enter is
   * always a deliberate new press and demanding a release would cost that press
   * for nothing. Pass the activating event's own answer rather than a constant:
   * a React `onClick` carries `detail === 0` exactly when the button was
   * activated from the keyboard.
   *
   * Set at the two `TrashPanel` purge buttons and at the palette's empty-trash
   * action, which are the openers that fire on Enter KEYDOWN and the two paths
   * that perform the cryptographic erase of `docs/decisions/storage/0105`.
   */
  openedByKey?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmModal(props: DeleteConfirmModalProps) {
  const { t } = useTranslation();
  const {
    noteTitle,
    title,
    body,
    warning,
    confirmLabel,
    confirmTestId,
    cancelTestId,
    initialFocus = "confirm",
    openedByKey,
    onCancel,
    onConfirm,
  } = props;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open. Default-focus the CONFIRM button, so the
  // focus ring sits on the action Enter performs; `initialFocus="cancel"` moves
  // it back. The modal only mounts while shown, so always enabled (MYND-93).
  useFocusTrap(dialogRef, {
    enabled: true,
    initialFocusRef: initialFocus === "confirm" ? confirmRef : cancelRef,
  });

  // Esc → Cancel, contained the same way Enter is.
  //
  // The listener is on `document`, so without the containment check an Escape
  // pressed inside a dialog STACKED over this one closes the one behind it, and
  // dismissing an `ThemeInstallDialog` that arrived from an OS deep link would
  // silently take the delete confirmation with it. Cancelling is benign next to
  // confirming, which is why Enter's version of this guard came first, but the
  // two handlers having different ideas of their own scope is not a state to
  // leave in place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dialogRef.current?.contains(document.activeElement) !== true) return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Enter follows the FOCUS RING, not a prop.
  //
  // That is the whole of what myne-md/myne#628 is about. The shipped dialog put
  // the ring on Cancel, the accent-filled primary styling on Delete, and made
  // Enter inert, so three things named three different actions. #397 had settled
  // on inert for a real reason (before it, Enter silently activated the focused
  // Cancel, a close indistinguishable from a successful delete) but inert left
  // a keyboard user with no way to say yes at all.
  //
  // Keying off `document.activeElement` answers both: the ring always names what
  // Enter does. Focus starts on the destructive button (`initialFocus`), so the
  // reflex press confirms; a user who deliberately Tabs to Cancel and presses
  // Enter cancels, which is what the ring under their finger promised. #397's
  // failure cannot recur, because it was the ring and the key disagreeing.
  //
  // The handler exists at all, rather than being left to the buttons' own
  // Enter-to-click, because the focus trap places focus asynchronously and a
  // focused <button>'s default activation is not fired reliably across WebViews
  // (WebKitGTK under the E2E harness), so relying on it alone drops the confirm.
  //
  // THREE GUARDS, and each closes a way this dialog could confirm without having
  // been read. None is a nicety: two of its call sites perform the cryptographic
  // erase of `docs/decisions/storage/0105`, where there is no undo and no copy
  // outside a `.myne-backup`.
  //
  //  1. `e.repeat`. Both openers of the permanent purge fire on Enter KEYDOWN
  //     (the palette action, and the Trash footer's focused button). The opening
  //     keydown is dispatched before this listener exists, but a HELD Enter
  //     auto-repeats, and every repeat after the first would otherwise land here
  //     and destroy the trash between two frames. At the merge base Enter was
  //     inert, so the same held key was harmless: making Enter act is what
  //     creates this, which is why the guard ships with it.
  //  2. One frame of arming, and it covers ONLY an Enter already in flight when
  //     the dialog appeared: a human cannot answer a dialog within the frame it
  //     appeared in, so an Enter arriving in that frame is not an answer to it.
  //     It is NOT the backstop for guard 1, and an earlier revision of this
  //     comment said it was. The arithmetic refutes that: OS typematic delay
  //     before the first auto-repeat is 250 ms to 660 ms on every platform this
  //     ships to, by which time both the paint and the wall clock below have
  //     armed the dialog, so a held Enter whose `repeat` flag was under-reported
  //     would have walked straight through. Guard 4 is what actually closes
  //     that, and it closes it without depending on a flag or on a clock.
  //     **A paint OR the elapsed time, and the disjunction is the whole point.**
  //     `requestAnimationFrame` is the better signal of the two, because it fires
  //     when the dialog has actually been PAINTED, which is what "could have been
  //     read" means. It is also a signal a WebView is free not to deliver, and
  //     under WebKitGTK it measurably does not: an instrumented E2E run of `nc5`
  //     captured `armed=false repeat=false contains=true
  //     active=delete-confirm.confirm` on a dialog that was visible in the
  //     screenshot taken from the same failure. The callback had not run, so Enter
  //     was inert for the full 45 s budget, three attempts over. A gate that can
  //     stay shut forever is not a gate, it is the #397 behaviour with extra
  //     steps, so `ARM_AFTER_MS` of wall clock arms it whether or not the frame
  //     callback ever arrives.
  //     **Armed once at MOUNT, which is why the callbacks come through a ref.**
  //     The obvious spelling, `[onCancel, onConfirm]` as the effect's deps,
  //     re-runs the whole effect whenever the PARENT hands down a new callback
  //     identity, and both of this modal's `NoteList` call sites do: the
  //     keyboard soft-trash's `onConfirm` closes over the very state that opened
  //     the dialog, so it is a new function on every render of a component whose
  //     sidebar re-renders on save settles, sync ticks and a relative-time
  //     ticker. Each of those re-runs put the arming back to false, so the guard
  //     stopped meaning "one frame since the dialog appeared" and started
  //     meaning "one frame since the list last re-rendered", which is a gate
  //     that can be shut when the user presses Enter. The same instrumented run
  //     counted one effect setup per mount, so this was NOT what `nc5` was
  //     failing on; it is a second way to reach the same inert Enter, found while
  //     looking for the first, and it is what makes the wall clock above measure
  //     from the dialog rather than from the list's last render.
  //  3. Containment. The listener is on `document`, so without this an Enter
  //     pressed in a dialog STACKED over this one confirms the one behind it.
  //     `ThemeInstallDialog` opens from an OS deep link, which can arrive over
  //     any modal already open, and focus inside it reads as "not Cancel". That
  //     is the ring and the key disagreeing again, one dialog over.
  //
  //  4. Key release, on the openers that fire on an Enter KEYDOWN. `openedByKey`
  //     says the activating gesture was a key, so the key may still be down when
  //     this listener is installed; Enter then refuses until an Enter keyup has
  //     been seen. A HELD key emits repeats and no keyup, so it cannot satisfy
  //     this by continuing to be held, and unlike guards 1 and 2 that is a
  //     property of the input rather than a flag the WebView reports or an
  //     interval the OS chooses. It costs a pointer-opened dialog nothing,
  //     because the default is off and the caller passes the activating event's
  //     own answer (`detail === 0` on a React `onClick` is keyboard activation).
  //
  // Containment is also what makes the confirm-on-unreadable fallback safe:
  // "unreadable" now means unreadable inside THIS dialog, where the trap has
  // already placed focus on the confirm button unless a caller asked otherwise.
  //
  // `docs/decisions/ui/0564` records the reversal, including what it costs on
  // the cryptographic-erase paths.
  const answerRef = useRef({ onCancel, onConfirm });
  useEffect(() => {
    answerRef.current = { onCancel, onConfirm };
  });
  useEffect(() => {
    const mountedAt = performance.now();
    let painted = false;
    const frame = requestAnimationFrame(() => {
      painted = true;
    });
    // Guard 4 starts shut only when the caller says the dialog was opened by a
    // key, and the first Enter keyup opens it. A key that is being HELD emits
    // repeats and no keyup, so this cannot be satisfied by continuing to hold.
    let released = openedByKey !== true;
    const isArmed = () => painted || performance.now() - mountedAt >= ARM_AFTER_MS;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (dialogRef.current?.contains(document.activeElement) !== true) return;
      // Swallowed even while disarmed: the point is that Enter does nothing
      // here, not that it falls through to whatever is behind the dialog.
      e.preventDefault();
      if (e.repeat || !isArmed() || !released) return;
      if (document.activeElement === cancelRef.current) answerRef.current.onCancel();
      else answerRef.current.onConfirm();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Enter") released = true;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [openedByKey]);

  const handleBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Only cancel if the click target IS the backdrop (not a child).
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  const displayTitle =
    noteTitle === null || noteTitle === undefined || noteTitle.trim() === ""
      ? t("notes.deleteConfirm.untitled")
      : noteTitle;
  const bodyLine = body ?? `“${displayTitle}”`;

  return (
    <div style={BACKDROP_STYLE} onClick={handleBackdropClick} role="presentation">
      <div
        ref={dialogRef}
        style={MODAL_STYLE}
        role="alertdialog"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-body"
      >
        <h2 id="delete-confirm-title" style={TITLE_STYLE}>
          {title ?? t("notes.deleteConfirm.title")}
        </h2>
        <p id="delete-confirm-body" style={BODY_TITLE_STYLE}>
          {bodyLine}
        </p>
        <p style={BODY_WARNING_STYLE}>
          {warning ?? t("notes.deleteConfirm.warning")}
        </p>
        <div style={BUTTON_ROW_STYLE}>
          <button
            ref={cancelRef}
            type="button"
            data-testid={cancelTestId ?? "delete-confirm.cancel"}
            onClick={onCancel}
            style={CANCEL_BUTTON_STYLE}
          >
            {t("notes.deleteConfirm.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid={confirmTestId ?? "delete-confirm.confirm"}
            onClick={onConfirm}
            style={DELETE_BUTTON_STYLE}
          >
            {confirmLabel ?? t("notes.deleteConfirm.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
