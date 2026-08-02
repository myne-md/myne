import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, FooterBar, Button, Sheet } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Organize-notes section (prefix NO). Light variant only — dark + amoled track
 * automatically via CSS tokens. UI-only: every control is inert.
 */

// ── Shared fragments ─────────────────────────────────────────────────────────

/** Top navigation bar (56px status inset + hairline). */
function NavBar({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        flex: "none",
        padding: "56px 12px 10px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid var(--line-1)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Accent back button: thin chevron + label. */
function BackBtn({ label = "Notes" }: { label?: string }) {
  return (
    <button
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        border: "none",
        background: "transparent",
        color: "var(--accent)",
        fontFamily: "var(--font-sans)",
        fontSize: 15,
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      <svg width="9" height="16" viewBox="0 0 9 16" fill="none">
        <path d="M7 1L1 8l6 7" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

/** Plain text nav action (right-hand side / modal headers). */
function NavBtn({
  children,
  color = "var(--accent)",
  weight = 600,
  size = 15,
}: {
  children: ReactNode;
  color?: string;
  weight?: number;
  size?: number;
}) {
  return (
    <button
      style={{
        border: "none",
        background: "transparent",
        color,
        fontFamily: "var(--font-sans)",
        fontSize: size,
        fontWeight: weight,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** Centred modal title. */
function NavTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 15, fontWeight: 600 }}>{children}</div>;
}

/** Large page H1 (26 / 700 / -0.02em). */
function PageTitle({ children, margin = "4px 4px 0" }: { children: ReactNode; margin?: string }) {
  return (
    <h1 style={{ margin, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
      {children}
    </h1>
  );
}

/** Tracked uppercase section label. */
function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
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

/** iOS-style pill segmented toggle (white active pill, not accent-filled). */
function PillToggle({
  options,
  active = 0,
  pad = "6px 14px",
  fontSize = 13,
}: {
  options: string[];
  active?: number;
  pad?: string;
  fontSize?: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: 8,
        padding: 3,
      }}
    >
      {options.map((o, i) => (
        <div
          key={o}
          style={{
            padding: pad,
            borderRadius: 6,
            fontSize,
            fontWeight: i === active ? 600 : 400,
            background: i === active ? "var(--bg-1)" : "transparent",
            border: i === active ? "1px solid var(--line-1)" : "1px solid transparent",
            color: i === active ? "var(--fg-1)" : "var(--fg-2)",
          }}
        >
          {o}
        </div>
      ))}
    </div>
  );
}

const outlineBtnStyle: CSSProperties = {
  height: 34,
  padding: "0 12px",
  border: "1px solid var(--line-2)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const dangerTextBtnStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--danger)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

// ── NO-01 · Folders ──────────────────────────────────────────────────────────

function FolderParent({ dir, dot, name, count }: { dir: "right" | "down"; dot: string; name: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 8px" }}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path
          d={dir === "down" ? "M2 3l4 4 4-4" : "M3 2l4 4-4 4"}
          stroke="var(--fg-3)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: dot }} />
      <span style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>{name}</span>
      <span style={{ fontSize: 13, color: "var(--line-3)" }}>{count}</span>
    </div>
  );
}

function FolderChild({ dot, name, count }: { dot: string; name: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 8px 11px 28px",
        borderInlineStart: "1px solid var(--line-1)",
        marginInlineStart: 13,
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: 2, background: dot }} />
      <span style={{ flex: 1, fontSize: 15 }}>{name}</span>
      <span style={{ fontSize: 13, color: "var(--line-3)" }}>{count}</span>
    </div>
  );
}

function Folders() {
  return (
    <Screen>
      <NavBar>
        <BackBtn />
        <NavBtn>New</NavBtn>
      </NavBar>
      <ScreenScroll style={{ padding: "14px 12px 20px" }}>
        <PageTitle margin="4px 8px 0">Folders</PageTitle>
        <div style={{ marginTop: 14 }}>
          <FolderParent dir="right" dot="var(--label-moss)" name="Work" count={12} />
          <FolderParent dir="down" dot="var(--label-slate)" name="Reading" count={8} />
          <FolderChild dot="var(--label-ochre)" name="Books" count={5} />
          <FolderChild dot="var(--label-plum)" name="Papers" count={3} />
          <FolderParent dir="right" dot="var(--label-clay)" name="Specs" count={6} />
        </div>
      </ScreenScroll>
      <FooterBar style={{ padding: "12px 16px 40px" }}>
        <Button variant="secondary" full={false} style={{ flex: 1, height: 46, fontSize: 14, color: "var(--fg-1)" }}>
          New folder
        </Button>
        <Button full={false} style={{ flex: 1, height: 46, fontSize: 14 }}>
          New note
        </Button>
      </FooterBar>
    </Screen>
  );
}

// ── NO-02 · Tag browser ──────────────────────────────────────────────────────

function TagPill({ label, count, selected = false }: { label: string; count: number; selected?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 12px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 500,
        background: selected ? "var(--accent)" : "transparent",
        border: selected ? "none" : "1px solid var(--line-2)",
        color: selected ? "var(--accent-on)" : "var(--fg-2)",
      }}
    >
      {label}
      <span style={{ opacity: selected ? 0.7 : 1, color: selected ? undefined : "var(--line-3)" }}>{count}</span>
    </span>
  );
}

function TagNoteRow({ title, tags, last }: { title: string; tags: string; last?: boolean }) {
  return (
    <div
      style={{
        padding: "13px 4px",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      <div style={{ marginTop: 3, fontSize: 13, color: "var(--fg-3)" }}>{tags}</div>
    </div>
  );
}

function TagBrowser() {
  return (
    <Screen>
      <NavBar>
        <BackBtn />
        <NavBtn size={14}>Save as view</NavBtn>
      </NavBar>
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Tags</PageTitle>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <PillToggle options={["AND", "OR"]} active={0} />
          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>2 selected</span>
        </div>
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
          <TagPill label="#security" count={14} selected />
          <TagPill label="#spec" count={6} selected />
          <TagPill label="#reading" count={8} />
          <TagPill label="#idea" count={21} />
          <TagPill label="#daily" count={31} />
        </div>
        <SectionLabel style={{ marginTop: 18, padding: "0 4px 4px" }}>3 notes</SectionLabel>
        <TagNoteRow title="Threat model v2" tags="#security #spec" />
        <TagNoteRow title="Key rotation" tags="#security #spec" />
        <TagNoteRow title="Sync protocol notes" tags="#security #spec" last />
      </ScreenScroll>
    </Screen>
  );
}

// ── NO-03 · Saved views ──────────────────────────────────────────────────────

function ViewCard({ wash, icon, title, count }: { wash: string; icon: ReactNode; title: string; count: string }) {
  return (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
      <div style={{ height: 84, background: wash, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {icon}
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--line-3)" }}>{count}</div>
      </div>
    </div>
  );
}

function SavedViews() {
  return (
    <Screen>
      <NavBar>
        <BackBtn />
      </NavBar>
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Views</PageTitle>
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <ViewCard
            wash="var(--accent-soft)"
            title="Security work"
            count="14 notes"
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <rect x="4" y="4" width="16" height="16" rx="2" stroke="var(--accent)" strokeWidth="1.6" />
                <path d="M4 14l4-4 3 3 3-3 6 6" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            }
          />
          <ViewCard
            wash="color-mix(in srgb, var(--success) 12%, transparent)"
            title="Reading list"
            count="8 notes"
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 4h11l3 3v13H5z" stroke="var(--success)" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            }
          />
          <ViewCard
            wash="color-mix(in srgb, var(--label-clay) 12%, transparent)"
            title="This week"
            count="5 notes"
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8" stroke="var(--label-clay)" strokeWidth="1.6" />
              </svg>
            }
          />
          <div
            style={{
              border: "1px dashed var(--line-2)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 124,
              color: "var(--fg-3)",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <svg width="22" height="22" viewBox="0 0 20 20" fill="none">
                <path d="M10 4v12M4 10h12" stroke="var(--fg-3)" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600 }}>New view</div>
            </div>
          </div>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── NO-04 · Filter builder ───────────────────────────────────────────────────

function FilterBuilder() {
  return (
    <Screen>
      <NavBar>
        <NavBtn color="var(--fg-3)" weight={500}>
          Cancel
        </NavBtn>
        <NavTitle>Filter</NavTitle>
        <NavBtn>Done</NavBtn>
      </NavBar>
      <ScreenScroll style={{ padding: "16px 16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--fg-2)" }}>
          <span>Match</span>
          <PillToggle options={["all", "any"]} active={0} pad="5px 12px" />
          <span>of</span>
        </div>
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              border: "1px solid var(--line-1)",
              borderRadius: 10,
              background: "var(--bg-1)",
              padding: "12px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 14, color: "var(--fg-3)" }}>Tag</span>
            <span style={{ fontSize: 14, padding: "4px 10px", border: "1px solid var(--line-2)", borderRadius: 6 }}>
              is
            </span>
            <span
              style={{ fontSize: 14, padding: "4px 10px", borderRadius: 6, background: "var(--accent)", color: "var(--accent-on)" }}
            >
              #security
            </span>
          </div>
          <div
            style={{
              border: "1px solid var(--line-1)",
              borderRadius: 10,
              background: "var(--bg-1)",
              padding: "12px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 14, color: "var(--fg-3)" }}>Folder</span>
            <span style={{ fontSize: 14, padding: "4px 10px", border: "1px solid var(--line-2)", borderRadius: 6 }}>
              is not
            </span>
            <span
              style={{ fontSize: 14, padding: "4px 10px", borderRadius: 6, background: "var(--bg-2)", border: "1px solid var(--line-1)" }}
            >
              Archive
            </span>
          </div>
          <button
            style={{
              height: 44,
              border: "1px dashed var(--line-2)",
              borderRadius: 10,
              background: "transparent",
              color: "var(--accent)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Add condition
          </button>
        </div>
        <div
          style={{
            marginTop: 16,
            background: "var(--warning-soft)",
            border: "1px solid color-mix(in srgb, var(--warning) 22%, transparent)",
            borderRadius: 8,
            padding: "11px 13px",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--warning)",
          }}
        >
          Some matching notes use rules this view can't show on mobile. They're still counted.
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── NO-05 · View settings ────────────────────────────────────────────────────

function ViewSettings() {
  return (
    <Screen>
      <NavBar>
        <NavBtn color="var(--fg-3)" weight={500}>
          Cancel
        </NavBtn>
        <NavTitle>View settings</NavTitle>
        <NavBtn>Save</NavBtn>
      </NavBar>
      <ScreenScroll style={{ padding: "16px 16px 20px" }}>
        <SectionLabel style={{ padding: "0 4px 8px" }}>Cover image</SectionLabel>
        <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
          <div style={{ padding: "13px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 16 }}>Cover property</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>First image</span>
          </div>
          <div
            style={{
              padding: "13px 14px",
              borderTop: "1px solid var(--line-1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 16 }}>Aspect ratio</span>
            <PillToggle options={["16:9", "1:1"]} active={0} pad="5px 10px" fontSize={12} />
          </div>
        </div>
        <SectionLabel style={{ marginTop: 18, padding: "0 4px 8px" }}>Card size</SectionLabel>
        <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)", padding: "16px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "var(--fg-3)" }}>S</span>
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--line-1)", position: "relative" }}>
              <div
                style={{ position: "absolute", insetInlineStart: 0, top: 0, bottom: 0, width: "60%", background: "var(--accent)", borderRadius: 999 }}
              />
              <div
                style={{
                  position: "absolute",
                  left: "60%",
                  top: "50%",
                  transform: "translate(-50%,-50%)",
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "var(--bg-1)",
                  border: "1px solid var(--line-2)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                }}
              />
            </div>
            <span style={{ fontSize: 13, color: "var(--fg-3)" }}>L</span>
          </div>
          <button
            style={{
              marginTop: 14,
              border: "none",
              background: "transparent",
              color: "var(--accent)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
            }}
          >
            Reset to default
          </button>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── NO-06 · Trash ────────────────────────────────────────────────────────────

function ManageRow({
  title,
  sub,
  pad = "13px 4px",
  last,
  children,
}: {
  title: string;
  sub: string;
  pad?: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: pad,
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--line-3)" }}>{sub}</div>
      </div>
      {children}
    </div>
  );
}

function Trash() {
  return (
    <Screen>
      <NavBar>
        <BackBtn />
        <NavBtn color="var(--danger)" size={14}>
          Empty trash
        </NavBtn>
      </NavBar>
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Trash</PageTitle>
        <p style={{ margin: "6px 4px 0", fontSize: 13, color: "var(--fg-3)" }}>
          3 notes · deleted notes are removed for good after 30 days.
        </p>
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column" }}>
          <ManageRow title="Old draft — pitch" sub="deleted Jun 18">
            <button style={outlineBtnStyle}>Restore</button>
            <button style={dangerTextBtnStyle}>Delete</button>
          </ManageRow>
          <ManageRow title="Scratch" sub="deleted Jun 16">
            <button style={outlineBtnStyle}>Restore</button>
            <button style={dangerTextBtnStyle}>Delete</button>
          </ManageRow>
          <ManageRow title="Meeting — cancelled" sub="deleted Jun 12" last>
            <button style={outlineBtnStyle}>Restore</button>
            <button style={dangerTextBtnStyle}>Delete</button>
          </ManageRow>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── NO-07 · Archive ──────────────────────────────────────────────────────────

function Archive() {
  return (
    <Screen>
      <NavBar style={{ justifyContent: "flex-start" }}>
        <BackBtn />
      </NavBar>
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Archive</PageTitle>
        <p style={{ margin: "6px 4px 0", fontSize: 13, color: "var(--fg-3)" }}>
          Hidden from your main list, kept and searchable.
        </p>
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column" }}>
          <ManageRow title="2025 retro" sub="archived Jan 4" pad="14px 4px">
            <button style={outlineBtnStyle}>Unarchive</button>
          </ManageRow>
          <ManageRow title="Old onboarding flow" sub="archived Dec 2" pad="14px 4px">
            <button style={outlineBtnStyle}>Unarchive</button>
          </ManageRow>
          <ManageRow title="Trip — Lisbon" sub="archived Nov 18" pad="14px 4px" last>
            <button style={outlineBtnStyle}>Unarchive</button>
          </ManageRow>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── NO-08 · Multi-select ─────────────────────────────────────────────────────

function SelectRow({ title, selected }: { title: string; selected?: boolean }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderBottom: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      {selected ? (
        <span
          style={{
            flex: "none",
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M2 7.5l3 3 7-7.5" stroke="var(--accent-on)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : (
        <span style={{ flex: "none", width: 22, height: 22, borderRadius: "50%", border: "1.5px solid var(--line-2)" }} />
      )}
      <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>{title}</div>
    </div>
  );
}

function BulkAction({ icon, label, danger }: { icon: ReactNode; label: string; danger?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        color: danger ? "var(--danger)" : "var(--accent)",
      }}
    >
      {icon}
      <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function MultiSelect() {
  return (
    <Screen>
      <NavBar style={{ padding: "56px 16px 12px" }}>
        <NavBtn>Done</NavBtn>
        <NavTitle>2 selected</NavTitle>
        <NavBtn weight={500}>Select all</NavBtn>
      </NavBar>
      <ScreenScroll>
        <SelectRow title="Threat model v2" selected />
        <SelectRow title="Key rotation" selected />
        <SelectRow title="Weekly review — 06-15" />
        <SelectRow title="Project Aurora — kickoff" />
      </ScreenScroll>
      <FooterBar style={{ padding: "12px 0 34px", background: "var(--bg-2)", justifyContent: "space-around" }}>
        <BulkAction
          label="Move"
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M3 7h7l2 2h7v9H3z" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          }
        />
        <BulkAction
          label="Archive"
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M4 7h14v11H4z" stroke="var(--accent)" strokeWidth="1.6" />
              <path d="M3 4h16v3H3z" stroke="var(--accent)" strokeWidth="1.6" />
            </svg>
          }
        />
        <BulkAction
          label="Delete"
          danger
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M4 6h14M9 6V4h4v2M6 6l1 12h8l1-12" stroke="var(--danger)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
      </FooterBar>
    </Screen>
  );
}

// ── NO-09 · Note context sheet ───────────────────────────────────────────────

function SheetItem({ icon, label, danger }: { icon: ReactNode; label: string; danger?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 12px" }}>
      {icon}
      <span style={{ fontSize: 16, color: danger ? "var(--danger)" : "var(--fg-1)" }}>{label}</span>
    </div>
  );
}

function NoteContextSheet() {
  return (
    <Screen>
      <div style={{ flex: 1, opacity: 0.4, padding: "60px 16px 0" }}>
        <h1 style={{ margin: "8px 4px", fontSize: 30, fontWeight: 700, color: "var(--fg-display)" }}>Notes</h1>
      </div>
      <Sheet style={{ borderRadius: "16px 16px 0 0", padding: "10px 12px 34px" }}>
        <div style={{ padding: "6px 12px 14px", borderBottom: "1px solid var(--line-1)" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Threat model v2</div>
          <div style={{ fontSize: 13, color: "var(--fg-3)" }}>2m ago · 3 links</div>
        </div>
        <div style={{ paddingTop: 6 }}>
          <SheetItem
            label="Edit"
            icon={
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3 15l9-9 2 2-9 9H3z" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            }
          />
          <SheetItem
            label="Pin to top"
            icon={
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 3v6M7 6l3-3 3 3" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 11v5h12v-5" stroke="var(--fg-2)" strokeWidth="1.5" />
              </svg>
            }
          />
          <SheetItem
            label="Move to folder"
            icon={
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3 6h6l2 2h6v8H3z" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            }
          />
          <SheetItem
            label="Share / export"
            icon={
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <circle cx="6" cy="10" r="2" stroke="var(--fg-2)" strokeWidth="1.5" />
                <circle cx="14" cy="5" r="2" stroke="var(--fg-2)" strokeWidth="1.5" />
                <circle cx="14" cy="15" r="2" stroke="var(--fg-2)" strokeWidth="1.5" />
                <path d="M8 9l4-2.5M8 11l4 2.5" stroke="var(--fg-2)" strokeWidth="1.5" />
              </svg>
            }
          />
          <SheetItem
            label="Archive"
            icon={
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M4 6h12v11H4z" stroke="var(--fg-2)" strokeWidth="1.5" />
                <path d="M3 3h14v3H3z" stroke="var(--fg-2)" strokeWidth="1.5" />
              </svg>
            }
          />
          <SheetItem
            label="Delete"
            danger
            icon={
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
        </div>
      </Sheet>
    </Screen>
  );
}

export const organizeScreens: ScreenDef[] = [
  { id: "NO-01", label: "Folders", Component: Folders },
  { id: "NO-02", label: "Tag browser", Component: TagBrowser },
  { id: "NO-03", label: "Saved views", Component: SavedViews },
  { id: "NO-04", label: "Filter builder", Component: FilterBuilder },
  { id: "NO-05", label: "View settings", Component: ViewSettings },
  { id: "NO-06", label: "Trash", Component: Trash },
  { id: "NO-07", label: "Archive", Component: Archive },
  { id: "NO-08", label: "Multi-select", Component: MultiSelect },
  { id: "NO-09", label: "Note context sheet", Component: NoteContextSheet },
];
