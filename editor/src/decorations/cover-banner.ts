// The note's cover banner (myne-md/myne#410).
//
// A block widget at document position 0, directly above the frontmatter
// Properties widget, so the stack reads cover → title → properties → body. It
// lives INSIDE the document rather than in the pane chrome, which is what makes
// it scroll away: a permanent band above the scroller would eat vertical space
// in a text editor for the whole life of the note.
//
// Block decorations must be provided from a `StateField`, not a `ViewPlugin`
// (CM6 rejects the latter). `frontmatter.ts` is the working precedent for the
// whole pattern; the one thing this field does that the frontmatter field does
// not is rebuild on a CATALOG change as well as a doc change, because the same
// document renders three different ways depending on whether the attachments
// catalog has loaded and whether it still carries this id.
//
// Three render states, and the middle one is the whole reason to distinguish
// them (`resolveCatalog`):
//
//   loading   → reserve the height, draw no image. Without this the body text
//               sits at the top and then jumps down when the catalog arrives.
//   resolved  → the image.
//   deleted   → render NOTHING AT ALL. Not a tombstone, not a placeholder, not
//               an empty band. This is a deliberate divergence from a form-C
//               embed in the BODY, which does draw a tombstone widget: a
//               broken-image bar across the top of a note is worse than a note
//               that simply has no cover, and the note is still perfectly
//               readable without it.
//
// The field is only ever asked about a value the §3.6.1 grammar already
// accepted (`readCoverFromFmBody`), so an invalid `cover:` never reaches here;
// it stays a visible property row instead (see `frontmatter.ts`).

import {
  type EditorState,
  type Extension,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { readCoverFromFmBody } from "@myne/dialect/surgery";
import i18n from "@myne/editor/i18n";
import { attachmentUrl } from "@myne/editor/host/notes/attachmentRef";
import { writableHost } from "../host";
import { readNoteId } from "../note-identity";
import { cachedLocateFrontmatter } from "../frontmatter-cache";
import {
  catalogChanged,
  catalogField,
  type CatalogState,
  resolveCatalog,
} from "../attachments/catalog";

/** Testids. `<screen>.<element>` per the shared convention. */
export const COVER_BANNER_TESTID = "editor.cover-banner";
export const COVER_CHANGE_TESTID = "editor.cover-change";
export const COVER_REMOVE_TESTID = "editor.cover-remove";

/**
 * One hover control on the banner. A `<button>` rather than a styled div so it
 * is announced as a button, and the hover reveal is opacity in CSS rather than
 * `display: none` so it is not removed from the document.
 *
 * It is NOT reachable by Tab, and saying otherwise would be wrong: these
 * buttons live inside CodeMirror's content, where `Tab` is bound to
 * `editor.indent`. Keyboard access to both actions is the command palette
 * (`note.set-cover`, `note.remove-cover`), which is why those exist.
 */
function makeCoverControl(
  testId: string,
  label: string,
  onActivate: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-cover-banner-control";
  button.textContent = label;
  button.setAttribute("data-testid", testId);
  // `mousedown` + preventDefault, not `click`: the editor takes focus on
  // mousedown, and letting that through moves the cursor into the document
  // before the handler runs.
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onActivate();
  });
  return button;
}

/** What the banner should draw for the current document + catalog. */
type BannerState =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "image"; readonly id: string; readonly filename: string };

/**
 * Is the banner showing (or about to show) this note's cover?
 *
 * This is the ONE predicate the Properties widget's row-skip must agree with,
 * and it is deliberately not "is the value valid". A cover whose attachment has
 * been deleted is perfectly VALID and draws no banner, so skipping the row on
 * validity alone leaves a line that exists in the file and appears nowhere in
 * the interface — exactly the hole the conditional skip was added to close.
 * The honest rule is "hide the row iff something else is showing it".
 */
export function coverIsOnScreen(
  doc: EditorState["doc"],
  catalog: CatalogState,
): boolean {
  const state = coverBannerState(doc, catalog);
  // `loading` counts: the banner is holding the space and the image is coming.
  return state.kind !== "none";
}

/**
 * Resolve the banner state from a document and a catalog. Exported for tests:
 * the three-way outcome is the behaviour worth asserting, and asserting it here
 * as well as through the DOM keeps a failure legible.
 */
export function coverBannerState(
  doc: EditorState["doc"],
  catalog: CatalogState,
): BannerState {
  const range = cachedLocateFrontmatter(doc);
  if (range === null) return { kind: "none" };
  const body = doc.sliceString(range.bodyStart, range.bodyEnd);
  const ref = readCoverFromFmBody(body);
  if (ref === null) return { kind: "none" };
  const resolution = resolveCatalog(catalog, ref.id);
  if (resolution.kind === "loading") return { kind: "loading" };
  // `deleted` collapses into `none`: a dangling cover leaves the note looking
  // like a note without one.
  if (resolution.kind === "deleted") return { kind: "none" };
  return { kind: "image", id: ref.id, filename: ref.filename };
}

/**
 * The banner itself. Carries ONE field: the resolved URL, or `null` while the
 * catalog is still loading.
 *
 * It deliberately does NOT carry the embed's filename. `AttachmentImageWidget`
 * does, because there the filename feeds `alt` and `aria-label`; here the cover
 * is decorative (`alt=""`, `aria-hidden`), so storing it would only mean the
 * banner re-renders when a user edits the alias, changing nothing on screen.
 *
 * The URL is resolved at BUILD time and is the whole of `eq()` for the same
 * reason the inline image widget does it: on web the host warms an id from a
 * pending placeholder to a real blob URL, and a widget that compares equal
 * would keep the stale src forever (#211).
 */
