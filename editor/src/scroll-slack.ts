// Scroll slack past the last line (#375).
//
// Without it the scroll range ends AT the last line: the tail of a long note is
// always written at the very bottom edge of the window, the one place you cannot
// scroll away from. Every other line can be centred by scrolling; the last one
// cannot. This reserves space below the document so it can be.
//
// CodeMirror ships `scrollPastEnd()` and it is the WRONG extension here. It sizes
// its padding from `view.scrollDOM.clientHeight`, and in Myne `.cm-scroller` never
// scrolls — the editor grows to fit its content inside an OUTER host scroller on
// every client (desktop/web `PaneView.tsx`, mobile `EditorFlow.tsx`). So
// `scrollDOM.clientHeight` IS the content height: the padding would come out at
// roughly the document height and then feed itself on the next measure. Its own
// doc comment says so — "should not be enabled in editors that take the size of
// their content". Same mechanism, then, different measurement.
//
// The slack is `padding-bottom` on `.cm-content`, deliberately:
//   - not a margin, and not padding on the host wrapper: a margin sits outside the
//     box CM6 measures, which is the drift the math/mermaid/embed blocks were fixed
//     for (see `theme.ts`) — padding on `.cm-content` is space CM6 knows about;
//   - inside `.cm-content` the slack is part of the editable surface, so clicking
//     it lands the caret on the last line rather than being dead space (the same
//     property `.cm-content { min-height: 100% }` exists to give, MYND-162).

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** Share of the visible viewport reserved below the last line. */
const SLACK_FRACTION = 0.6;
/** Upper bound on that share, in px. */
const SLACK_CAP_PX = 480;

const SCROLLING_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

/**
 * The element that actually scrolls: the nearest ancestor of the editor with a
 * scrolling `overflow-y`, or `view.scrollDOM` when the editor owns its own scroll.
 *
 * The walk starts OUTSIDE the editor on purpose. CM6's base theme gives
 * `.cm-scroller` a scrolling overflow whether or not it has a bounded height, so
 * asking it directly answers "is it allowed to scroll", not "does it". Every Myne
 * host wraps the editor in a bounded `overflow: auto` div and lets the editor grow,
 * so the ancestor is the honest answer — and its height does not depend on the
 * content, which is what keeps the padding below from feeding itself.
 */
export function resolveScrollHost(view: EditorView): HTMLElement {
  for (
    let el = view.dom.parentElement;
    el !== null && el !== el.ownerDocument.documentElement;
    el = el.parentElement
  ) {
    const overflowY = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY;
    if (overflowY !== undefined && SCROLLING_OVERFLOW.has(overflowY)) return el;
  }
  return view.scrollDOM;
}

/**
 * Slack for a host viewport of `hostHeight` px. The cap is a safety net as much as
 * a design choice: should the resolver ever fall back to a content-sized scroller,
 * the value settles at the cap instead of growing on every measure.
 */
export function slackFor(hostHeight: number): number {
  if (!Number.isFinite(hostHeight) || hostHeight <= 0) return 0;
  return Math.round(Math.min(hostHeight * SLACK_FRACTION, SLACK_CAP_PX));
}

// A stable key so a burst of updates coalesces to ONE measure per frame.
const slackMeasureKey = {};

const slackPlugin = ViewPlugin.fromClass(
  class {
    private applied = -1;
    private host: HTMLElement | null = null;
    // CM6's own observers watch `scrollDOM` / `contentDOM`, which are
    // content-sized here — a purely VERTICAL resize of the pane never reaches
    // them, so without this the slack would keep a stale height until the next
    // edit. Absent in jsdom, where the plugin is inert anyway.
    private readonly observer: ResizeObserver | null =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            this.schedule();
          });

    constructor(readonly view: EditorView) {
      this.schedule();
    }

    update(u: ViewUpdate) {
      if (u.geometryChanged) this.schedule();
    }

    destroy() {
      this.observer?.disconnect();
    }

    /**
     * Write the padding in the measure cycle's WRITE phase — the same discipline
     * `focus-mode.ts` uses for its scroll write, and the reason this owns
     * `contentDOM`'s inline `style` outright. Nothing may add a `style` entry to
     * `EditorView.contentAttributes` (today the only entry is `spellcheck`) without
     * revisiting that: CM6 would then manage the attribute and clobber this.
     *
     * The host is re-resolved on every pass rather than cached: a pane split or a
     * note swap re-parents the editor, and a cached host would leave the observer
     * watching a detached element and the slack sized to a viewport that is no
     * longer the one on screen.
     */
    private schedule() {
      const host = resolveScrollHost(this.view);
      if (host !== this.host) {
        if (this.host !== null) this.observer?.unobserve(this.host);
        this.host = host;
        this.observer?.observe(host);
      }
      this.view.requestMeasure({
        key: slackMeasureKey,
        read: () => slackFor(host.clientHeight),
        write: (slack) => {
          if (slack === this.applied) return;
          this.applied = slack;
          this.view.contentDOM.style.paddingBottom = `${slack}px`;
        },
      });
    }
  },
);

/** Reserve scroll slack below the last line so it can be lifted off the bottom
 *  edge of the viewport. Always mounted; inert where nothing scrolls. */
export function scrollSlackExtension(): Extension {
  return [slackPlugin];
}
