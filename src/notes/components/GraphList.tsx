// The graph as a list (myne-md/myne#727).
//
// A canvas has no keyboard path and no representation a screen reader can read,
// and no amount of ARIA on the element changes that: there is nothing in it to
// describe. So the accessible surface is a SECOND rendering of the same model,
// in text. It is generated from `model` rather than from a second query, so it
// always describes the view that is actually on screen, filter included, and it
// cannot drift from what the canvas draws.
//
// Rows are real buttons, so Tab reaches them and Enter activates them with no
// script, and the arrow keys move focus between them as a convenience on top of
// that. Selecting a row calls the same navigation the canvas does.

import { useMemo } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { tagKeyFromNodeId, type GraphModel } from "../graphModel";

/** Byte-order compare, so the list is stable across locales and renders. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ListRow {
  id: string;
  title: string;
  /** A tag node is not a note (myne-md/myne#727): it has no body to open, and
   *  its own row shape below reflects that. */
  kind: "note" | "tag";
  /** The folded tag key, on a tag row only. */
  tagKey: string | null;
  /** Total resolved links, in both directions. */
  degree: number;
  /** Titles this note links to, sorted. */
  to: string[];
  /** Titles that link to this note, sorted. */
  from: string[];
}

export function GraphList({
  model,
  onOpen,
  onOpenTag,
}: {
  model: GraphModel;
  onOpen: (id: string) => void;
  /** Selecting a tag row filters the graph to that tag, the same thing a
   *  click on the tag node in the picture does. It is NOT `onOpen`: a tag has
   *  no note behind it, and asking the workspace for one would fail. */
  onOpenTag: (key: string) => void;
}) {
  const { t } = useTranslation();

  const rows = useMemo<ListRow[]>(() => {
    const title = (id: string): string => {
      const node = model.nodes.find((n) => n.id === id);
      return node?.title ?? t("common.untitlednote");
    };
    const known = new Set(model.nodes.map((n) => n.id));
    const links = new Map<string, { to: string[]; from: string[] }>();
    for (const n of model.nodes) links.set(n.id, { to: [], from: [] });
    for (const e of model.edges) {
      // An edge to a node outside this view cannot be followed from here, so it
      // contributes no connection line. It still would not be drawn by the
      // canvas either, which is the point of generating both from one model.
      if (!known.has(e.source) || !known.has(e.target)) continue;
      links.get(e.source)?.to.push(title(e.target));
      links.get(e.target)?.from.push(title(e.source));
    }
    return model.nodes
      .map((n) => {
        const l = links.get(n.id) ?? { to: [], from: [] };
        return {
          id: n.id,
          title: n.title ?? t("common.untitlednote"),
          kind: n.kind === "tag" ? ("tag" as const) : ("note" as const),
          tagKey: tagKeyFromNodeId(n.id),
          degree: l.to.length + l.from.length,
          to: [...l.to].sort(compare),
          from: [...l.from].sort(compare),
        };
      })
      .sort((a, b) => b.degree - a.degree || compare(a.title, b.title));
  }, [model, t]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[data-testid="editor.graph-list-row"], [data-testid="editor.graph-list-tag"]',
      ),
    );
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    // Focus is somewhere else entirely (the toggle, a chip): let the arrow key
    // do whatever it does there rather than stealing it.
    if (current < 0) return;
    e.preventDefault();
    const next =
      e.key === "ArrowDown"
        ? Math.min(current + 1, buttons.length - 1)
        : e.key === "ArrowUp"
          ? Math.max(current - 1, 0)
          : e.key === "Home"
            ? 0
            : buttons.length - 1;
    buttons[next]?.focus();
  };

  return (
    <div
      data-testid="editor.graph-list"
      style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--space-3)" }}
    >
      <ul
        role="list"
        onKeyDown={onKeyDown}
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {rows.map((r, index) => (
          <li key={r.id}>
            <button
              type="button"
              // A tag row carries its OWN testid, so a scenario that counts
              // note rows keeps meaning "note rows" rather than silently
              // counting hubs too (myne-md/myne#727).
              data-testid={
                r.kind === "tag" ? "editor.graph-list-tag" : "editor.graph-list-row"
              }
              data-note-id={r.kind === "tag" ? undefined : r.id}
              data-tag-key={r.tagKey ?? undefined}
              data-index={String(index)}
              data-degree={String(r.degree)}
              onClick={() =>
                r.kind === "tag" && r.tagKey !== null
                  ? onOpenTag(r.tagKey)
                  : onOpen(r.id)
              }
              style={{
                width: "100%",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                padding: "var(--space-2) var(--space-3)",
                background: "var(--bg-1)",
                color: "var(--fg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-2)",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                {r.title}
              </span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                {t("notes.graph.listLinkCount", { count: r.degree })}
              </span>
              {/* A tag row stops here. Its "links to" list is every note
                  carrying the tag, which for the tags worth grouping by is a
                  wall of titles that buries the rows below it; the count above
                  is the whole of what the row has to say. A NOTE row keeps both
                  directions, because there the titles are the point. */}
              {r.kind === "note" && r.to.length > 0 && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                  {t("notes.graph.listLinksTo", { titles: r.to.join(", ") })}
                </span>
              )}
              {r.kind === "note" && r.from.length > 0 && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                  {t("notes.graph.listLinksFrom", { titles: r.from.join(", ") })}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
