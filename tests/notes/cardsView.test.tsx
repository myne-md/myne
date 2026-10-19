// @vitest-environment jsdom
//
// Unit tests for the cards-gallery renderer (Saved Views #5, MYND-275, task 2).
// Behavior-level: render `CardsView` / `ViewRenderHost` with a fabricated
// `SavedView` + `ViewResult` and assert the card-per-row mapping, group
// headings + counts, the empty state, the viewType dispatch fallback, and the
// read-only guarantee (no contenteditable / input). Pure components — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  buildGalleryStream,
  CardsView,
  CARDS_EMPTY_COPY,
  columnsForWidth,
  dedupeRowsByNote,
  resolveAspectRatio,
  resolveCardWidth,
  resolveCoverAttachmentId,
} from "../../src/notes/views/cardsView";
import { ViewRenderHost } from "../../src/notes/views/viewRenderHost";
import type { SavedView } from "../../src/lib/prefs";
import type {
  StoredProperty,
  ViewResult,
  ViewRow,
} from "../../src/notes/queryEngine";

afterEach(cleanup);

function cardsDef(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Books",
    view_type: "cards",
    filters: { kind: "all" },
    ...over,
  };
}

function row(
  noteId: string,
  title: string | null,
  values: Record<string, StoredProperty | undefined> = {},
): ViewRow {
  return { noteId, title, folder: null, values };
}

describe("CardsView", () => {
  it("renders one card per row with the correct data-note-id", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Alpha"), row("n2", "Beta")],
        },
      ],
    };
    render(<CardsView def={cardsDef()} result={result} />);
    const cards = screen.getAllByTestId("view.card");
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.getAttribute("data-note-id"))).toEqual([
      "n1",
      "n2",
    ]);
    expect(cards[0]!.textContent).toContain("Alpha");
  });

  it("falls back to 'Untitled' for a null title", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", null)] }],
    };
    render(<CardsView def={cardsDef()} result={result} />);
    expect(screen.getByTestId("view.card").textContent).toContain("Untitled");
  });

  it("renders a group heading per group with its row count", () => {
    const result: ViewResult = {
      groups: [
        { key: "Sci-Fi", type: "string", rows: [row("n1", "Dune")] },
        {
          key: "History",
          type: "string",
          rows: [row("n2", "Sapiens"), row("n3", "1776")],
        },
      ],
    };
    render(<CardsView def={cardsDef({ group_by: "genre" })} result={result} />);
    const headings = screen.getAllByTestId("view.group-heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]!.textContent).toContain("Sci-Fi");
    expect(headings[0]!.textContent).toContain("1");
    expect(headings[1]!.textContent).toContain("History");
    expect(headings[1]!.textContent).toContain("2");
  });

  it("shows a calm fallback label for the no-value group", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Untagged")] }],
    };
    render(<CardsView def={cardsDef({ group_by: "genre" })} result={result} />);
    expect(screen.getByTestId("view.group-heading").textContent).toContain(
      "No value",
    );
  });

  it("renders the view's columns as plain text and skips missing values", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [
            row("n1", "Dune", {
              author: { key: "author", type: "string", value: "Herbert" },
              // `year` intentionally absent → skipped.
            }),
          ],
        },
      ],
    };
    render(
      <CardsView
        def={cardsDef({ columns: ["author", "year"] })}
        result={result}
      />,
    );
    const card = screen.getByTestId("view.card");
    expect(card.textContent).toContain("Herbert");
    expect(card.textContent).not.toContain("year");
  });

  it("renders a list property as tag pills (task 6 formatting)", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [
            row("n1", "Dune", {
              tags: {
                key: "tags",
                type: "list",
                elements: [
                  { type: "string", value: "epic" },
                  { type: "string", value: "desert" },
                ],
              },
            }),
          ],
        },
      ],
    };
    render(<CardsView def={cardsDef({ columns: ["tags"] })} result={result} />);
    const card = screen.getByTestId("view.card");
    expect(card.textContent).toContain("epic");
    expect(card.textContent).toContain("desert");
    expect(screen.getByTestId("view.prop-list")).toBeTruthy();
  });

  it("renders the empty state with the exact copy when there are zero rows", () => {
    render(<CardsView def={cardsDef()} result={{ groups: [] }} />);
    const empty = screen.getByTestId("view.empty");
    expect(empty.textContent).toBe(CARDS_EMPTY_COPY);
    expect(screen.queryByTestId("view.card")).toBeNull();
  });

  it("treats groups with no rows as empty (no card, the empty state)", () => {
    const result: ViewResult = {
      groups: [{ key: "Sci-Fi", type: "string", rows: [] }],
    };
    render(<CardsView def={cardsDef()} result={result} />);
    expect(screen.getByTestId("view.empty")).toBeTruthy();
    expect(screen.queryByTestId("view.card")).toBeNull();
  });

  it("renders no contenteditable / input node (read-only projection)", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    const { container } = render(
      <CardsView def={cardsDef()} result={result} />,
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
  });
});

