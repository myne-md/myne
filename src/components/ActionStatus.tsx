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
import type { Feedback } from "../lib/clipboard";

/**
 * How long the momentary half lasts: the button's own label swap.
 *
 * Deliberately SHORT, and deliberately not the lifetime of the message. It is
 * the "your press registered" flicker, not the confirmation.
 */
export const ACTION_LABEL_FLASH_MS = 1600;

/**
 * The two affordances a shown-once secret screen offers over the same value.
 *
 * Named here rather than spelled inline at each screen because both screens
 * carry exactly this pair and both feed it to `useActionStatus`, so the union is
 * the thing they have to agree on. A screen with a different set pins its own;
 * this component enumerates nothing on its own account.
 */
export type SecretAction = "copy" | "save";

/**
 * What the last action on a surface did, and WHICH action it was.
 *
 * The action half is not decoration (myne-md/myne#522). These screens carry two
 * affordances over the same secret, Copy and Save as file, and a bare
 * succeeded/failed cannot say which one produced the outcome. Sharing one
 * unlabelled outcome between them renders the failed-COPY sentence after a
 * failed save, which on the account screen reads `Couldn't copy. Use "Save as
 * file" instead.` and sends the user back to the thing that just failed.
 */
export type ActionOutcome<A extends string = string> =
  | { action: A; ok: boolean }
  | null;

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
export function useActionStatus<A extends string = string>(
  flashMs: number = ACTION_LABEL_FLASH_MS,
) {
  const [state, setState] = useState<{ outcome: ActionOutcome<A>; seq: number }>({
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

  const mark = (action: A, ok: boolean): void =>
    setState((s) => ({ outcome: { action, ok }, seq: s.seq + 1 }));

  return {
    /** Persistent: which action last ran here, and how it went. */
    outcome: state.outcome,
    /** Momentary: whether that outcome was JUST now. */
    flashing,
    /**
     * For a feedback pair's arms. `action` names the affordance, read back when
     * picking the message, so two affordances can share one live region without
     * borrowing each other's sentences.
     *
     * The surface pins `A` to its own union (`useActionStatus<"copy" | "save">`)
     * rather than the component enumerating every screen's affordances. That is
     * what makes `mark("Copy", …)` a compile error instead of a silent route
     * into the save sentence, which is myne-md/myne#522's own failure with the
     * affordances swapped.
     */
    mark,
    /**
     * The feedback pair for one affordance, both arms inline.
     *
     * A factory rather than the literal at each call site, because the literal
     * is the same six lines four times over and its one variable part is a
     * boolean that reads identically whichever arm it is in: an onSuccess arm
     * calling `mark(action, false)` type-checks and inverts the report.
     *
     * `inline` for both arms is the surface class this hook exists for: a
     * secret shown once gets a persistent line next to the control, not a toast
     * that can be missed. A caller wanting anything else builds its own pair and
     * says why, which is what `FailClosedError` does for its silent failure.
     */
    feedbackFor: (action: A): Feedback => ({
      onSuccess: { kind: "inline", run: () => mark(action, true) },
      onFailure: { kind: "inline", run: () => mark(action, false) },
    }),
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
export function ActionStatus({
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
