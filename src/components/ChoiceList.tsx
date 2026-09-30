// A card of choices, each a row saying what it is and what it does, with the
// button that does it on the right (the Obsidian vault-picker shape).
//
// Used where the first run asks a person to pick a path: the Welcome screen's
// four doors and the sync-server step's two. The description is the point: a
// first-run user cannot tell "an identity" from "a vault", or "Myne Sync" from
// "my own server", by a verb alone, so every door says where it leads before
// it is opened.

import type { ReactNode } from "react";

export function ChoiceCard({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        padding: "var(--space-1) var(--space-5)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-3)",
      }}
    >
      {children}
    </div>
  );
}

/** The width every row's action column takes, so the buttons line up. */
const ACTION_WIDTH = 112;

/** Style for the button a row carries: fills the action column, centred. */
export const CHOICE_ACTION_STYLE = { width: "100%", justifyContent: "center" } as const;

export function ChoiceRow({
  title,
  body,
  action,
  last = false,
}: {
  title: string;
  body: ReactNode;
  action: ReactNode;
  /** The last row draws no divider under itself. */
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-5)",
        padding: "var(--space-4) 0",
        borderBottom: last ? undefined : "1px solid var(--line-1)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-base)",
            fontWeight: "var(--weight-medium)",
            color: "var(--fg-1)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: "var(--space-1)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.45,
            color: "var(--fg-2)",
          }}
        >
          {body}
        </div>
      </div>
      <div style={{ flexShrink: 0, display: "flex", width: ACTION_WIDTH }}>{action}</div>
    </div>
  );
}