describe("fan-out grouping + within-group dedupe (task 3)", () => {
  it("paints a note's card under EVERY group the engine fanned it into", () => {
    // The engine fans a list-valued groupBy note into multiple groups; the
    // render must show its card in each — never collapse cross-group copies.
    const result: ViewResult = {
      groups: [
        { key: "epic", type: "string", rows: [row("n1", "Dune")] },
        { key: "desert", type: "string", rows: [row("n1", "Dune")] },
      ],
    };
    render(<CardsView def={cardsDef({ group_by: "tags" })} result={result} />);
    const cards = screen.getAllByTestId("view.card");
    expect(cards).toHaveLength(2); // same note, two sections
    expect(cards.every((c) => c.getAttribute("data-note-id") === "n1")).toBe(
      true,
    );
    const headings = screen.getAllByTestId("view.group-heading");
    expect(headings.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("epic"),
        expect.stringContaining("desert"),
      ]),
    );
  });

  it("collapses a duplicate note WITHIN one group to a single card", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "Sci-Fi",
          type: "string",
          rows: [row("n1", "Dune"), row("n1", "Dune"), row("n2", "Hyperion")],
        },
      ],
    };
    render(<CardsView def={cardsDef({ group_by: "genre" })} result={result} />);
    const cards = screen.getAllByTestId("view.card");
    expect(cards.map((c) => c.getAttribute("data-note-id"))).toEqual([
      "n1",
      "n2",
    ]);
    // The heading count matches the deduped cards actually shown.
    expect(screen.getByTestId("view.group-heading").textContent).toContain("2");
  });

  it("dedupeRowsByNote keeps first occurrence, preserves order", () => {
    const deduped = dedupeRowsByNote([
      row("a", "A"),
      row("b", "B"),
      row("a", "A-again"),
      row("c", "C"),
    ]);
    expect(deduped.map((r) => r.noteId)).toEqual(["a", "b", "c"]);
    expect(deduped[0]!.title).toBe("A"); // first occurrence wins
  });
});

