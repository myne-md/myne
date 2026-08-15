// Form-C embed layout segments (myne-md/myne#409).
//
// Form C is the Myne-native embed for an encrypted attachment
// (`spec/wikilink.md` §2 form 12):
//
//     ![[att:<attachment-id-hex>|<alias>]]
//
// Everything after the FIRST `|` is the alias, which the lezer grammar already
// hands over whole as a single `WikilinkAlias` node. This module is the one
// place that splits that alias into a filename plus the author's layout
// choices, and the one place that writes it back.
//
//     ![[att:<id>|photo.png|w=300|align=center|alt=A sunset | 2026]]
//
//     w     = <1..8192> | <1..100>%
//     h     = <1..8192>
//     align = left | center | right
//     alt   = terminal, swallows the rest
//
// It is PURE (no DOM, no IPC, no host) and lives in `@myne/dialect` so the
// desktop, web and mobile clients all consume the same implementation from
// source. There is deliberately no Rust twin: the export path
// (`desktop_commands.rs`) learns one narrow `w=<n>` translation rather than a
// second parser, and the two are kept honest by a golden vector rather than by
// two parallel grammars.
//
// The lezer grammar is NOT the place to split these. `WikilinkAlias` is read by
// `parseWikilinkParts`, which serves EVERY wikilink, so splitting the node
// there would change an ordinary note wikilink `[[Note|A|B]]` from a chip
// labelled `A|B` to one labelled `A`. A form-C embed is also strictly atomic
// with no source-lift, so there is no raw source to syntax-highlight and the
// split buys nothing. Split here, in the consumer.

/** Horizontal placement of an embed within the editor's content column. */
export type EmbedAlign = "left" | "center" | "right";

/**
 * Upper bound on an explicit pixel dimension. It exists only to close the
 * grammar and keep an absurd value off disk, NOT to bound the rendered size:
 * render pairs an explicit width with `max-width: 100%`, so the editor's
 * content column is the real limit. The bound is generous because a 5K display
 * in the `full` content-width preset can carry a column near 4800px, and the
 * right way to say "as wide as possible" is `w=100%`, not a pixel count.
 */
export const MAX_EMBED_DIMENSION_PX = 8192;

/** The author's layout choices for one embed. Every field null = no choices. */
export interface EmbedLayout {
  /** Explicit width in CSS px. Mutually exclusive with `widthPercent`. */
  widthPx: number | null;
  /** Explicit width as a percentage of the content column, 1..100. */
  widthPercent: number | null;
  /** Explicit height in CSS px. */
  heightPx: number | null;
  align: EmbedAlign | null;
  /**
   * Author-supplied alt text. `null` means the author wrote none, so the
   * filename remains the accessible name. `""` means the author deliberately
   * wrote an empty one, which is the correct signal for a decorative image and
   * is NOT the same thing.
   */
  alt: string | null;
}

/** A segment that was dropped and is worth telling the author about. */
export interface DroppedEmbedSegment {
  /** The segment's source text, verbatim, per `markdown-dialect.md` §3.9.3. */
  source: string;
}

export interface ParsedEmbedAlias {
  /** The display filename. Never null; may be empty for a malformed embed. */
  filename: string;
  layout: EmbedLayout;
  /**
   * Keyed segments this version does not understand, verbatim and in order.
   *
   * They are RETAINED rather than discarded because the emitter rebuilds the
   * alias from this struct, so anything absent here is destroyed the next time
   * the author touches the embed. Two different things land in this list and
   * they are indistinguishable by shape, which is exactly why neither may be
   * dropped: a segment a NEWER client wrote (`future=x`), and a fragment of a
   * filename that happens to contain both a pipe and an equals sign
   * (`re|port=v2.png`). Guessing between them would corrupt one of the two;
   * carrying both through byte-for-byte corrupts neither.
   */
  unknown: readonly string[];
  /**
   * Segments dropped that the author can act on: a KNOWN key carrying an
   * invalid value. An UNRECOGNISED key is dropped silently and never lands
   * here. That split is the whole point rather than a detail: three clients
   * ship on independent versions against one synced vault, so a key an older
   * client does not know is routine, the note is right and the client is old,
   * and there is nothing the reader could do about it. Reporting it would put
   * a warning on every image a newer client styled.
   */
  dropped: DroppedEmbedSegment[];
}

/** A layout carrying no choices at all. */
export function emptyEmbedLayout(): EmbedLayout {
  return { widthPx: null, widthPercent: null, heightPx: null, align: null, alt: null };
}

/** The closed key vocabulary. A key outside this set is version skew. */
const KNOWN_KEYS = new Set(["w", "h", "align"]);

/** Canonical positive integer: no leading zero, so parse/emit round-trips. */
const INT_RE = /^[1-9]\d*$/;
const PERCENT_RE = /^([1-9]\d*)%$/;
/** `key=value`, where the key is a plain identifier. Anything else is filename. */
const KEYED_RE = /^([A-Za-z][A-Za-z0-9_-]*)=([\s\S]*)$/;

const ALT_PREFIX = "alt=";

