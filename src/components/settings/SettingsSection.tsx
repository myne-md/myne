// A titled group of related controls inside a settings panel (MYND-624).
//
// Every panel used to be one flat run of control blocks. That is readable at
// four rows and unreadable at nine: with nothing marking where one concern ends
// and the next begins, finding a setting means reading every label top to
// bottom, and the panel gives no sense of what it actually covers. MYND-536
// answered the same complaint with a search box, which helps when you know the
// name of what you want — this is the other half, for when you are looking to
// see what is there.
//
// **This is the ONE section treatment in the settings tree** (myne-md/myne#885).
// The Editor tab was the tab the requester read as correct, and the reason is
// precise rather than atmospheric: it is the one tab that composed THIS component
// for every group of related controls, so every concern had a titled seam
// instead of a run of rows with nothing between them. Every other panel either
// hand-rolled the same idea with its own values (`AiPanel`'s `GROUP_HEADING_*`,
// `HotkeysPanel`'s `GROUP_HEADING_STYLE`) or drew no seam at all. Both of those
// are gone; a panel that groups controls composes this, so the two cannot drift
// apart again. `tests/components/settingsSectionTreatment.test.tsx` is the
// machine half of that sentence.
//
// **The rule carries the accent** (myne-md/myne#885). `docs/design/README.md`
// sanctions the accent for focus rings, primary actions, links and the sidebar's
// active selection, and the section seam is the fifth use it now names. The
// colour is not decoration and it is not the only signal: the rule marks where
// one concern ends and the next begins, which is exactly the structure the
// heading names, and the heading carries `--accent` while the seam rule marks the boundary, so a reader who cannot see the
// colour (colour-blind, high contrast, a monochrome custom theme) still gets the
// grouping from the text. That is the test for whether an accent use is real: if
// the surface stops communicating with the colour removed, the colour was
// carrying something it should not.
//
// Deliberately plain: a small uppercase heading in the panel's own type ramp
// and a hairline, not a card or a collapsible. The groups exist to let the eye
// skip, not to add chrome or another thing to click open. Nothing here is
// interactive, so nothing here can be in the wrong state.
//
// **The rule is `aria-hidden` on purpose.** The grouping reaches assistive tech
// through the `<section aria-label>` and the `<h3>` inside it, so the rule is
// visual reinforcement of a structure the text already states. A
// `role="separator"` here would announce a boundary between every pair of
// sections on top of the two headings that already name them, which is noise
// rather than structure. (The one place a rule IS the structure, with no heading
// beside it, is a resize handle, and that is `ResizeHandle.tsx`.)

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  // The accent, like the rule beside it (myne-md/myne#885 visual pass): heading
  // and rule are one seam, and a grey heading beside an accent rule read as two
  // things. Small uppercase text in the accent holds contrast on all three
  // palettes (`#2c4a7a` on paper, `#8aa4d0` on the dark grounds).
  color: "var(--accent)",
  whiteSpace: "nowrap",
};

// The one tone, and what it is allowed to change (myne-md/myne#885).
//
// Account's danger section arrived on this component with its heading in the
// shared heading colour, and the red the section used to carry went with it. The
// warning is not decoration: the heading names the one control in the dialog
// that destroys a vault, and `PRODUCT.md` asks for a surface that reports that
// honestly rather than one that buries it in the same grey as the icon picker.
//
// **The tone moves the HEADING only, and the seam rule stays `--accent`.** The
// alternative (a red rule too) would make the seam two idioms wearing one
// component, and `docs/design/README.md` sanctions exactly one: the accent rule
// a settings section draws. The heading is where the danger is stated, so the
// heading is where the colour belongs; the rule keeps marking where one concern
// ends, in the same colour it marks every other one. The canon records the one
// tone in the same change (the accent sentence names the accent heading, and this
// is the exception).
const TITLE_DANGER_STYLE: CSSProperties = {
  ...TITLE_STYLE,
  color: "var(--danger)",
};