describe("cover image via attachment:// + image-less fallback (task 4)", () => {
  const HEX = "a".repeat(64);

  function strProp(key: string, value: string): StoredProperty {
    return { key, type: "string", value };
  }

  it("emits <img src='attachment://<id>'> for a form-C embed image value", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [
            row("n1", "Dune", {
              cover: strProp("cover", `![[att:${HEX}|cover.png]]`),
            }),
          ],
        },
      ],
    };
    render(<CardsView def={cardsDef({ image: "cover" })} result={result} />);
    const img = screen.getByTestId("view.card-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`attachment://${HEX}`);
  });

  it("resolves a bare 64-hex attachment-id image value", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Dune", { cover: strProp("cover", HEX) })],
        },
      ],
    };
    render(<CardsView def={cardsDef({ image: "cover" })} result={result} />);
    expect(
      screen.getByTestId("view.card-image").getAttribute("src"),
    ).toBe(`attachment://${HEX}`);
  });

  it("renders an image-less card (no cover node, no glyph) when image absent", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Dune", {})] }],
    };
    const { container } = render(
      <CardsView def={cardsDef({ image: "cover" })} result={result} />,
    );
    expect(screen.queryByTestId("view.card-image")).toBeNull();
    // No placeholder / broken-image artefact: zero <img> nodes at all.
    expect(container.querySelector("img")).toBeNull();
    // The card still renders (title present).
    expect(screen.getByTestId("view.card").textContent).toContain("Dune");
  });

  it("falls back to image-less for an unparseable image value", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Dune", { cover: strProp("cover", "not-an-att") })],
        },
      ],
    };
    render(<CardsView def={cardsDef({ image: "cover" })} result={result} />);
    expect(screen.queryByTestId("view.card-image")).toBeNull();
  });

  it("does not render the image property as a text column", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [
            row("n1", "Dune", {
              cover: strProp("cover", HEX),
              author: strProp("author", "Herbert"),
            }),
          ],
        },
      ],
    };
    render(
      <CardsView
        def={cardsDef({ image: "cover", columns: ["cover", "author"] })}
        result={result}
      />,
    );
    const card = screen.getByTestId("view.card");
    expect(card.textContent).toContain("Herbert");
    expect(card.textContent).not.toContain(HEX); // the att id never shows as text
  });

  it("resolveCoverAttachmentId: forms + null cases", () => {
    const p = (value: string): StoredProperty => ({
      key: "cover",
      type: "string",
      value,
    });
    expect(resolveCoverAttachmentId(p(`![[att:${HEX}|x.png]]`))).toBe(HEX);
    expect(resolveCoverAttachmentId(p(`[[att:${HEX}]]`))).toBe(HEX);
    expect(resolveCoverAttachmentId(p(`att:${HEX}`))).toBe(HEX);
    expect(resolveCoverAttachmentId(p(HEX))).toBe(HEX);
    expect(resolveCoverAttachmentId(p(""))).toBeNull();
    expect(resolveCoverAttachmentId(p("garbage"))).toBeNull();
    expect(resolveCoverAttachmentId(undefined)).toBeNull();
    expect(
      resolveCoverAttachmentId({
        key: "cover",
        type: "list",
        elements: [{ type: "string", value: HEX }],
      }),
    ).toBeNull(); // a list image property is not a cover
  });
});

describe("cardSize + imageAspectRatio from the schema (task 5)", () => {
  const HEX = "b".repeat(64);

  it("resolveCardWidth: value used, clamped, fallback when missing/invalid", () => {
    expect(resolveCardWidth(260)).toBe(260);
    expect(resolveCardWidth(undefined)).toBe(220); // default
    expect(resolveCardWidth(0)).toBe(220); // non-positive → default
    expect(resolveCardWidth(Number.NaN)).toBe(220);
    expect(resolveCardWidth(50)).toBe(120); // clamped to MIN
    expect(resolveCardWidth(9999)).toBe(600); // clamped to MAX
  });

  it("resolveAspectRatio: finite positive used verbatim, else default", () => {
    expect(resolveAspectRatio("1.65")).toBe("1.65");
    expect(resolveAspectRatio(undefined)).toBe("1.78");
    expect(resolveAspectRatio("0")).toBe("1.78");
    expect(resolveAspectRatio("-2")).toBe("1.78");
    expect(resolveAspectRatio("garbage")).toBe("1.78");
  });

  it("reflects card_size in the grid column width", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Dune")] }],
    };
    render(<CardsView def={cardsDef({ card_size: 300 })} result={result} />);
    const grid = screen.getByTestId("view.card").parentElement!;
    expect(grid.style.gridTemplateColumns).toContain("300px");
  });

  it("reflects image_aspect_ratio in the cover image style", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [
            row("n1", "Dune", {
              cover: { key: "cover", type: "string", value: HEX },
            }),
          ],
        },
      ],
    };
    render(
      <CardsView
        def={cardsDef({ image: "cover", image_aspect_ratio: "1.65" })}
        result={result}
      />,
    );
    const img = screen.getByTestId("view.card-image");
    // jsdom normalizes `aspect-ratio: 1.65` to `1.65 / 1` (semantically equal).
    expect(img.style.aspectRatio).toContain("1.65");
  });

  it("missing sizing fields → sane defaults, no crash", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Dune")] }],
    };
    render(<CardsView def={cardsDef()} result={result} />);
    const grid = screen.getByTestId("view.card").parentElement!;
    expect(grid.style.gridTemplateColumns).toContain("220px");
  });
});

