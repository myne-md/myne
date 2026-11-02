// The desktop's `<EmptyState>`: a thin wrapper over the shared component
// (myne-md/myne#867).
//
// **The component moved to `@myne/client-core`; this file is what keeps its
// callers unchanged.** Eighteen call sites import `{ EmptyState }` from this
// path, and the phone had no zero state at all while the stylesheet behind this
// one (`myne-empty`, in `client-core/src/components.css`) was already shared by
// every client. So the component joined its stylesheet and this file stayed
// behind as the desktop's own spelling of it.
//
// The one thing it adds back is the desktop's `icon` API. The shared component
// takes a glyph NODE rather than a name, because each client owns its own icon
// registry and importing either one would drag that client's whole icon surface
// into the other. The desktop's `Icon` and its `IconName` live here, so the
// name-to-node translation is the half that belongs on this side, and no call
// site had to learn about it.

import type { ReactNode } from "react";

import { Icon } from "./Icon";
import type { IconName } from "../../lib/icons";
import {
  EmptyState as SharedEmptyState,
  type EmptyStateVariant,
} from "@myne/client-core/emptyState";

export type { EmptyStateVariant };

/** The glyph's size per state size, kept here rather than in the shared
 *  component: it is a desktop-visual decision made about the desktop's icons. */
const GLYPH_SIZE = { sm: 16, lg: 26, md: 20 } as const;

interface EmptyStateProps {
  variant: EmptyStateVariant;
  /** The glyph in the tile. Pick one that names the ABSENT thing, not a mood. */
  icon: IconName;
  title: string;
  body?: ReactNode;
  query?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  size?: "sm" | "md" | "lg";
  field?: boolean;
  fill?: boolean;
  /** Draw the card's border/radius/fill. Off inside a surface that already has
   *  its own (the sidebar's first-run state, issue #970). */
  frame?: boolean;
  testId?: string;
  rest?: React.HTMLAttributes<HTMLDivElement>;
}

export function EmptyState({ icon, size = "md", ...rest }: EmptyStateProps) {
  return (
    <SharedEmptyState
      {...rest}
      size={size}
      glyph={<Icon name={icon} size={GLYPH_SIZE[size]} />}
    />
  );
}
