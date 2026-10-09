// Design-system documentation pages (myne-md/myne#845).
//
// These are the narrative half of the catalogue: Foundations shows the VALUES,
// these explain the RULES and embed the same specimens, so a reader gets the
// principle and the evidence together. The specimens are imported rather than
// re-rendered, so a documentation page cannot show a different value from the
// specimen it is talking about.

import type { CSSProperties, ReactNode } from "react";
import {
  ColoursSpecimen,
  IconsSpecimen,
  MetricsSpecimen,
  MotionSpecimen,
  RadiiSpecimen,
  ShadowsSpecimen,
  SpacingSpecimen,
  TypeSpecimen,
  ZIndexSpecimen,
} from "./foundations";
import type { StoryDescriptor } from "../types";

const PAGE_STYLE: CSSProperties = {
  maxWidth: "var(--content-max-w)",
  padding: "var(--space-6)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
};

const TITLE_STYLE: CSSProperties = {
  margin: "0 0 var(--space-3)",
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)",
};

const LEDE_STYLE: CSSProperties = {
  margin: "0 0 var(--space-4)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-relaxed)",
  color: "var(--fg-2)",
};

const SECTION_STYLE: CSSProperties = {
  margin: "var(--space-5) 0 var(--space-2)",
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
};

const RULE_STYLE: CSSProperties = {
  margin: "0 0 var(--space-2)",
  paddingInlineStart: "var(--space-4)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-relaxed)",
  color: "var(--fg-2)",
};

/** One documented rule: what it is, and why it holds. */
function Rule({ children }: { children: ReactNode }) {
  return <li style={RULE_STYLE}>{children}</li>;
}

function DocPage({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <div style={PAGE_STYLE}>
      <h1 style={TITLE_STYLE}>{title}</h1>
      <p style={LEDE_STYLE}>{lede}</p>
      {children}
    </div>
  );
}