class CoverBannerWidget extends WidgetType {
  constructor(private readonly url: string | null) {
    super();
  }

  eq(other: CoverBannerWidget): boolean {
    return other.url === this.url;
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-cover-banner";
    frame.setAttribute("data-testid", COVER_BANNER_TESTID);
    const url = this.url;
    if (url === null) {
      // Height only. No spinner and no skeleton shimmer: the banner is
      // decorative, and a pulsing bar above every note the moment it opens is
      // louder than the thing it stands in for.
      frame.setAttribute("data-state", "loading");
      return frame;
    }

    frame.setAttribute("data-state", "resolved");

    // Change / Remove, revealed on hover. Omitted entirely when the host has no
    // cover seam (the affordance is hidden rather than shown broken), and when
    // the surface is READ-ONLY.
    //
    // The read-only half is myne-md/myne#564's contract applied to the control
    // that needed it most. These two do not go through the document, so neither
    // `EditorState.readOnly` nor the reading mirror's `NOOP_ON_CHANGE` stops
    // them: they call the host, which re-encrypts the note on disk. The task
    // checkbox refuses for exactly this reason and its write is the one that
    // gets THROWN AWAY; this one persists. `PaneView` renders the reading
    // companion as a strict read-only mirror of the same buffer, so without
    // this, hovering that mirror's banner and pressing Remove clears the note's
    // cover from a surface documented as never writing.
    //
    // `writableHost` rather than a `view.state.readOnly` clause here: the rule
    // belongs to the seam, which is where the write-capable members are
    // declared, so the third such control inherits it instead of re-deciding.
    const cover = writableHost(view.state).cover;
    if (cover !== undefined) {
      // Read the note LIVE at activation, never captured here (myne-md/myne#520).
      // `eq()` compares the resolved URL alone, so CM6 legitimately keeps this
      // DOM across a note swap whenever the two notes point at the same
      // attachment, and a closure taken now would then name the note the pane
      // used to hold. Same discipline as the task `+` affordance, which resolves
      // its line from the DOM for the same class of reason.
      const target = (): string | null => readNoteId(view.state);
      const controls = document.createElement("div");
      controls.className = "cm-cover-banner-controls";
      controls.appendChild(
        makeCoverControl(COVER_CHANGE_TESTID, i18n.t("editor.cover.change"), () =>
          // `true`: these controls only render on a banner, and a banner only
          // renders for a note that has a resolvable cover.
          cover.openPicker(true, target()),
        ),
      );
      controls.appendChild(
        makeCoverControl(COVER_REMOVE_TESTID, i18n.t("attachments.coverPicker.removeCover"), () =>
          cover.remove(target()),
        ),
      );
      frame.appendChild(controls);
    }

    const img = document.createElement("img");
    img.className = "cm-cover-banner-img";
    img.src = url;
    // Decorative: the cover carries no information the note does not, and the
    // filename is not a description. An empty alt keeps it out of the
    // accessibility tree rather than reading a filename aloud.
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    // The widget's height is fixed by the token, but the IMAGE decoding still
    // changes layout inside it on some engines, and CM6 caches a measured
    // height. Re-measure once the bytes land or the cursor lands in the wrong
    // place for the rest of the session.
    img.addEventListener("load", () => view.requestMeasure(), { once: true });
    frame.appendChild(img);
    return frame;
  }

  /** Fixed by the token, so CM6 can lay out before the image decodes. */
  get estimatedHeight(): number {
    return COVER_BANNER_FALLBACK_HEIGHT;
  }

  // No `ignoreEvent` override: CM6's `WidgetType` already returns true for
  // every event ("the default is to ignore all events"), which is what the
  // hover buttons need. An override returning true is the default written out,
  // and a comment calling it load-bearing would be a claim about code that does
  // nothing.
}

/** Layout estimate CM6 uses before the DOM is measured. Kept in step with the
 *  `--cover-banner-h` token; a wrong estimate only costs one re-measure. */
const COVER_BANNER_FALLBACK_HEIGHT = 180;

function buildCoverDecorations(state: EditorState): DecorationSet {
  const banner = coverBannerState(state.doc, state.field(catalogField, false) ?? null);
  if (banner.kind === "none") return Decoration.none;
  return Decoration.set(
    Decoration.widget({
      widget: new CoverBannerWidget(
        banner.kind === "loading" ? null : attachmentUrl(banner.id),
      ),
      block: true,
      // Above everything at position 0, including the frontmatter block.
      side: -1,
    }).range(0),
  );
}

const coverBannerStateField = StateField.define<DecorationSet>({
  create(state) {
    return buildCoverDecorations(state);
  },
  update(decorations, tr) {
    // Doc changes are the obvious trigger; the catalog is the non-obvious one
    // (`catalogChanged` documents why). Both guards run before any work.
    if (!tr.docChanged && !catalogChanged(tr)) return decorations;
    return buildCoverDecorations(tr.state);
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

/** The cover-banner extension bundle. */
export function coverBannerExtension(): readonly Extension[] {
  return [coverBannerStateField];
}
