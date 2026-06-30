import type { ReactNode } from "react";
import { Screen, ScreenScroll, Icon, MyneMark } from "../../components";
import type { ScreenDef } from "../../gallery/types";

// ── CF-01 helpers ─────────────────────────────────────────────────────────────

/** Slim "‹ Sync" back header used at the top of the conflicts list. */
function BackHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: "none",
        padding: "56px 12px 10px",
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--line-1)",
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
        <svg width="9" height="16" viewBox="0 0 9 16">
          <path
            d="M7 1L1 8l6 7"
            stroke="var(--accent)"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {label}
      </button>
    </div>
  );
}

/** One device's version of the conflicted note, with keep/discard actions. */
function ConflictCard({
  heading,
  summary,
  marginTop,
}: {
  heading: string;
  summary: string;
  marginTop?: number;
}) {
  return (
    <div
      style={{
        marginTop,
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "13px 14px",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{heading}</div>
      <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>{summary}</div>
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button
          style={{
            flex: 1,
            height: 40,
            border: "1px solid var(--line-2)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Keep as separate
        </button>
        <button
          style={{
            flex: "none",
            padding: "0 14px",
            height: 40,
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: "var(--fg-3)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

// ── CF-01 · Conflicts (keep both) ─────────────────────────────────────────────
function ConflictsKeepBoth() {
  return (
    <Screen>
      <BackHeader label="Sync" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <h1
          style={{
            margin: "4px 4px 0",
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "var(--fg-display)",
          }}
        >
          Conflicts
        </h1>
        <p style={{ margin: "8px 4px 0", fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>
          Two devices edited the same note. Keep whichever copies you want.
        </p>
        <div
          style={{
            marginTop: 16,
            padding: "0 4px 8px",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--line-3)",
          }}
        >
          Threat model v2
        </div>
        <ConflictCard
          heading="This device · edited 2m ago"
          summary="…added the relay-compromise section and two bullets."
        />
        <ConflictCard
          heading="Laptop · edited 18m ago"
          summary="…rewrote the adversaries list and removed the quote."
          marginTop={8}
        />
      </ScreenScroll>
    </Screen>
  );
}

// ── CF-02 helpers ─────────────────────────────────────────────────────────────

/** Rounded-square colour dot for a note's label. */
function Dot({ color }: { color: string }) {
  return <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: "none" }} />;
}

/** Small "△ Conflict" pill that sits at the end of a conflicted note row. */
function ConflictBadge() {
  return (
    <span
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 8px",
        borderRadius: 999,
        background: "var(--danger-soft)",
        color: "var(--danger)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12">
        <path d="M6 1.5l4.5 8H1.5z" stroke="var(--danger)" strokeWidth="1.1" fill="none" strokeLinejoin="round" />
      </svg>
      Conflict
    </span>
  );
}

/** A single note row in the list (dot · title · mono meta · optional badge). */
function NoteRow({
  color,
  title,
  meta,
  conflict,
  last,
}: {
  color: string;
  title: string;
  meta: string;
  conflict?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "14px 20px",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Dot color={color} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div
          style={{
            marginTop: 3,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--line-3)",
          }}
        >
          {meta}
        </div>
      </div>
      {conflict && <ConflictBadge />}
    </div>
  );
}

/** Bottom-bar tab. */
function TabItem({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      {icon}
      <span
        style={{
          fontSize: 10,
          fontWeight: active ? 600 : 500,
          color: active ? "var(--accent)" : "var(--fg-3)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── CF-02 · Conflict badge & banner ───────────────────────────────────────────
function ConflictBadgeBanner() {
  return (
    <Screen>
      {/* Header: wordmark + compose */}
      <div style={{ padding: "60px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <MyneMark size={22} radius={4} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Personal</span>
          </div>
          <div style={{ width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="plus" size={20} color="var(--accent)" strokeWidth={2} />
          </div>
        </div>
        <h1
          style={{
            margin: "14px 0 0",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.025em",
            color: "var(--fg-display)",
          }}
        >
          Notes
        </h1>
      </div>

      {/* Conflict banner */}
      <div
        style={{
          margin: "14px 16px 0",
          background: "var(--danger-soft)",
          border: "1px solid color-mix(in srgb, var(--danger) 22%, var(--bg-1))",
          borderRadius: 8,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Icon name="alert-triangle" size={18} color="var(--danger)" strokeWidth={1.5} style={{ flex: "none" }} />
        <div style={{ flex: 1, fontSize: 13, lineHeight: 1.4, color: "var(--danger)" }}>
          2 notes have sync conflicts.
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)" }}>Review</span>
      </div>

      {/* Notes list */}
      <ScreenScroll style={{ marginTop: 12 }}>
        <NoteRow color="var(--label-slate)" title="Threat model v2" meta="2m ago · 3 links" conflict />
        <NoteRow color="var(--label-moss)" title="Weekly review — 06-15" meta="Today · 5 links" />
        <NoteRow color="var(--label-clay)" title="Project Aurora — kickoff" meta="Mon · 8 links" conflict last />
      </ScreenScroll>

      {/* Bottom bar */}
      <div
        style={{
          flex: "none",
          display: "flex",
          borderTop: "1px solid var(--line-1)",
          background: "var(--bg-1)",
          padding: "8px 0 30px",
        }}
      >
        <TabItem
          active
          label="Notes"
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="var(--accent)" strokeWidth="1.8" />
              <path d="M9 8h6M9 12h6M9 16h3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          }
        />
        <TabItem label="Search" icon={<Icon name="search" size={24} color="var(--fg-3)" strokeWidth={1.8} />} />
        <TabItem
          label="Graph"
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <circle cx="6" cy="17" r="2.6" stroke="var(--fg-3)" strokeWidth="1.8" />
              <circle cx="18" cy="14" r="2.6" stroke="var(--fg-3)" strokeWidth="1.8" />
              <circle cx="13" cy="6" r="2.6" stroke="var(--fg-3)" strokeWidth="1.8" />
              <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke="var(--fg-3)" strokeWidth="1.6" />
            </svg>
          }
        />
        <TabItem
          label="Settings"
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M4 7h11M19 7h1M4 17h1M9 17h11" stroke="var(--fg-3)" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="17" cy="7" r="2.4" stroke="var(--fg-3)" strokeWidth="1.8" />
              <circle cx="7" cy="17" r="2.4" stroke="var(--fg-3)" strokeWidth="1.8" />
            </svg>
          }
        />
      </div>
    </Screen>
  );
}

export const conflictScreens: ScreenDef[] = [
  { id: "CF-01", label: "Conflicts (keep both)", Component: ConflictsKeepBoth },
  { id: "CF-02", label: "Conflict badge & banner", Component: ConflictBadgeBanner },
];
