// The Welcome page: the catalogue's own front door (myne-md/myne#845).
//
// A rail that opens straight into `Button · Variants` answers "what is here" but
// not "what is this", and links nowhere. This is the one entry that explains the
// workbench, shows the banner, and points at everything a reader would otherwise
// have to go and find.

import type { CSSProperties, ReactNode } from "react";
import { MyneMark } from "@app/components/primitives/MyneMark";
import { Icon } from "@app/components/primitives/Icon";
import type { IconName } from "@app/lib/icons";
import type { StoryDescriptor } from "../types";
import bannerUrl from "../assets/design-system-banner.png";

const PAGE_STYLE: CSSProperties = {
  maxWidth: "var(--content-max-w)",
  padding: "var(--space-6)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
};

const BANNER_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  height: "auto",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  marginBlockEnd: "var(--space-5)",
};

const HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  marginBlockEnd: "var(--space-4)",
};

const TITLE_STYLE: CSSProperties = {
  margin: "0 0 var(--space-2)",
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)",
};

const BODY_STYLE: CSSProperties = {
  margin: "0 0 var(--space-3)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-relaxed)",
  color: "var(--fg-2)",
};

const SECTION_STYLE: CSSProperties = {
  margin: "var(--space-6) 0 var(--space-2)",
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  margin: "0 0 var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const LINK_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "var(--space-2) var(--space-5)",
};

const LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  color: "var(--accent)",
  textDecoration: "none",
  fontSize: "var(--text-sm)",
};

/** One "how to use" line: a glyph, a bold lead, and the explanation. */
function Point({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div style={ROW_STYLE}>
      <Icon name={icon} size={15} />
      <span>
        <strong style={{ color: "var(--fg-1)" }}>{label}</strong> {children}
      </span>
    </div>
  );
}

/** One outbound link, opening in a new tab. */
function Out({ href, icon, children }: { href: string; icon: IconName; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={LINK_STYLE}
      data-testid="stories.outbound"
    >
      <Icon name={icon} size={13} />
      {children}
    </a>
  );
}

/** The real destinations this project lives in. Kept in one place. */
type LinkGroup = {
  group: string;
  items: readonly { href: string; icon: IconName; label: string }[];
};

const LINKS: readonly LinkGroup[] = [
  {
    group: "Product",
    items: [
      { href: "https://myne.md", icon: "globe", label: "myne.md" },
      { href: "https://myne.md/download", icon: "download", label: "Download" },
      { href: "https://app.myne.md", icon: "cloud-off", label: "Web client" },
      { href: "https://myne.md/spec", icon: "file-text", label: "Specification" },
      { href: "https://myne.md/security", icon: "lock", label: "Security" },
      { href: "https://myne.md/roadmap", icon: "calendar", label: "Roadmap" },
      { href: "https://status.myne.md", icon: "circle-check", label: "Service status" },
    ],
  },
  {
    group: "Theme",
    items: [
      { href: "https://myne.md/themes/", icon: "palette", label: "Theme gallery" },
      { href: "https://myne.md/themes/builder", icon: "spell-check", label: "Theme builder" },
    ],
  },
  // Omitted from the public variant (`STORIES_PUBLIC=1`, served at
  // design.myne.md). Every `myne-md` repository is private, so each of these
  // hrefs is a 404 to a reader who is not a member, and this is the landing page
  // — the first screen anybody sees (`App.tsx`'s `WelcomePage`). Guarded as CODE
  // rather than hidden at runtime so the URLs do not reach the artefact at all;
  // `check-stories-public-bundle.mjs` holds that.
  ...(__STORIES_PUBLIC__
    ? []
    : ([
        {
          group: "Source",
          items: [
            { href: "https://github.com/myne-md/myne", icon: "code", label: "myne" },
            { href: "https://github.com/myne-md/myne-server", icon: "globe", label: "myne-server" },
            { href: "https://github.com/myne-md/myne-website", icon: "globe", label: "myne-website" },
            { href: "https://github.com/myne-md/myne-themes", icon: "palette", label: "myne-themes" },
            { href: "https://github.com/myne-md/myne-branding", icon: "image", label: "myne-branding" },
            { href: "https://github.com/myne-md/myne-test-vectors", icon: "circle-check", label: "myne-test-vectors" },
            { href: "https://github.com/myne-md/myne-ops", icon: "settings", label: "myne-ops" },
            { href: "https://github.com/myne-md/myne-clipper", icon: "paperclip", label: "myne-clipper" },
          ],
        },
      ] satisfies LinkGroup[])),
];