// The rule runs to the panel edge so the heading reads as a divider rather than
// a label floating above unrelated rows, and it is the accent because that is
// what makes the boundary findable at a glance while scrolling. See the header:
// the heading carries the same grouping without colour.
const RULE_STYLE: CSSProperties = {
  flex: "1 1 auto",
  height: 1,
  background: "var(--accent)",
};

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

/**
 * How many sections the enclosing settings TOPIC holds (myne-md/myne#885 visual
 * pass).
 *
 * A topic whose whole body is one section has its name twice: once as the tab,
 * once as the section heading under it, with an accent rule between that
 * separates the topic from nothing. So a section that is the only one in its
 * topic draws no heading and no rule; the tab is its heading. It is counted at
 * runtime rather than declared per topic because a topic's section count is not
 * fixed: capability gates and vault state add and remove sections (the Sync
 * panel's members sections exist only on a shared-capable client), and a
 * declared flag would go stale the first time one did.
 *
 * Outside a topic (a single-screen panel, a story) there is no provider and
 * every section draws its heading, which is the pre-change behaviour.
 */
interface SectionCountValue {
  count: number;
  register: () => () => void;
}

const SectionCountContext = createContext<SectionCountValue | null>(null);

/** Wrap one topic's body so its sections can tell whether they are alone. */
export function SettingsSectionCounter({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const register = useCallback(() => {
    setCount((n) => n + 1);
    return () => setCount((n) => n - 1);
  }, []);
  const value = useMemo(() => ({ count, register }), [count, register]);
  return <SectionCountContext.Provider value={value}>{children}</SectionCountContext.Provider>;
}

export function SettingsSection({
  title,
  testId,
  tone = "default",
  action,
  children,
}: {
  title: string;
  /** Optional testid on the section root, for E2E to scope within a group. */
  testId?: string;
  /**
   * `default` carries the shared `--accent` heading, which is what the canon
   * states. `danger` is the one tone: the
   * heading carries `--danger` because the section destroys something, and the
   * seam rule is unchanged (see `TITLE_DANGER_STYLE`). The grouping still reads
   * without the colour, so the tone is reinforcement and not the only signal.
   */
  tone?: "default" | "danger";
  /**
   * One control, at the far end of the seam, acting on what the section holds
   * (myne-md/myne#945). A section-level action belongs on the seam rather than
   * in the body because the body is a vertical run of blocks: a button inside
   * it competes with the first row for the eye, and a button ABOVE the rows
   * pushed them down by a control's height to say something the heading can
   * say in the corner. One action only: a second means the section is two
   * concerns.
   */
  action?: ReactNode;
  children: ReactNode;
}) {
  const counter = useContext(SectionCountContext);
  const register = counter?.register;
  useLayoutEffect(() => (register === undefined ? undefined : register()), [register]);
  // Alone in its topic: the tab already names it. The `<section>` and its
  // `aria-label` stay, so the group is still announced and its testid still
  // resolves; only the visible heading and rule go.
  const alone = counter !== null && counter.count === 1;
  return (
    <section
      style={SECTION_STYLE}
      data-testid={testId}
      aria-label={title}
      data-section-alone={alone ? "true" : undefined}
    >
      {(!alone || action !== undefined) && (
        <div style={HEADER_STYLE}>
          {!alone && (
            <h3 style={tone === "danger" ? TITLE_DANGER_STYLE : TITLE_STYLE}>
              {title}
            </h3>
          )}
          {!alone && <span style={RULE_STYLE} aria-hidden="true" />}
          {/* `marginInlineStart: auto` is what puts the action at the far end
              when the rule is absent, which is the "alone in its topic" case,
              where the heading is gone and the rule with it. Without it the
              action would slide to the left edge and read as the first row. */}
          {action !== undefined && (
            <div style={{ marginInlineStart: "auto", display: "flex" }}>{action}</div>
          )}
        </div>
      )}
      <div style={BODY_STYLE}>{children}</div>
    </section>
  );
}
