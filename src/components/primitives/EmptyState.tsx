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
// ── The wash ───────────────────────────────────────────────────────────────
// A soft, blurred accent gradient behind the content, drawn in CSS
// (`.myne-empty__wash`). Static: no animation, no canvas, no loop, so it needs
// no motion-canon exemption and costs nothing while it sits on screen.
//
// It replaced the `01` binary field (`docs/decisions/ui/0643`). The field read
// as developer and privacy iconography — "encryption as theme", arriving as
// texture — on surfaces a general user meets every day, which is exactly the
// look `PRODUCT.md`'s anti-references refuse. The wash takes its colour from
// `--accent`, so every palette, custom themes included, gets its own.
//
// ON by default for every variant and size; a caller that sits on a surface
// already carrying colour passes `field={false}`.

import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";
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
   * Draw the accent wash behind the content. On by default; pass `false` where
   * the surface behind the state already carries colour of its own, or where a
   * second wash beside another one would compete (the agent tab's rail).
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
        // Decoration only: every word the user needs is in the body below.
        <span className="myne-empty__wash" aria-hidden="true" />
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
