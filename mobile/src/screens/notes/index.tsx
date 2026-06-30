import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Icon, MyneMark } from "../../components";
import type { ScreenDef } from "../../gallery/types";

// Shared bits ─────────────────────────────────────────────────────────────────

/** Small rounded label square (8×8). `outline` draws the empty/ungrouped state. */
function LabelSquare({ color, outline }: { color?: string; outline?: boolean }) {
  return (
    <span
      style={{
        flex: "none",
        width: 8,
        height: 8,
        borderRadius: 2,
        background: outline ? "transparent" : color,
        border: outline ? "1px solid var(--line-2)" : undefined,
      }}
    />
  );
}

/** Monospace meta line (e.g. "2m ago · 3 links"). */
function Meta({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--line-3)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The shared "Personal ▾" + search/compose top bar used on the Notes home. */
function VaultBar() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <button
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <MyneMark size={22} radius={4} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Personal</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 4l4 4 4-4"
            stroke="var(--fg-3)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="search" size={20} color="var(--fg-2)" strokeWidth={1.7} />
        </div>
        <div style={{ width: 38, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="plus" size={20} color="var(--accent)" strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}

/** The bottom tab bar (Notes / Search / Graph / Settings). */
function TabBar() {
  const inactive = "var(--fg-3)";
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "8px 0 30px",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="var(--accent)" strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)" }}>Notes</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke={inactive} strokeWidth="1.8" />
          <path d="M16 16l4 4" stroke={inactive} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Search</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={inactive} strokeWidth="1.6" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Graph</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M4 7h11M19 7h1M4 17h1M9 17h11" stroke={inactive} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="17" cy="7" r="2.4" stroke={inactive} strokeWidth="1.8" />
          <circle cx="7" cy="17" r="2.4" stroke={inactive} strokeWidth="1.8" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Settings</span>
      </div>
    </div>
  );
}

// 05 · Notes — option A (chronological) ───────────────────────────────────────

/** A full chronological note row: optional colour square, title, snippet, meta. */
function ChronoRow({
  square,
  title,
  snippet,
  meta,
  last,
}: {
  square?: string;
  title: string;
  snippet: string;
  meta: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "14px 20px",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {square && <LabelSquare color={square} />}
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 14,
          color: "var(--fg-3)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {snippet}
      </div>
      <Meta style={{ display: "block", marginTop: 6 }}>{meta}</Meta>
    </div>
  );
}

function NotesChronological() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "60px 20px 0" }}>
        <VaultBar />
        <h1 style={{ margin: "14px 0 0", fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
          Notes
        </h1>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Synced · 2m ago · 48 notes</span>
        </div>
      </div>
      <ScreenScroll style={{ marginTop: 14 }}>
        <ChronoRow
          square="var(--label-slate)"
          title="Threat model v2"
          snippet="We assume a powerful network adversary that can observe all traffic and…"
          meta="2m ago · 3 links"
        />
        <ChronoRow
          square="var(--label-moss)"
          title="Weekly review — 2026-06-15"
          snippet="Shipped the sync conflict resolver. Next: mobile share sheet and…"
          meta="Today · 5 links"
        />
        <ChronoRow
          title="Reading — Seeing Like a State"
          snippet="Legibility as the central drive of the modern state. Chapter 1 notes…"
          meta="Yesterday · 1 link"
        />
        <ChronoRow
          square="var(--label-clay)"
          title="Project Aurora — kickoff"
          snippet="Scope, owners, and the first three milestones. Linked from Roadmap…"
          meta="Mon · 8 links"
        />
        <ChronoRow
          title="Sourdough — working notes"
          snippet="75% hydration, 20% starter. Overnight bulk at 18°C gave the best…"
          meta="Jun 11 · 0 links"
        />
        <ChronoRow
          title="Key rotation"
          snippet="Device keys rotate on re-pair. The vault key never leaves the…"
          meta="Jun 9 · 4 links"
          last
        />
      </ScreenScroll>
      <TabBar />
    </Screen>
  );
}

// 06 · Notes — option B (pinned + grouped) ────────────────────────────────────

/** Uppercase tracked group label ("PINNED", "TODAY", "EARLIER"). */
function GroupLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--line-3)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A pinned card (boxed, with title + meta). */
function PinnedCard({ square, title, meta }: { square: string; title: string; meta: string }) {
  return (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-2)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <LabelSquare color={square} />
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      </div>
      <Meta style={{ display: "block", marginTop: 4 }}>{meta}</Meta>
    </div>
  );
}