export const DOC_STORIES: StoryDescriptor[] = [
  {
    id: "documentation/design-system/typography",
    group: "documentation",
    surface: "Typography",
    state: "documentation",
    description: "The type scale, the two families and the weight and tracking tokens.",
    tags: ["documentation", "typography", "type", "font", "design system"],
    render: () => (
      <DocPage
        title="Typography"
        lede="Two families, one scale, and a rule about when each applies. The values live in the token sheet; this page is the reasoning behind them."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Sans for the interface, mono for data.</strong> Inter carries
            labels, prose and controls. JetBrains Mono is reserved for the values
            a reader compares character by character: account numbers, key
            chords, file paths, byte counts.
          </Rule>
          <Rule>
            <strong>One scale, no in-between sizes.</strong> A size that is not a
            token is a size no theme can adjust. If a screen needs a size the
            scale lacks, the scale is what changes.
          </Rule>
          <Rule>
            <strong>Sentence case in copy.</strong> Buttons, headings and menu
            items read as sentences. Title case is reserved for proper nouns.
          </Rule>
          <Rule>
            <strong>Two casings, and the context decides which.</strong> Product
            copy is sentence case; a <em>name</em> in a list is Title Case. The
            rail, the inspector labels and every component display name are
            names, so they read "Icon Button" and "Modal Shell": a list whose
            entries are capitalised alike scans faster, and a component name is a
            noun rather than a sentence. Neither casing is preferred in general ,
            they are answers to two different questions, and mixing them in one
            context is what looks wrong.
          </Rule>
          <Rule>
            <strong>The rail name invents nothing.</strong> It is the component
            name with its casing changed and nothing else, so the catalogue and
            the code cannot grow two vocabularies for one thing. The rare
            exception is an explicit <code>title</code> on a story.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>The scale</h2>
        <TypeSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/colour",
    group: "documentation",
    surface: "Colour",
    state: "documentation",
    description: "Colour roles, the four palettes, and why a literal is never used.",
    tags: ["documentation", "colour", "palette", "theme", "design system"],
    render: () => (
      <DocPage
        title="Colour"
        lede="Colour is expressed as a role, never as a value. A component names what a colour is for, and the active theme decides what that looks like."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Roles, not hex.</strong> A literal in an inline style outranks
            every stylesheet, so it is unreachable to any theme, permanently. The
            token-adoption ratchet may only shrink.
          </Rule>
          <Rule>
            <strong>Four palettes.</strong> Light, dark and amoled are values in
            the sheet. The theme switcher in the navbar repaints the catalogue
            through the same <code>data-theme</code> attribute the clients use.
          </Rule>
          <Rule>
            <strong>Contrast is a pair, not a colour.</strong> A verdict is only
            meaningful against a named theme, which is why the Accessibility tab
            re-measures when you switch one.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>Every colour token</h2>
        <ColoursSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/spacing",
    group: "documentation",
    surface: "Spacing",
    state: "documentation",
    description: "The spacing scale, and the control metrics that sit beside it.",
    tags: ["documentation", "spacing", "layout", "metrics", "design system"],
    render: () => (
      <DocPage
        title="Spacing"
        lede="One scale for gaps and padding, plus the control metrics that are about hit area rather than rhythm."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>A step, not a number.</strong> Spacing comes from the scale so
            a denser theme can change every gap at once.
          </Rule>
          <Rule>
            <strong>Control metrics are separate.</strong> Field padding, control
            gaps and the pointer-target floor are about a control's own box, not
            about the space between things.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>The scale</h2>
        <SpacingSpecimen />
        <h2 style={SECTION_STYLE}>Control metrics</h2>
        <MetricsSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/radius",
    group: "documentation",
    surface: "Border Radius",
    state: "documentation",
    description: "The radius scale, and which step each kind of surface takes.",
    tags: ["documentation", "radius", "border radius", "corner", "design system"],
    render: () => (
      <DocPage
        title="Border Radius"
        lede="How round a corner is, as a scale rather than a per-component decision."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Radius is a role, not a taste.</strong> Buttons, cards and
            inputs share the workhorse steps; chips and dense controls sit
            tighter; modals and the command palette round further. A surface
            picks the step that names what it is.
          </Rule>
          <Rule>
            <strong>A rounded surface is still a box.</strong> Radius changes the
            corner, never the padding, the border or the shadow. A surface that
            needs a different corner AND a different inset is two decisions.
          </Rule>
          <Rule>
            <strong>The scale is finite on purpose.</strong> A radius that is not
            a token is a corner no theme can change, which is the same permanence
            a hardcoded colour has.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>The scale</h2>
        <RadiiSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/elevation",
    group: "documentation",
    surface: "Elevation",
    state: "documentation",
    description: "The shadow steps, and what each one means.",
    tags: ["documentation", "elevation", "shadow", "depth", "design system"],
    render: () => (
      <DocPage
        title="Elevation"
        lede="How far a surface floats above the page, and the rule that no step exists for decoration."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Shadows are steps, not decorations.</strong> A higher step
            means a surface is closer to the reader. There is no step that exists
            to look nice.
          </Rule>
          <Rule>
            <strong>The scrim is a shadow's sibling.</strong> Where a surface
            blocks the page rather than floating over it, it dims what is behind
            it with <code>--scrim</code> from the same token layer, so a modal
            reads as depth rather than as a flat panel laid on top.
          </Rule>
          <Rule>
            <strong>Elevation and stacking are separate questions.</strong> A
            shadow says a surface is closer to the eye; it does not decide the
            order two surfaces paint in. That is the Z-index page.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>Shadow steps</h2>
        <ShadowsSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/z-index",
    group: "documentation",
    surface: "Z-index",
    state: "documentation",
    description:
      "The stacking ladder, painted in order, and the call sites still holding a bare number.",
    tags: ["documentation", "z-index", "layering", "stacking", "design system"],
    render: () => (
      <DocPage
        title="Z-index"
        lede="The stacking order as a named ladder. A bare z-index number cannot be read: the order exists only by grepping the tree for it, and a value chosen to out-rank one neighbour is how a surface ends up under another."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Pick the role, not the number.</strong> The tokens in{" "}
            <code>client-core/src/tokens.css</code> name every step the tree
            actually paints at, ordered low to high. A surface belongs on the
            step naming what it is. A dropdown, a modal, an overlay that clears a
            modal. Never on a value raised until it beat the thing it collided
            with.
          </Rule>
          <Rule>
            <strong>A menu inside a modal needs a higher role, not a bigger
            number.</strong> The shape that broke: a <code>Select</code> at 60
            sat under a modal backdrop at 1000, so its options could not be
            clicked, and neither rule stated the relationship. The ladder now
            says an in-modal menu is <code>--z-overlay</code>, one step above{" "}
            <code>--z-modal</code>.
          </Rule>
          <Rule>
            <strong>The editor owns a band above the app.</strong> An attachment
            modal, slash menu, toast or tooltip the editor draws has to clear the
            app chrome underneath it, so the editor opens fresh at{" "}
            <code>--z-editor-modal</code> rather than continuing the app's
            ladder. That is a deliberate reservation, and it is why the two
            sequences are interleaved rather than merged.
          </Rule>
          <Rule>
            <strong>Two call sites may not share a number by accident.</strong> If
            two surfaces must not overlap, one of them is on the wrong step. A
            deliberate exception is <code>UNSOLICITED_MODAL_Z</code>, the one
            place a modal's level must be a JavaScript number because it is
            compared rather than painted.
          </Rule>
        </ul>
        <p style={LEDE_STYLE}>
          The ladder is declared in full, and the specimen below paints every step
          by applying the token itself. What remains is the debt: call sites still
          holding the bare number, in the order they paint.{" "}
          <code>src/components/primitives/ResizeHandle.tsx</code> (2),{" "}
          <code>src/components/settings/RibbonCustomizeSettings.tsx</code> (10),{" "}
          <code>src/screens/Editor.tsx</code> (30, 50, 60),{" "}
          <code>src/components/settings/AppearancePanel.tsx</code> and{" "}
          <code>PairingDialog.tsx</code> (1100),{" "}
          <code>src/components/CommandPalette.tsx</code> (1500),{" "}
          <code>src/components/QuickPicker.tsx</code> (1600, which has no ladder
          step of its own and needs a decision rather than a token),{" "}
          <code>src/components/primitives/Tooltip.tsx</code>,{" "}
          <code>SkipToContent.tsx</code> and <code>ScreenCaptureEscape.tsx</code>{" "}
          (2000), <code>src/components/toast/Toaster.tsx</code> (1000 minus its
          stack index, which is arithmetic rather than a step), plus the editor
          package's own band (<code>editor/src/</code>:{" "}
          <code>floating-styles.ts</code>, <code>mermaid-viewer-styles.ts</code>,{" "}
          <code>attachments/styles.ts</code>, <code>task-surfaces.css</code>,{" "}
          <code>task-field-menu.ts</code>, <code>task-field-editor.ts</code>). Each
          is a mechanical replacement and each is recorded here rather than
          half-done, so the ledger cannot quietly stop describing the tree.
        </p>
        <h2 style={SECTION_STYLE}>The ladder, painted</h2>
        <ZIndexSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/motion",
    group: "documentation",
    surface: "Motion",
    state: "documentation",
    description: "Durations and easings, and the rule about what may animate.",
    tags: ["documentation", "motion", "animation", "easing", "design system"],
    render: () => (
      <DocPage
        title="Motion"
        lede="Motion exists to explain a change, not to decorate one. Two durations cover almost everything."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Background and border only.</strong> Never transition on
            <code>all</code>: it also animates the focus ring, and that is the one
            piece of feedback that must be instant.
          </Rule>
          <Rule>
            <strong>Reduced motion is honoured.</strong> A reader who asks for less
            motion gets the change without the travel.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>Durations and easings</h2>
        <MotionSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/iconography",
    group: "documentation",
    surface: "Iconography",
    state: "documentation",
    description: "The icon set, and when an icon needs a label.",
    tags: ["documentation", "icons", "iconography", "glyphs", "design system"],
    render: () => (
      <DocPage
        title="Iconography"
        lede="One registry, one drawing convention, and a label rule that decides whether an icon is decoration or a control."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>One source.</strong> Icons come from the registry, so adding
            one lands everywhere at once and the Foundations guard fails until it
            has a specimen.
          </Rule>
          <Rule>
            <strong>Decorative icons are hidden from assistive tech.</strong> An
            icon beside a label is decoration; an icon that IS the control takes
            an <code>aria-label</code>.
          </Rule>
        </ul>
        <h2 style={SECTION_STYLE}>Every icon</h2>
        <IconsSpecimen />
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/accessibility",
    group: "documentation",
    surface: "Accessibility",
    state: "documentation",
    description: "What the catalogue checks, what the suites check, and who is the gate.",
    tags: ["documentation", "accessibility", "a11y", "contrast", "design system"],
    render: () => (
      <DocPage
        title="Accessibility Practice"
        lede="The catalogue SHOWS accessibility facts; the test suites ASSERT them. Knowing which is which is the point of this page."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>The Accessibility tab is a view.</strong> Roles, keyboard
            order, target sizes and per-theme contrast, measured on the story in
            front of you. It is how you find a problem, not the proof there is
            none.
          </Rule>
          <Rule>
            <strong>The suites are the gate.</strong> <code>tests/a11y/</code>,
            called out in E2E, and the token and target-size guards are what fail
            a build.
          </Rule>
          <Rule>
            <strong>Contrast needs a theme.</strong> Switch the theme at the top
            right and the tab re-measures: the same text can pass in one palette
            and fail in another.
          </Rule>
          <Rule>
            <strong>States are visible here that a static mount cannot reach.</strong>
            {" "}The Interactions tab forces hover, focus-visible and active, which
            is why those states are reviewable at all.
          </Rule>
          <Rule>
            <strong>Every story declares its level.</strong> <code>error</code>{" "}
            means axe must find nothing and a violation fails the build;{" "}
            <code>todo</code> means a known finding is recorded rather than hidden
            and the story does not fail yet; <code>off</code> means axe must not
            run here at all and the story carries the reason it must not. The
            default is <code>error</code>, so a new story is gated from birth: the
            nine that are not clean carry <code>todo</code> and say why, and the
            count may only fall.
          </Rule>
          <Rule>
            <strong>The gate is a spec, not this tab.</strong>{" "}
            <code>tests/stories/a11yLevels.test.tsx</code> mounts every story, runs
            the shared axe ruleset and fails on any <code>error</code> story. It
            also asserts that axe actually RAN on every story it did not skip,
            because a loop over an empty list is a loop that passes while
            measuring nothing.
          </Rule>
        </ul>
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/definition-of-done",
    group: "documentation",
    surface: "Story Definition of Done",
    state: "documentation",
    description:
      "The nine questions a story answers before it counts as covering a surface.",
    tags: [
      "documentation",
      "definition of done",
      "process",
      "coverage",
      "design system",
    ],
    render: () => (
      <DocPage
        title="Story Definition of Done"
        lede="What a story has to answer before it counts as covering a surface. A mature design system documents components by anatomy rather than by screenshot, and these nine items are that anatomy. They are also the measurable definition of the surfaces still in debt: a surface is covered when a reader can answer all nine here."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>1. Overview.</strong> One sentence saying what the surface is,
            in the user's terms rather than the code's.
          </Rule>
          <Rule>
            <strong>2. When to use it, and when not.</strong> The decision it
            exists to make, so a reader can tell it from its nearest neighbour.
          </Rule>
          <Rule>
            <strong>3. Anatomy.</strong> Its parts, named, when it has more than
            one.
          </Rule>
          <Rule>
            <strong>4. States and variants.</strong> Every state that changes what
            a reader sees is a story of its own. This is the unit the coverage
            roster counts, and the reason "it is on the screen somewhere" is not
            coverage.
          </Rule>
          <Rule>
            <strong>5. Behaviour.</strong> What changes on interaction, and what
            is deliberately instant (a focus ring never animates).
          </Rule>
          <Rule>
            <strong>6. Content guidance.</strong> What the copy says, in sentence
            case, and what it must not say.
          </Rule>
          <Rule>
            <strong>7. Accessibility.</strong> Role and accessible name, the
            keyboard path, and the level this story declares. <code>error</code>{" "}
            (the default), <code>todo</code> or <code>off</code>, from the
            Accessibility page. The gate is{" "}
            <code>tests/stories/a11yLevels.test.tsx</code>.
          </Rule>
          <Rule>
            <strong>8. Tokens and theming.</strong> No literal visual value, so a
            custom theme can repaint the surface without touching its code.
          </Rule>
          <Rule>
            <strong>9. Related surfaces.</strong> What it is often confused with,
            and which of the two to reach for.
          </Rule>
        </ul>
        <p style={LEDE_STYLE}>
          Four of the nine have a machine behind them. Items 1 and 2 are the
          story's <code>description</code> and its tags, held by{" "}
          <code>scripts/check-story-catalogue.mjs</code>, which also refuses an
          empty tag list. Item 4 is the coverage roster's unit, held by{" "}
          <code>scripts/check-story-coverage.mjs</code>, and the smoke check
          requires the story to mount at all. Item 7's level is enforced by{" "}
          <code>tests/stories/a11yLevels.test.tsx</code>. Items 3, 5, 6, 8 and 9
          are review questions: nothing checks a component's anatomy, its
          behaviour or its copy, and naming which five those are is the point of
          writing them down rather than leaving them to taste.
        </p>
      </DocPage>
    ),
  },
  {
    id: "documentation/design-system/staying-true",
    group: "documentation",
    surface: "Keeping This True",
    state: "documentation",
    description:
      "How the design system stays correct without a scheduled audit: a symptom, a guard, and a ratchet.",
    tags: ["documentation", "process", "guards", "audit", "design system"],
    render: () => (
      <DocPage
        title="Keeping This True"
        lede="A design system rots wherever the thing that should catch a defect does not run. The rule here is that an audit follows a symptom rather than a calendar."
      >
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: "none" }}>
          <Rule>
            <strong>Symptom-driven, not calendar-driven.</strong> With one
            maintainer, a scheduled audit competes with the work that produces the
            symptoms and loses. What replaces it is guards that run on every
            change, so a defect is caught where it is introduced rather than
            months later in a sweep.
          </Rule>
          <Rule>
            <strong>Anything a machine can judge is a guard, not a checklist
            item.</strong> A checklist item runs when somebody remembers; a guard
            runs forever. If the question is decidable. Does this token have a
            specimen, does this story have a description, does this reference name
            a token that exists. It belongs in <code>scripts/</code> or{" "}
            <code>tests/</code>.
          </Rule>
          <Rule>
            <strong>What a machine cannot judge stays a review question, and says
            so.</strong> Whether a shadow reads as closer, whether a name reads
            well, whether two surfaces are easily confused: these are judgements.
            They are named on the Definition of Done page so a review asks them
            deliberately instead of hoping somebody notices.
          </Rule>
          <Rule>
            <strong>Guards are ratchets, and the direction is the point.</strong>{" "}
            Recorded debt may shrink and may never grow, and a recorded entry whose
            subject is gone fails as stale. A count that no longer describes the
            tree is the failure the ratchet exists to prevent, not a rounding
            detail.
          </Rule>
          <Rule>
            <strong>A guard that has never failed is a guard nobody has
            tested.</strong> Every one of these is verified by injecting the exact
            defect it claims to catch and watching it name that defect. A guard
            that has stopped checking is green by definition, so "the tree is
            still green" is not evidence.
          </Rule>
          <Rule>
            <strong>The gate and the view are different things.</strong> CI fails
            a build; the catalogue shows facts about the component in front of you.
            The Accessibility tab is a view and says so, and the a11y suites are
            the gate. Neither replaces the other, and a tab that quietly became
            the gate would be a tab nobody reads.
          </Rule>
          <Rule>
            <strong>Prose that describes a check is checked too, where it can
            drift.</strong> The WCAG tag set is one constant both a11y tiers
            import, so the two cannot measure different bars while both look
            green. Where a relationship is only a convention, the prose says so:
            the specimen groups here and{" "}
            <code>scripts/check-foundations-coverage.mjs</code>'s{" "}
            <code>GROUPS</code> agree by hand, the guard does not read this file,
            and the guard's header states that limit rather than claiming a
            coupling nothing enforces.
          </Rule>
        </ul>
      </DocPage>
    ),
  },
];
