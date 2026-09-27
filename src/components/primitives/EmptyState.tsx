// `<EmptyState>` — the app's one zero state (myne-md/myne#776, epic #772).
//
// ── The failure it closes ──────────────────────────────────────────────────
// Three different situations rendered identically: a first-run empty vault, a
// panel filtered to nothing, and a load error. The middle one is the reason
// this exists. A user who had narrowed a list to zero results saw exactly what
// a user with no notes at all saw — a bare sentence, no echo of what they had
// searched for, and nothing to press. That is a dead end produced by treating
// "there is nothing" and "you have hidden everything" as the same fact.
//
// So the variant is not styling. `firstRun` offers the action that creates the
// first thing; `filtered` echoes the query back and offers a way OUT of the
// filter; `error` says why and offers a retry; `loading` defers to the
// skeleton/progress convention rather than flashing a spinner.
//
// ── Size ───────────────────────────────────────────────────────────────────
// One component at three sizes, not three components. A sidebar section, a
// right-rail tab and a full centre pane want the same words with different
// amounts of room, and three components is three places for the words to drift.
//
// ── The `01` field ─────────────────────────────────────────────────────────
// ON for every variant, and a continuous animation — which the canon forbids
// except by name (`docs/decisions/ui/0618`). It is `aria-hidden` and carries no
// meaning: everything the user needs is in the text above it. `mountBinaryField`
// owns the pause conditions that make the exemption hold.
//
// It used to be opt-in, on the argument that only a first-run destination had
// earned it. That drew the wrong line: a filtered list and a load error are
// just as much "this surface, with nothing in it", and giving one of the four
// variants the brand texture made the other three look like a different
// product. The variants already differ in the two ways that matter — the words
// and the action — so differing in the backdrop as well was decoration doing a
// job the copy was already doing.
//
// `sm` used to suppress it, on the argument that a 248px sidebar box turns the
// 15px grid into a texture fighting the copy. It does not: the cell is a fixed
// size, so a narrower box holds FEWER digits, not denser ones, and the radial
// scrim behind the words scales with the content column. What the suppression
// actually produced was the one surface a new user sees first — an empty
// sidebar — being the one surface without the brand on it.

import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";
import { mountBinaryField } from "@myne/client-core/binaryField";
import type { IconName } from "../../lib/icons";

export type EmptyStateVariant = "firstRun" | "filtered" | "error" | "loading";

interface EmptyStateProps {
  variant: EmptyStateVariant;
  /** The glyph in the tile. Pick one that names the ABSENT thing, not a mood. */
  icon: IconName;
  /** One line. Sentence case, no trailing period on a fragment. */
  title: string;
  /**
   * Two to four lines explaining what this surface is for and how to leave the
   * state. This is where the filtered variant earns its keep — "no results"
   * alone is the dead end.
   */
  body?: ReactNode;
  /**
   * The query echoed back, for `filtered`. Rendered monospace and bidi-isolated
   * because it is user text quoted into a sentence.
   */
  query?: string;
  /** The primary action. A `filtered` state's should CLEAR the filter. */
  action?: ReactNode;
  /** A secondary action beside it (a shortcut hint, a docs link). */
  secondaryAction?: ReactNode;
  size?: "sm" | "md" | "lg";
  /**
   * Draw the brand `01` field behind the content. On by default; pass `false`
   * only where the surface behind the state is already carrying texture of its
   * own and the two would fight.
   */
  field?: boolean;
  /**
   * Become the surface instead of sitting on it — no border, no fill, and grow
   * to the height the parent offers. For a state that owns the whole of a modal
   * body or a pane, where a card with empty space under it reads as a layout
   * bug rather than as a card.
   */
  fill?: boolean;
  testId?: string;
  /**
   * Passed through to the root. For the `data-*` a caller needs ON the element
   * its own tests reach for — the AI panel's degraded state carries
   * `data-ai-cause` beside its testid, and an E2E that reads both from one
   * element cannot be given two.
   */
  rest?: HTMLAttributes<HTMLDivElement>;
}

export function EmptyState({
  variant,
  icon,
  title,
  body,
  query,
  action,
  secondaryAction,
  size = "md",
  field = true,
  fill = false,
  testId,
  rest,
}: EmptyStateProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!field) return;
    const el = canvasRef.current;
    if (el === null) return;
    const handle = mountBinaryField(el);
    // The teardown is not optional: the handle owns a rAF loop, an
    // IntersectionObserver, a visibilitychange listener and two canvas
    // listeners, plus a slot in the process-wide animation budget. Leaking one
    // leaks all of them, and the budget would starve every later field.
    return () => handle.destroy();
  }, [field]);

  return (
    <div
      {...rest}
      className="myne-empty"
      data-variant={variant}
      data-size={size}
      data-fill={fill ? "true" : undefined}
      data-testid={testId}
    >
      {field && (
        <canvas
          ref={canvasRef}
          className="myne-empty__field"
          // Decoration. Every word the user needs is in the body below, which
          // is also what keeps this readable under `forced-colors`, where a
          // canvas paints nothing.
          aria-hidden="true"
        />
      )}
      <div className="myne-empty__body">
        <span className="myne-empty__glyph" aria-hidden="true">
          <Icon name={icon} size={size === "sm" ? 16 : size === "lg" ? 26 : 20} />
        </span>
        <p className="myne-empty__title">{title}</p>
        {body !== undefined && (
          <p className="myne-empty__body-text">
            {body}
            {query !== undefined && query !== "" && (
              <>
                {" "}
                <span className="myne-empty__query">{query}</span>
              </>
            )}
          </p>
        )}
        {(action !== undefined || secondaryAction !== undefined) && (
          <div className="myne-empty__actions">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}
