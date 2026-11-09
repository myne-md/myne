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
// myne-md/myne#628; `design-notes/ui/0564` is the record and the effect below
// carries the reasoning. In one line: focus starts on the destructive button and
// Enter follows the focus ring, so the ring always names what Enter does.
// Escape, the backdrop and Tab-to-Cancel are the ways out. myne-md/myne#683
// replaced that effect's timing guard with a comparison on the key itself
// (`design-notes/ui/0685`), which is why there is no arming window below.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";

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
   * for nothing.
   *
   * **Answer whether the key can still be DOWN, not merely whether a key did
   * it.** `detail === 0` on a React `onClick` says the button was activated from
   * the keyboard, and that is not the same question: a `<button>` activates on
   * Enter's KEYDOWN and on Space's KEYUP, so a Space-activated click leaves no
   * key held and passing `true` for it shuts this guard with nothing able to
   * open it. `TrashPanel.purgeOpenedByHeldEnter` is the worked answer, and the
   * palette's Enter keydown (`CommandPalette.runRow(row, true)`) is the other.
   *
   * Set at the two `TrashPanel` purge buttons and at the palette's empty-trash
   * action, which are the openers that fire on Enter KEYDOWN and the two paths
   * that perform the cryptographic erase of `design-notes/storage/0105`.
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
  // FOUR GUARDS, and each closes a way this dialog could confirm without having
  // been read. None is a nicety: two of its call sites perform the cryptographic
  // erase of `design-notes/storage/0105`, where there is no undo and no copy
  // outside a `.myne-backup`.
  //
  //  1. `e.repeat`. Both openers of the permanent purge fire on Enter KEYDOWN
  //     (the palette action, and the Trash footer's focused button). The opening
  //     keydown is dispatched before this listener exists, but a HELD Enter
  //     auto-repeats, and every repeat after the first would otherwise land here
  //     and destroy the trash between two frames. At the merge base Enter was
  //     inert, so the same held key was harmless: making Enter act is what
  //     creates this, which is why the guard ships with it.
  //  2. The key must be NEWER than the dialog, and that is a comparison rather
  //     than a wait. Both readings come from one clock: the mount instant is a
  //     synthetic event's `timeStamp`, which is the current high-resolution time,
  //     and `e.timeStamp` is the same reading for a dispatched key. So an Enter
  //     whose own timestamp predates the instant this dialog entered the document
  //     is an Enter that was already in flight when the dialog appeared, and it is
  //     not an answer to it. An Enter created after that instant is. Written
  //     against a shared time origin between an event stamp and `performance.now()`
  //     instead, the guard would be silently permissive on any engine where the two
  //     disagree, which is jsdom, the pinned test environment, and is why the
  //     comparison is anchored this way rather than measured-and-hoped.
  //
  //     It is NOT the backstop for guard 1: OS typematic delay before the first
  //     auto-repeat is 250 ms to 660 ms on every platform this ships to, by which
  //     time the dialog is far older than any key still in flight, so a held
  //     Enter whose `repeat` flag was under-reported would pass. Guard 4 is what
  //     actually closes that, and it closes it without depending on a flag or a
  //     clock.
  //     **The comparison is strict, and that is the deliberate direction.** A key
  //     whose stamp falls in the same coarsened bucket as the mount (the clock can
  //     be quantized to a millisecond or two) is admitted. `<=` would refuse a
  //     press created in the mount's own bucket, which is a millisecond of the
  //     #683 defect back, and the resolution is too coarse for "same bucket" to
  //     mean "in flight". The in-flight keys that matter on the two erase paths
  //     are refused by guard 4 instead, from the input rather than from a clock.
  //     **This replaced a 16 ms wall clock, and the difference is not
  //     cosmetic (myne-md/myne#683).** The window was measured from the moment
  //     this effect RAN rather than from the moment the dialog APPEARED, and it
  //     was a proxy for "in flight" that admits the opposite answer: it refuses
  //     any press inside the window, whoever made it and however long the dialog
  //     has really been up. Measured in the E2E container under load, with
  //     `MYNE_E2E_RETRIES=0`, on the folder-delete dialog: the arming effect ran
  //     1 ms after its own commit (`setupLag: [1, 1]`), the harness's press
  //     arrived 10 to 14 ms after that (`sinceMount: 13.999999999999545`, a
  //     dialog-relative 14), and the press was therefore refused
  //     while `released=true repeat=false contains=true
  //     active=delete-confirm.confirm` and the ring sat on the confirm button.
  //     The SAME press 8 s later measured `sinceMount: 8137`, armed, and
  //     confirmed. That is the whole of the report: a first press refused on a
  //     dialog that looked ready, and a retry that "cures" it. `nc7` was 5 of 6
  //     red under load and 0 of 4 red on an idle container, and the report's
  //     "50 seconds or more" is the same window with the app running further
  //     behind the driver, which is to say with the mount later relative to the
  //     press that was already on its way.
  //     It is NOT a remount and NOT a stopped clock, and both were measured
  //     rather than reasoned away: a page-seat `MutationObserver` counted one
  //     added node per dialog and one removed node per dismissal, and the
  //     component's own mount counter read 2 across the two dialogs the scenario
  //     opens, so the two effect setups were one per mount, not one mount
  //     running twice. `performance.now()` advanced through 4000 samples at 1 to
  //     3 ms granularity, and the press's own `timeStamp` tracked it to the
  //     millisecond.
  //     The `requestAnimationFrame` half of the old disjunction is gone with it.
  //     It was the better signal in principle, but under a busy WebKitGTK it
  //     measurably does not arrive: `rafs` was still 0 when the press landed, and
  //     a frame took 36 ms to 222 ms, so it armed nothing it was asked to arm.
  //     A gate that can stay shut is not a gate, which the earlier revision of
  //     this comment had already learned; a gate that opens at an arbitrary
  //     instant is the same defect wearing the opposite mask.
  //     **Armed once per mount, which is why the callbacks come through a ref.**
  //     The obvious spelling, `[onCancel, onConfirm]` as the effect's deps,
  //     re-runs the whole effect whenever the PARENT hands down a new callback
  //     identity, and both of this modal's `NoteList` call sites do: the
  //     keyboard soft-trash's `onConfirm` closes over the very state that opened
  //     the dialog, so it is a new function on every render of a component whose
  //     sidebar re-renders on save settles, sync ticks and a relative-time
  //     ticker. Each of those re-runs would reset the mount instant, so the guard
  //     would stop meaning "since the dialog appeared" and start meaning "since
  //     the list last re-rendered", which is a gate that can be shut when the
  //     user presses Enter.
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
  // The listener below is a LAYOUT effect, which is the second half of
  // myne-md/myne#683 and the reason this dialog can afford to drop the retry the
  // E2E helper used to carry. A passive effect is free to run arbitrarily long
  // after the commit that put the dialog on screen, so both of the things it
  // supplies would be late: the mount instant guard 2 compares against, and the
  // keyup listener guard 4 depends on. A key opener's keyup can then be
  // dispatched before either exists, and guard 4 reads the opener's own release
  // as "still held" and eats the user's first press. In a layout effect both are
  // in place in the same synchronous commit that made the dialog visible, which
  // is the only instant that can be compared against a key.
  //
  // Containment is also what makes the confirm-on-unreadable fallback safe:
  // "unreadable" now means unreadable inside THIS dialog, where the trap has
  // already placed focus on the confirm button unless a caller asked otherwise.
  //
  // `design-notes/ui/0564` records the reversal, including what it costs on
  // the cryptographic-erase paths. `design-notes/ui/0685` records guard 2's
  // replacement and what the E2E container measured about it.
  const answerRef = useRef({ onCancel, onConfirm });
  useEffect(() => {
    answerRef.current = { onCancel, onConfirm };
  });
  useLayoutEffect(() => {
    // The instant this dialog became part of the document, taken on the SAME clock the
    // key carries. Guard 2 compares it against `e.timeStamp`, and two properties put both
    // readings on one clock rather than assuming they agree: an event's `timeStamp` is
    // initialized to the current high-resolution time when the event is CREATED, so this
    // reading IS an event stamp and not a wall clock, and the High Resolution Time spec
    // measures that against the document's time origin on every engine this ships to.
    // Measured in the E2E container on WebKitGTK: this reading, `performance.now()` and a
    // real driven keydown's own stamp all read 1316 in the same millisecond.
    //
    // An earlier version of this guard compared against `performance.now()`, which leans
    // on those two clocks agreeing. Where they do not (jsdom, the pinned test
    // environment, where an event stamp is epoch-based while `performance.now()` is
    // origin-relative) that comparison is unconditionally false and the guard a silent
    // no-op, which no test in that environment can see. The engines the container cannot
    // reach (macOS, Windows, iOS, Android) are the manual-test roster's record, not an
    // assumption made here.
    const mountedAt = new Event("myne:delete-confirm-mount").timeStamp;
    // Guard 4 starts shut only when the caller says the dialog was opened by a
    // key, and the first Enter keyup opens it. A key that is being HELD emits
    // repeats and no keyup, so this cannot be satisfied by continuing to hold.
    let released = openedByKey !== true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (dialogRef.current?.contains(document.activeElement) !== true) return;
      // Swallowed even when it is not an answer: the point is that Enter does
      // nothing here, not that it falls through to whatever is behind the dialog.
      e.preventDefault();
      if (e.repeat || !released) return;
      // Guard 2: the key must be newer than the dialog.
      if (e.timeStamp < mountedAt) return;
      if (document.activeElement === cancelRef.current) answerRef.current.onCancel();
      else answerRef.current.onConfirm();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Enter") released = true;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    return () => {
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
      ? t("common.untitled")
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