describe("card navigation — click matrix, read-only (task 7)", () => {
  function oneCard() {
    return {
      groups: [
        { key: "", type: "none" as const, rows: [row("n1", "Dune")] },
      ],
    };
  }

  it("single click → open in focused tab (no flags)", () => {
    const onOpenNote = vi.fn();
    render(
      <CardsView def={cardsDef()} result={oneCard()} onOpenNote={onOpenNote} />,
    );
    fireEvent.click(screen.getByTestId("view.card"));
    expect(onOpenNote).toHaveBeenCalledWith("n1", {
      newTab: false,
      toSide: false,
    });
  });

  it("Cmd/Ctrl click → new tab", () => {
    const onOpenNote = vi.fn();
    render(
      <CardsView def={cardsDef()} result={oneCard()} onOpenNote={onOpenNote} />,
    );
    fireEvent.click(screen.getByTestId("view.card"), { metaKey: true });
    expect(onOpenNote).toHaveBeenCalledWith("n1", {
      newTab: true,
      toSide: false,
    });
    fireEvent.click(screen.getByTestId("view.card"), { ctrlKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", {
      newTab: true,
      toSide: false,
    });
  });

  it("Alt click → open to side", () => {
    const onOpenNote = vi.fn();
    render(
      <CardsView def={cardsDef()} result={oneCard()} onOpenNote={onOpenNote} />,
    );
    fireEvent.click(screen.getByTestId("view.card"), { altKey: true });
    expect(onOpenNote).toHaveBeenCalledWith("n1", {
      newTab: false,
      toSide: true,
    });
  });

  it("middle click (aux button 1) → new tab", () => {
    const onOpenNote = vi.fn();
    render(
      <CardsView def={cardsDef()} result={oneCard()} onOpenNote={onOpenNote} />,
    );
    fireEvent(
      screen.getByTestId("view.card"),
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onOpenNote).toHaveBeenCalledWith("n1", {
      newTab: true,
      toSide: false,
    });
  });

  it("right-click → onCardContextMenu with note id + position", () => {
    const onCardContextMenu = vi.fn();
    render(
      <CardsView
        def={cardsDef()}
        result={oneCard()}
        onCardContextMenu={onCardContextMenu}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("view.card"), {
      clientX: 12,
      clientY: 34,
    });
    expect(onCardContextMenu).toHaveBeenCalledWith("n1", { x: 12, y: 34 });
  });

  it("does not open without a handler and renders no drag/edit affordance", () => {
    const { container } = render(
      <CardsView def={cardsDef()} result={oneCard()} />,
    );
    const card = screen.getByTestId("view.card");
    // No handler → not a button, no pointer role.
    expect(card.getAttribute("role")).toBeNull();
    // Read-only: no draggable, no contenteditable, no input anywhere.
    expect(container.querySelector("[draggable='true']")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });
});

describe("ViewRenderHost dispatch", () => {
  it("renders CardsView for a cards view", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    render(<ViewRenderHost def={cardsDef()} result={result} />);
    expect(screen.getByTestId("view.cards")).toBeTruthy();
    expect(screen.queryByTestId("view.unsupported")).toBeNull();
  });

  it("renders TableView for a table view, not CardsView", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    render(
      <ViewRenderHost def={cardsDef({ view_type: "table" })} result={result} />,
    );
    expect(screen.getByTestId("view.table")).toBeTruthy();
    expect(screen.queryByTestId("view.cards")).toBeNull();
    expect(screen.queryByTestId("view.card")).toBeNull();
  });

  it("renders ListView for a list view, not CardsView", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    render(
      <ViewRenderHost def={cardsDef({ view_type: "list" })} result={result} />,
    );
    expect(screen.getByTestId("view.list")).toBeTruthy();
    expect(screen.queryByTestId("view.cards")).toBeNull();
  });
});

