// `<HelperDisclosure>`: the question mark beside a setting's title that holds
// the copy the row does not need to show (myne-md/myne#885).
//
// ── The failure it closes ──────────────────────────────────────────────────
//
// A settings row carried ONE helper slot, and every sentence a setting had to
// say went into it. The worst of them rendered 776 characters under one label
// (the Privacy hide-vault-names row, four paragraphs), and eleven `settings.*`
// strings ran past 250 characters. A row that is an essay is a row the user
// stops reading, so the one sentence they needed was buried under the four
// they did not.
//
// The shape is the requester's own, in their words: the critical sentence stays
// on the row, the rest moves behind a question mark beside the setting's title,
// and the user opens it. "tooltip or modal" was the mechanism they left open,
// and it is a DISCLOSURE rather than a tooltip for one measured reason: the
// existing `primitives/Tooltip.tsx` is `whiteSpace: "nowrap"` with no focusable
// trigger of its own, so a paragraph cannot ride it without being rewritten
// into a single clipped line. A disclosure wraps.
//
// ── Three things that are not optional ─────────────────────────────────────
//
// **It is not hover-only.** A surface that needs a pointer is not an affordance
// in this product (`PRODUCT.md` commits to WCAG 2.2 AA), so the trigger is a
// real focusable button that opens on hover, on focus and on press. Hover is
// the convenience; the button is the mechanism.
//
// **The copy reaches assistive tech while COLLAPSED.** The description element
// is in the document at all times and is named by the row's control through
// `aria-describedby`, so a screen reader reads the whole explanation whether or
// not the disclosure was ever opened. A visually-hidden-until-hover surface is
// the failure this file exists to prevent, and `aria-describedby` is the
// mechanism this tree already uses for a setting's helper text
// (`SettingRow.tsx` hands the control its helper's id for exactly this).
//
// **It does not portal, and that is deliberate.** `Tooltip` and `Select` render
// their bubbles into `document.body`, and inside the Settings modal that target
// is a SIBLING of the modal's backdrop, which `useOverlayInert` marks `inert`
// (`editor/src/host/lib/overlay-inert.ts`). A `display: none` description
// survives `inert` for the description computation, but the VISIBLE popover
// would not: opening a panel's own dialog re-runs `apply()` and would inert a
// body-portaled bubble mid-read. So the element stays inside the modal subtree,
// where it is on the overlay path and never inert, and `position: fixed` is
// what keeps it out of the content column's `overflow: auto` instead.
//
// ── Why the trigger is an `IconButton` and not a bare `<button>` ───────────
//
// It is the same square, token-only control every other icon affordance in the
// tree is (`check-primitive-adoption.mjs` is a ratchet and a new file starts at
// zero). It passes `nativeTitle={false}` because this trigger opens its own
// popover on hover, and the OS chip arriving over that popover a second later
// is the duplication the tooltip convention exists to remove.
//
// `src/AGENTS.md` "Test observability": the trigger carries a testid derived
// from the row's own, so a scenario can press the question mark on a named row
// (`settings.hide-vault-names-explain`) rather than finding it by position.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "../primitives/IconButton";

/** Gap between the trigger and the popover. */
const GAP = 6;
/** Keep the popover this far from the window edge when clamping. */
const EDGE = 8;

/**
 * A readable measure for prose, in px.
 *
 * A literal rather than a token, deliberately: the token sheet has no measure
 * scale and this is a LAYOUT bound the way `Select`'s `minWidth` and the
 * content column's `maxWidth` are, not a themed value. `check-token-adoption`
 * counts colour, radius, spacing and type literals, which is the set a custom
 * theme has to reach.
 */
const MEASURE = 360;

const POPOVER_STYLE: CSSProperties = {
  position: "fixed",
  // The canon's own step for "a menu or disclosure anchored to a control"
  // (`client-core/src/tokens.css`). It is inside the modal's stacking context,
  // so this paints above the panel content and never above the modal itself.
  zIndex: "var(--z-dropdown)",
  maxWidth: MEASURE,
  background: "var(--bg-1)",
  color: "var(--fg-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  padding: "var(--space-3) var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  // The popover is read, not operated: nothing inside it is interactive, so it
  // never takes the pointer the user is aiming at the trigger. That is also why
  // leaving the trigger closes it rather than requiring a click on the bubble.
  pointerEvents: "none",
};

const PARAGRAPH_STYLE: CSSProperties = {
  margin: 0,
};

// The trigger sits INLINE after the label text, so it follows the last word of
// a wrapped label rather than being pushed to the row's far edge. The
// requester's own words were "beside the setting's title", and the label cell is
// where the title lives.
const TRIGGER_ROW_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  verticalAlign: "middle",
  marginInlineStart: "var(--space-2)",
};

interface HelperDisclosureProps {
  /**
   * The copy that did not fit on the row, one string per paragraph. Already
   * localised: call `t()` at the panel, never here (the same rule
   * `SettingRow`'s own `label` carries).
   */
  paragraphs: readonly string[];
  /**
   * The id of the description element. `SettingRow` generates it and hands it
   * to the row's control, which names it in `aria-describedby`, so the copy is
   * associated with the setting in the collapsed state.
   */
  descriptionId: string;
  /**
   * The BASE for the two testids: the trigger takes `${testId}-explain` and the
   * description element `${testId}-explanation`. A base rather than two props,
   * because `SettingRow` already has the row's own testid and deriving both from
   * it is what keeps a scenario on a NAMED row (`settings.hide-vault-names-explain`)
   * rather than finding the affordance by position.
   */
  testId?: string;
  /**
   * Accessible name for the trigger. Defaults to the shared
   * `settings.helperDisclosureLabel` ("More about this setting"), which is right
   * on a settings row and wrong in a destructive dialog. That is the only shape
   * this prop exists for (myne-md/myne#960).
   */
  triggerLabel?: string;
}

interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

export function HelperDisclosure({
  paragraphs,
  descriptionId,
  testId,
  triggerLabel,
}: HelperDisclosureProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Hovering the trigger. Mouse only: on a touch device the pointer's "enter"
  // is the tap itself, and opening on hover there would fight the press.
  const [hovered, setHovered] = useState(false);
  // Opened by the button itself: a press, or a keyboard focus.
  const [pinned, setPinned] = useState(false);
  // True while the focus that arrived came from a POINTER. Without it a tap
  // would open on focus and close again on the press that follows it, which is
  // a control that does nothing on the one device that has no hover.
  const pointerFocusRef = useRef(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const open = hovered || pinned;

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.top, bottom: r.bottom });
  }, []);

  // Measure on open, and again while open so the popover stays attached to the
  // trigger if the panel behind it scrolls or the window resizes. The content
  // column is the scroll container and it is an ancestor, so the listener is on
  // the window with capture, which is the only way to see a scroll it did not
  // originate.
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      setCoords(null);
      return;
    }
    measure();
    const onMove = () => measure();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, measure]);

  // Place once the bubble has a measurable height. `useLayoutEffect` so the
  // correction lands in the same paint as the bubble's first appearance, and
  // the bubble stays hidden for that one frame rather than painting in the
  // wrong place and jumping.
  //
  // **The bubble must be LAID OUT while this measures, which is why the open
  // state renders it at a provisional position instead of `display: none`.**
  // The first version toggled `display` on `coords !== null`, so the effect
  // measured an element that was `display: none` and read a height of zero: the
  // flip-above branch and both clamps were then computed against nothing, and a
  // popover near the bottom of the window ran off it. In jsdom every box is zero
  // either way, so only a real layout shows the difference, and the fix is the
  // shape `Tooltip.tsx` already uses: place it, measure it, then make it
  // visible.
  useLayoutEffect(() => {
    if (!open || anchor === null) return;
    const h = bubbleRef.current?.offsetHeight ?? 0;
    const w = bubbleRef.current?.offsetWidth ?? 0;
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - h;
    const top =
      below + h > window.innerHeight - EDGE && above >= EDGE ? above : below;
    const maxLeft = window.innerWidth - EDGE - w;
    setCoords({
      left: Math.max(EDGE, Math.min(anchor.left, Math.max(EDGE, maxLeft))),
      top: Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - h)),
    });
  }, [open, anchor, paragraphs]);

  const dismiss = useCallback(() => {
    setPinned(false);
    setHovered(false);
    // The trigger keeps focus (Escape closes the explanation, it does not move
    // the user out of the row) which is what "returns focus where it came from"
    // means for a surface that never took it.
    triggerRef.current?.focus();
  }, []);

  return (
    <span
      style={TRIGGER_ROW_STYLE}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onPointerDown={() => {
        pointerFocusRef.current = true;
      }}
      onFocusCapture={() => {
        if (!pointerFocusRef.current) setPinned(true);
      }}
      onBlurCapture={() => {
        pointerFocusRef.current = false;
        setPinned(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        // Stop here rather than at the modal: `SettingsModal.tsx` listens on
        // `window` for Escape and closes the whole dialog, so without this an
        // Escape aimed at the explanation would dismiss Settings instead.
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }}
    >
      <IconButton
        icon="circle-help"
        label={triggerLabel ?? t("settings.helperDisclosureLabel")}
        expanded={open}
        nativeTitle={false}
        iconSize={14}
        testId={testId === undefined ? undefined : `${testId}-explain`}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          // **A press that closes also drops the hover peek**, and without that
          // the click reads as doing nothing. A pointer resting on the trigger
          // has already opened it through `hovered`, so clearing `pinned` alone
          // leaves `open` true and the button appears inert: the end-to-end
          // scenario found exactly that, three runs out of three, on the
          // "second press closes it" step. The pointer has to LEAVE and come
          // back to reopen it, which is the behaviour a dismissable
          // hover-popover should have anyway.
          if (!next) setHovered(false);
        }}
        ref={triggerRef}
      />
      <div
        id={descriptionId}
        ref={bubbleRef}
        role="tooltip"
        data-testid={testId === undefined ? undefined : `${testId}-explanation`}
        data-open={open ? "true" : undefined}
        style={
          // Collapsed: present in the document, named by the control's
          // `aria-describedby`, and not painted. `display: none` rather than the
          // clipped `VISUALLY_HIDDEN` box, because this element becomes the
          // visible popover and a clip rect would leave the two states one
          // property apart in a way no reader of the DOM can tell apart.
          //
          // Open: laid out from the first frame, at the anchor until the clamp
          // has measured, and hidden by `visibility` for that one frame. The
          // collapse is `display` because a collapsed description should not be
          // painted at all; the measuring frame is `visibility` because it must
          // have a box to measure.
          open && anchor !== null
            ? {
                ...POPOVER_STYLE,
                left: coords?.left ?? anchor.left,
                top: coords?.top ?? anchor.bottom + GAP,
                visibility: coords === null ? "hidden" : "visible",
              }
            : { display: "none" }
        }
      >
        {paragraphs.map((paragraph, i) => (
          <p key={i} style={PARAGRAPH_STYLE}>
            {paragraph}
          </p>
        ))}
      </div>
    </span>
  );
}
