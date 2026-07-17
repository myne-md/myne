// Shared presentational chrome for the mobile saved-view renderers (cards /
// table / list) — the empty state and the group-section heading, which were
// byte-identical (empty) / near-identical (heading) across the three. One home
// for the shared `view.empty` / `view.group-heading` E2E-pinned markup.

import type { CSSProperties, ReactNode } from "react";
import { VIEW_TESTID } from "@myne/editor/host/notes/viewLayout";

const EMPTY_STYLE: CSSProperties = {
  padding: "18vh 40px 0",
  textAlign: "center",
  fontSize: 15,
  lineHeight: 1.55,
  color: "var(--fg-3)",
};

/** The calm centered empty state (a view whose filter matches nothing). */
export function MobileViewEmpty({ message }: { message: string }): ReactNode {
  return (
    <div data-testid={VIEW_TESTID.empty} style={EMPTY_STYLE}>
      {message}
    </div>
  );
}

/** A group-section heading ("<value> · <count>"). `style` lets each renderer
 *  align the heading's horizontal padding with its own container. */
export function MobileGroupHeading({
  label,
  count,
  style,
}: {
  label: string;
  count: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div data-testid={VIEW_TESTID.groupHeading} style={style}>
      {label} · {count}
    </div>
  );
}