function parsePixels(raw: string): number | null {
  if (!INT_RE.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_EMBED_DIMENSION_PX ? n : null;
}

/**
 * Split a form-C alias into its filename and the author's layout choices.
 *
 * Total by construction: it never throws and never reports "no layout" for an
 * input it could partly read. An unreadable segment is dropped, its bytes are
 * left untouched in the note, and only the author-fixable kind is reported.
 */
export function parseEmbedAlias(alias: string): ParsedEmbedAlias {
  const layout = emptyEmbedLayout();
  const dropped: DroppedEmbedSegment[] = [];
  const unknown: string[] = [];

  const parts = alias.split("|");
  // Segment 1 is ALWAYS the filename, positionally. That is what lets a
  // filename legitimately contain `=` (`w=300.png`) without being mistaken for
  // a key.
  const nameParts: string[] = [parts[0] ?? ""];

  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];

    // `alt=` is terminal: it swallows this segment's value and every remaining
    // segment, pipes included. Alt text is free prose, and the importer carries
    // markdown-image alt text (`![A sunset | 2026](photo.png)`) straight into
    // it, so a forbidden character here would mean mutating user content on
    // import.
    if (segment.startsWith(ALT_PREFIX)) {
      layout.alt = [segment.slice(ALT_PREFIX.length), ...parts.slice(i + 1)].join("|");
      break;
    }

    const keyed = KEYED_RE.exec(segment);
    if (keyed === null) {
      // No key shape: this belongs to the filename. `![[att:<id>|re|port.png]]`
      // is already on disk today, because nothing rejects a pipe in an
      // attachment filename and a pipe is legal on macOS and Linux.
      nameParts.push(segment);
      continue;
    }

    const [, key, value] = keyed;
    if (!KNOWN_KEYS.has(key)) {
      // Version skew, or a filename fragment. Silent (nothing the reader can
      // act on) but RETAINED, so the emitter cannot delete it.
      unknown.push(segment);
      continue;
    }

    // A known key written twice is hand-authored (the emitter never produces
    // one), so the first wins and the repeat is reported like any other
    // unreadable segment.
    const alreadySet =
      (key === "w" && (layout.widthPx !== null || layout.widthPercent !== null)) ||
      (key === "h" && layout.heightPx !== null) ||
      (key === "align" && layout.align !== null);
    if (alreadySet) {
      dropped.push({ source: segment });
      continue;
    }

    if (key === "w") {
      const pct = PERCENT_RE.exec(value);
      if (pct !== null) {
        const n = Number(pct[1]);
        if (n <= 100) layout.widthPercent = n;
        else dropped.push({ source: segment });
        continue;
      }
      const px = parsePixels(value);
      if (px !== null) layout.widthPx = px;
      else dropped.push({ source: segment });
      continue;
    }

    if (key === "h") {
      // Percent is width-only: a percentage height would resolve against a
      // container the editor does not give these widgets a fixed height for.
      const px = parsePixels(value);
      if (px !== null) layout.heightPx = px;
      else dropped.push({ source: segment });
      continue;
    }

    // align, the last known key.
    if (value === "left" || value === "center" || value === "right") layout.align = value;
    else dropped.push({ source: segment });
  }

  return { filename: nameParts.join("|"), layout, dropped, unknown };
}

/**
 * Write a filename plus layout back into a form-C alias. The single emitter, so
 * every authoring path produces the same bytes.
 *
 * `alt=` always goes last, which is what keeps its terminal rule invisible to
 * anyone using the app: the only way to violate the ordering is to hand-edit
 * the `.md` outside Myne, and then the later key lands in the alt text where it
 * is visible rather than silently lost.
 */
export function emitEmbedAlias(
  filename: string,
  layout: EmbedLayout,
  unknown: readonly string[] = [],
): string {
  const out = [filename];
  if (layout.widthPx !== null) out.push(`w=${layout.widthPx}`);
  else if (layout.widthPercent !== null) out.push(`w=${layout.widthPercent}%`);
  if (layout.heightPx !== null) out.push(`h=${layout.heightPx}`);
  if (layout.align !== null) out.push(`align=${layout.align}`);
  // Before `alt=`, which is terminal and would swallow them.
  for (const segment of unknown) out.push(segment);
  if (layout.alt !== null) out.push(`${ALT_PREFIX}${layout.alt}`);
  return out.join("|");
}

/**
 * Field-by-field equality. CM6 widgets are rebuilt on every relevant document
 * change and kept only when `eq()` says the new one matches the old, so a
 * widget that keys `eq()` on identity would never re-render after a layout
 * edit, and one that ignores the layout entirely would never re-render at all.
 */
export function sameEmbedLayout(a: EmbedLayout, b: EmbedLayout): boolean {
  return (
    a.widthPx === b.widthPx &&
    a.widthPercent === b.widthPercent &&
    a.heightPx === b.heightPx &&
    a.align === b.align &&
    a.alt === b.alt
  );
}

/** True iff the layout carries no author choice at all. */
export function isEmptyEmbedLayout(layout: EmbedLayout): boolean {
  return (
    layout.widthPx === null &&
    layout.widthPercent === null &&
    layout.heightPx === null &&
    layout.align === null &&
    layout.alt === null
  );
}
