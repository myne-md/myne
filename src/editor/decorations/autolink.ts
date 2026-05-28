// Autolink decoration for the Phase 1 editor.
//
// Covers two markdown forms the @lezer/markdown GFM grammar recognizes:
//
//   <https://url>  /  <email@domain>   → `Autolink` node
//                                          (LinkMark `<`, URL, LinkMark `>`)
//   https://url    /  email@domain      → bare `URL` node (GFM autolink
//                                          extension; trailing punctuation
//                                          like `.`, `,`, `)` is already
//                                          excluded by the parser)
//
// MYND-150 (angle-bracket autolinks) + MYND-151 (bare URLs / emails).
//
// Angle form: hide the `<` `>` LinkMarks off-cursor, underline the URL,
// reveal the raw `<...>` when the cursor enters (same cursor-aware reveal
// as every other inline mark). Bare form is decoration-only — no markup to
// hide, the source text is never mutated.
//
// Both forms carry a `data-cm-url` attribute; `openLinkOnClick` opens it via
// the OS default handler on plain click. Only http / https / mailto schemes
// are made clickable — other schemes (e.g. `<javascript:...>`) are left as
// raw text so a malicious scheme can never be one-click-invoked.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

/** Resolve the clickable href for an autolink target, or `null` when the
 *  scheme is not one we are willing to hand to the OS opener.
 *
 *  - explicit scheme present → allowed only for http / https / mailto
 *  - no scheme + contains `@` → treated as an email, prefixed `mailto:`
 *  - anything else → null (not clickable) */
function resolveHref(raw: string): string | null {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
      return raw;
    }
    return null;
  }
  if (raw.includes("@")) return `mailto:${raw}`;
  return null;
}

function linkMark(from: number, to: number, href: string): Range<Decoration> {
  return Decoration.mark({
    class: "cm-link",
    attributes: { "data-cm-url": href },
  }).range(from, to);
}

function buildAutolinkDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Autolink") {
          let urlFrom: number | null = null;
          let urlTo: number | null = null;
          const markRanges: Array<[number, number]> = [];
          let child = node.node.firstChild;
          while (child !== null) {
            if (child.name === "URL") {
              urlFrom = child.from;
              urlTo = child.to;
            } else if (child.name === "LinkMark") {
              markRanges.push([child.from, child.to]);
            }
            child = child.nextSibling;
          }
          if (urlFrom !== null && urlTo !== null) {
            const href = resolveHref(
              view.state.doc.sliceString(urlFrom, urlTo),
            );
            if (href !== null) {
              decorations.push(linkMark(urlFrom, urlTo, href));
              // Hide the `<` `>` brackets unless the cursor is inside the
              // autolink (cursor-aware reveal lifts the whole decoration).
              if (!isInsideRange(view, node.from, node.to)) {
                for (const [f, t] of markRanges) {
                  decorations.push(Decoration.replace({}).range(f, t));
                }
              }
            }
          }
          // URL / LinkMark children handled here; don't descend (keeps the
          // bare-URL branch below from re-decorating the inner URL).
          return false;
        }

        if (node.name === "URL") {
          // URL nodes also appear as children of `Link` (`[text](url)`) and
          // `Autolink` — those are handled elsewhere. Only bare URLs (parent
          // is a block / paragraph) get the decoration-only treatment.
          const parent = node.node.parent;
          if (
            parent !== null &&
            (parent.name === "Link" || parent.name === "Autolink")
          ) {
            return undefined;
          }
          const href = resolveHref(view.state.doc.sliceString(node.from, node.to));
          if (href !== null) {
            decorations.push(linkMark(node.from, node.to, href));
          }
          return undefined;
        }

        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

/** Plain-click on a rendered autolink / bare URL opens it via the OS default
 *  handler (Tauri opener plugin; capability gated in
 *  `src-tauri/capabilities/default.json`). Handled on `mousedown` +
 *  `preventDefault` so the click does not also move the cursor into the link
 *  — to edit the raw text the user arrows in, which lifts the decoration via
 *  cursor-aware reveal and removes `data-cm-url` from the DOM. */
const openLinkOnClick = EditorView.domEventHandlers({
  mousedown(event) {
    if (event.button !== 0) return false;
    const target = event.target as Element | null;
    const linkEl = target?.closest?.("[data-cm-url]") ?? null;
    if (linkEl === null) return false;
    const url = linkEl.getAttribute("data-cm-url");
    if (url === null || url === "") return false;
    openUrl(url).catch((err: unknown) => {
      if (import.meta.env.DEV) {
        console.warn("autolink: openUrl rejected", err);
      }
    });
    event.preventDefault();
    return true;
  },
});

export function autolinkDecorations(): readonly Extension[] {
  return [makeCursorAwareDecorationPlugin(buildAutolinkDecorations), openLinkOnClick];
}
