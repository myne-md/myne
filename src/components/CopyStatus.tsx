// The inline arm of the clipboard feedback pair (myne-md/myne#390).
//
// One component, so two things are wired once instead of at each call site.
//
// # The live region
//
// Every copy confirmation in the tree was a purely visual swap, an icon, a
// label, and none of them sat in a live region, so a screen reader announced
// nothing when a copy landed or failed. The toast host owns one `role="status"`
// for the toast arm; this owns the other one for the inline arm. Putting it here
// rather than at each call site is what makes it structural: a new inline
// confirmation gets it by construction rather than by the author remembering.
//
// # The revert
//
// Two desktop surfaces set a `copied` flag and never cleared it as feedback.
// `AccountStep` reset it only when the step committed, so the label read
// "Copied" for the rest of the step regardless of what the user did next;
// `FailClosedError` never reset it at all. A stale confirmation is worse than
// none, because the user reads it as the result of the tap they just made. The
// correct reference already existed on mobile, a ~1.6 s auto-reset, and this
// is that, shared.
//
// The timer is cleared on unmount, so a component that goes away mid-window
// leaves nothing behind.
//
// # What it does NOT render
//
// The copied value. A confirmation names the OUTCOME, and the copy-policy module
// hands its feedback arms nothing precisely so that this cannot drift.

import { useEffect, useState, type CSSProperties } from "react";

/**
 * How long the momentary half lasts: the button's own label swap.
 *
 * Deliberately SHORT, and deliberately not the lifetime of the message. It is
 * the "your press registered" flicker, not the confirmation.
 */
export const COPY_LABEL_FLASH_MS = 1600;

export type CopyOutcome = "copied" | "failed" | null;

/**
 * Drive an inline copy confirmation.
 *
 * Returns TWO lifetimes, because the surfaces need two and an earlier version of
 * this hook conflated them into one 1.6 s timer:
 *
 * - `outcome` is PERSISTENT. It survives until the next copy or until the
 *   component goes away. The design calls for a persistent inline confirmation
 *   on secret-bearing, shown-once screens precisely because a message the user
 *   can miss is barely better than none, and a 1.6 s message was shorter than
 *   the 2.5 s toast it was chosen over, which made the code argue for one thing
 *   and do another.
 * - `flashing` is MOMENTARY, for a button whose own label swaps to "Copied".
 *   That one should revert, or it becomes the stale label this feature is fixing
 *   on two other surfaces.
 *
 * Both setters bump a nonce, so pressing Copy twice inside the window restarts
 * the flash. Without it React bails out of the identical state update, the
 * effect's deps never change, and the second press produces no observable
 * change at all.
 */
export function useCopyStatus(flashMs: number = COPY_LABEL_FLASH_MS) {
  const [state, setState] = useState<{ outcome: CopyOutcome; seq: number }>({
    outcome: null,
    seq: 0,
  });
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (state.outcome === null) return;
    setFlashing(true);
    const id = window.setTimeout(() => setFlashing(false), flashMs);
    return () => window.clearTimeout(id);
  }, [state.seq, state.outcome, flashMs]);

  return {
    /** Persistent: what the last copy did. */
    outcome: state.outcome,
    /** Momentary: whether that copy was JUST now. */
    flashing,
    /** For a feedback pair's `onSuccess` arm. */
    markCopied: () => setState((s) => ({ outcome: "copied", seq: s.seq + 1 })),
    /** For a feedback pair's `onFailure` arm. */
    markFailed: () => setState((s) => ({ outcome: "failed", seq: s.seq + 1 })),
  };
}

/**
 * The announcement half.
 *
 * Renders `message` visibly when there is one, inside the live region. A caller
 * that wants no visible text (a label swap it renders itself, an icon flip)
 * passes `visuallyHidden` and still gets the announcement, which is the case
 * that used to be silent for screen-reader users on every one of these surfaces.
 */
export function CopyStatus({
  message,
  visuallyHidden = false,
  style,
  testId,
}: {
  message: string | null;
  visuallyHidden?: boolean;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      style={
        visuallyHidden
          ? {
              // Announced, not drawn. Not `display: none` and not
              // `visibility: hidden`: both remove the element from the
              // accessibility tree, which would make the live region announce
              // nothing and turn this into decoration.
              position: "absolute",
              width: 1,
              height: 1,
              overflow: "hidden",
              clipPath: "inset(50%)",
              whiteSpace: "nowrap",
            }
          : {
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
              ...style,
            }
      }
    >
      {message}
    </div>
  );
}