function WelcomePage(): ReactNode {
  return (
    <div style={PAGE_STYLE}>
      <img src={bannerUrl} alt="Myne Design System" style={BANNER_STYLE} data-testid="stories.banner" />

      <div style={HEAD_STYLE}>
        <MyneMark size={28} />
        <span style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)" }}>Myne</span>
        <span
          style={{
            color: "var(--fg-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
          }}
        >
          Design System
        </span>
      </div>

      <h1 style={TITLE_STYLE}>Myne Design System</h1>
      <p style={BODY_STYLE}>
        Every component, screen and state of Myne, mounted from the real{" "}
        <code>src/</code> tree against a fake host. Nothing here is a mock of the
        interface: the stories render the components the app ships, so a token or a
        variant change is visible the moment it lands. The same catalogue is the
        coverage roster, so a surface with no story is a surface nobody has
        reviewed.
      </p>

      <h2 style={SECTION_STYLE}>How to use this</h2>
      <Point icon="list" label="Pick a surface">
        from the rail on the left. One row per component or screen; the arrow keys
        move the selection, and the Documentation and Foundations sections at the
        top explain the system before the list starts.
      </Point>
      <Point icon="search" label="Search by intent">
        with the box in the navbar. It matches names, states, descriptions and
        tags, so "sync error" finds a story whose id says nothing about it.
      </Point>
      <Point icon="panel-left" label="Switch state">
        in the Controls tab, so a surface's variants sit in one place instead of
        crowding the rail.
      </Point>
      <Point icon="layout-grid" label="Read the facts">
        in the Accessibility tab: roles, keyboard order, target sizes and
        contrast, measured against the theme you have selected. The test suites
        remain the gate; this tab is how you find something they should catch.
      </Point>
      <Point icon="spell-check" label="Force a state">
        in the Interactions tab: hover, focus-visible and active, which a static
        mount cannot otherwise reach.
      </Point>
      <Point icon="sun" label="Change theme">
        with the switcher at the top right: light, dark or amoled. The
        Accessibility tab re-measures each time.
      </Point>
      <Point icon="code" label="Jump to source">
        with "Show on GitHub" under the story id, pinned to the branch this build
        came from.
      </Point>

      <h2 style={SECTION_STYLE}>What is covered</h2>
      <p style={BODY_STYLE}>
        Components, screens, settings panels and the foundations: the token layer,
        the icons, type, spacing, radii, shadows, motion and control metrics, each
        generated from the file that ships it rather than copied. The coverage
        guard lists what is still missing, and that list may only shrink.
      </p>

      <h2 style={SECTION_STYLE}>Where things live</h2>
      <p style={BODY_STYLE}>
        The catalogue is one surface of a larger project. These are the real
        destinations, so a reader does not have to go looking.
      </p>
      {LINKS.map((group) => (
        <div key={group.group} style={{ marginBlockEnd: "var(--space-4)" }}>
          <div
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "var(--tracking-caps)",
              textTransform: "uppercase",
              color: "var(--fg-3)",
              marginBlockEnd: "var(--space-2)",
            }}
          >
            {group.group}
          </div>
          <div style={LINK_GRID_STYLE}>
            {group.items.map((item) => (
              <Out key={item.href} href={item.href} icon={item.icon}>
                {item.label}
              </Out>
            ))}
          </div>
        </div>
      ))}

      <h2 style={SECTION_STYLE}>This page's own banner</h2>
      <p style={BODY_STYLE}>
        The banner above is rendered, not drawn, by the same script that renders
        the organisation banner:{" "}
        <code>node social-press/render-org-banner.mjs --variant=design-system</code>{" "}
        in <code>myne-branding</code>. One layout, two sets of copy, so this
        banner and the profile banner cannot drift apart. The PNG here is an
        exported copy, refreshed at a brand event the way{" "}
        <code>myne-branding/EXPORTING.md</code> describes.
      </p>
    </div>
  );
}

export const WELCOME_STORIES: StoryDescriptor[] = [
  {
    id: "documentation/welcome/introduction",
    group: "documentation",
    // Distinct from the app's `Welcome` screen, which the guard already knows;
    // the `title` is what the rail shows, so it still reads as "Welcome".
    surface: "Overview",
    title: "Welcome",
    state: "introduction",
    description: "What this workbench is, how to use it, and where the project lives.",
    tags: ["documentation", "welcome", "readme", "links", "introduction", "start"],
    render: () => <WelcomePage />,
  },
];