/** A compact grouped row: square + title (flex) + trailing link-count. */
function GroupedRow({
  square,
  outline,
  title,
  meta,
  last,
}: {
  square?: string;
  outline?: boolean;
  title: string;
  meta: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "13px 20px",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <LabelSquare color={square} outline={outline} />
      <div style={{ flex: 1, fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      <Meta>{meta}</Meta>
    </div>
  );
}

function NotesGrouped() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "60px 20px 0" }}>
        <VaultBar />
        <h1 style={{ margin: "14px 0 0", fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
          Notes
        </h1>
        <div style={{ marginTop: 12, display: "flex", gap: 7 }}>
          <div style={{ padding: "6px 12px", borderRadius: 999, background: "var(--fg-1)", color: "var(--bg-1)", fontSize: 13, fontWeight: 500 }}>
            All
          </div>
          {["Work", "Reading", "Specs"].map((label) => (
            <div
              key={label}
              style={{ padding: "6px 12px", borderRadius: 999, border: "1px solid var(--line-2)", color: "var(--fg-2)", fontSize: 13, fontWeight: 500 }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
      <ScreenScroll style={{ marginTop: 16 }}>
        <GroupLabel style={{ padding: "0 20px" }}>Pinned</GroupLabel>
        <div style={{ marginTop: 8, padding: "0 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <PinnedCard square="var(--label-slate)" title="Threat model v2" meta="2m ago · 3 links" />
          <PinnedCard square="var(--label-clay)" title="Project Aurora — kickoff" meta="Mon · 8 links" />
        </div>
        <GroupLabel style={{ marginTop: 20, padding: "0 20px 8px" }}>Today</GroupLabel>
        <GroupedRow square="var(--label-moss)" title="Weekly review — 06-15" meta="5 links" />
        <GroupedRow square="var(--label-ochre)" title="Inbox — quick capture" meta="0 links" />
        <GroupLabel style={{ marginTop: 18, padding: "0 20px 8px" }}>Earlier</GroupLabel>
        <GroupedRow outline title="Seeing Like a State" meta="1 link" />
        <GroupedRow outline title="Key rotation" meta="4 links" last />
      </ScreenScroll>
      <TabBar />
    </Screen>
  );
}

// 07 · Reading view + backlinks ───────────────────────────────────────────────

/** A [[wiki-link]] inline span; `underline` is the in-body affordance. */
function WikiLink({ children, underline }: { children: ReactNode; underline?: boolean }) {
  return (
    <span
      style={{
        color: "var(--accent)",
        borderBottom: underline ? "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" : undefined,
      }}
    >
      {children}
    </span>
  );
}

/** A linked-reference card in the backlinks section. */
function ReferenceCard({ title, children, style }: { title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 8, padding: "12px 14px", ...style }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>{children}</div>
    </div>
  );
}

function ReadingView() {
  return (
    <Screen>
      <div
        style={{
          flex: "none",
          padding: "56px 16px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)",
        }}
      >
        <button
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 15,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <svg width="9" height="16" viewBox="0 0 9 16" fill="none">
            <path d="M7 1L1 8l6 7" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Notes
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <svg width="20" height="6" viewBox="0 0 22 6">
            <circle cx="3" cy="3" r="2.5" fill="var(--fg-2)" />
            <circle cx="11" cy="3" r="2.5" fill="var(--fg-2)" />
            <circle cx="19" cy="3" r="2.5" fill="var(--fg-2)" />
          </svg>
          <button style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
            Edit
          </button>
        </div>
      </div>
      <ScreenScroll style={{ padding: "22px 24px 40px" }}>
        <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.2, letterSpacing: "-0.02em", fontWeight: 600, color: "var(--fg-display)" }}>
          Threat model v2
        </h1>
        <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--line-3)" }}>
          edited 2m ago · 412 words
        </div>
        <h2 style={{ margin: "26px 0 0", fontSize: 20, fontWeight: 600, color: "var(--fg-1)" }}>Adversaries</h2>
        <p style={{ margin: "10px 0 0", fontSize: 16, lineHeight: 1.65, color: "var(--fg-1)" }}>
          We assume a powerful network adversary that can observe all traffic and compromise the relay. The vault key is
          derived from the passphrase and{" "}
          <span style={{ background: "var(--warning-soft)", padding: "0 2px", borderRadius: 2 }}>never leaves the device</span>.
        </p>
        <p style={{ margin: "14px 0 0", fontSize: 16, lineHeight: 1.65, color: "var(--fg-1)" }}>
          Ciphertext is opaque to the server: see <WikiLink underline>[[Key rotation]]</WikiLink> for how device keys are
          re-derived on re-pair.
        </p>
        <ul style={{ margin: "14px 0 0", paddingLeft: 20, fontSize: 16, lineHeight: 1.7, color: "var(--fg-1)" }}>
          <li>Network observer — sees timing + size only</li>
          <li>
            Malicious relay — stores{" "}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
                borderRadius: 3,
                padding: "0 5px",
              }}
            >
              ciphertext
            </span>
          </li>
          <li>Lost device — protected by passphrase</li>
        </ul>
        <blockquote
          style={{
            margin: "18px 0 0",
            paddingLeft: 14,
            borderLeft: "2px solid var(--line-2)",
            color: "var(--fg-2)",
            fontSize: 16,
            lineHeight: 1.6,
          }}
        >
          A note the server can read is a note someone else can read.
        </blockquote>
        <div style={{ marginTop: 30, borderTop: "1px solid var(--line-1)", paddingTop: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--line-3)" }}>
            Linked references · 2
          </div>
          <ReferenceCard title="Key rotation" style={{ marginTop: 12 }}>
            …the device key never leaves the secure enclave. See <WikiLink>[[Threat model v2]]</WikiLink> for the adversary set.
          </ReferenceCard>
          <ReferenceCard title="Project Aurora — kickoff" style={{ marginTop: 8 }}>
            Security review blocked on <WikiLink>[[Threat model v2]]</WikiLink> sign-off.
          </ReferenceCard>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

export const notesScreens: ScreenDef[] = [
  { id: "05", label: "Notes — option A (chronological)", Component: NotesChronological },
  { id: "06", label: "Notes — option B (pinned + grouped)", Component: NotesGrouped },
  { id: "07", label: "Reading view + backlinks", Component: ReadingView },
];