describe("VirtualList windowing (task 9)", () => {
  it("columnsForWidth mirrors the auto-fill track count, ≥1, 0-width → 1", () => {
    // floor((width + gap) / (cardWidth + gap)). gap=12, cardWidth=220:
    //   width 0   → 1 (jsdom / pre-layout fallback)
    //   width 220 → floor(232/232) = 1
    //   width 452 → floor(464/232) = 2
    //   width 916 → floor(928/232) = 4
    expect(columnsForWidth(0, 220)).toBe(1);
    expect(columnsForWidth(-50, 220)).toBe(1);
    expect(columnsForWidth(220, 220)).toBe(1);
    expect(columnsForWidth(452, 220)).toBe(2);
    expect(columnsForWidth(916, 220)).toBe(4);
    // A wide card_size yields fewer columns for the same width.
    expect(columnsForWidth(916, 300)).toBe(2);
  });

  it("buildGalleryStream: heading + chunked shelves, one heading per group", () => {
    const stream = buildGalleryStream(
      [
        {
          key: "Sci-Fi",
          label: "Sci-Fi",
          rows: [row("n1", "A"), row("n2", "B"), row("n3", "C")],
        },
        { key: "", label: "No value", rows: [row("n4", "D")] },
      ],
      2, // two cards per shelf
    );
    // Group 1: heading + 2 shelves (3 rows / 2 = [2,1]); Group 2: heading + 1.
    expect(stream.map((i) => i.kind)).toEqual([
      "heading",
      "shelf",
      "shelf",
      "heading",
      "shelf",
    ]);
    const headings = stream.filter((i) => i.kind === "heading");
    expect(headings).toHaveLength(2); // one per group
    const firstShelf = stream[1];
    expect(firstShelf.kind === "shelf" && firstShelf.cards).toHaveLength(2);
    const secondShelf = stream[2];
    expect(secondShelf.kind === "shelf" && secondShelf.cards).toHaveLength(1);
    // Keys are stable + unique across the stream.
    expect(new Set(stream.map((i) => i.key)).size).toBe(stream.length);
  });

  it("windows a large result set — only a small slice of cards mounts", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(`n${i}`, `Note ${i}`),
    );
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows }],
    };
    render(<CardsView def={cardsDef()} result={result} />);
    // In jsdom the container reports 0 height, so VirtualList mounts only its
    // buffer-sized window — far fewer than the 200 input cards.
    const mounted = screen.queryAllByTestId("view.card").length;
    expect(mounted).toBeGreaterThan(0); // the basic contract still renders cards
    expect(mounted).toBeLessThan(50); // windowed, not all 200
    expect(mounted).toBeLessThan(200);
  });

  it("small fixture: cards render, show headings, and open on click", () => {
    const onOpenNote = vi.fn();
    const result: ViewResult = {
      groups: [
        { key: "Sci-Fi", type: "string", rows: [row("n1", "Dune")] },
        { key: "History", type: "string", rows: [row("n2", "Sapiens")] },
      ],
    };
    render(
      <CardsView
        def={cardsDef({ group_by: "genre" })}
        result={result}
        onOpenNote={onOpenNote}
      />,
    );
    // Both group headings present (one per group — windowing didn't drop them
    // for a small fixture that fits the buffer).
    const headings = screen.getAllByTestId("view.group-heading");
    expect(headings.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Sci-Fi"),
        expect.stringContaining("History"),
      ]),
    );
    const cards = screen.getAllByTestId("view.card");
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[0]!);
    expect(onOpenNote).toHaveBeenCalledWith("n1", {
      newTab: false,
      toSide: false,
    });
  });
});
