import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { MyneMark } from "../components/Icon";
import type { ScreenDef } from "../gallery/types";
import { ipadCommandScreens } from "./commands";
import { ipadEditorScreens } from "./editor";

/**
 * iPad workspace shell (WS-01) — the three-pane tablet layout: sidebar (248) +
 * note list (316) + detail/editor (flex). Built once with tokens, so light /
 * dark / amoled all follow. This is the worked tablet reference; the rest of the
 * iPad waves follow the same composition.
 */

function SidebarItem({
  icon,
  label,
  count,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  count?: string;
  active?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "8px 10px",
        borderRadius: 6,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--fg-2)",
      }}
    >
      {icon}
      <span style={{ fontSize: 14, fontWeight: active ? 600 : 400, flex: 1 }}>{label}</span>
      {count && <span style={{ fontSize: 12, color: active ? "var(--accent)" : "var(--fg-3)" }}>{count}</span>}
    </div>
  );
}

function FolderItem({ color, label, count }: { color: string; label: string; count: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 6, color: "var(--fg-2)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      <span style={{ fontSize: 14, flex: 1 }}>{label}</span>
      <span style={{ fontSize: 12, color: "var(--fg-3)" }}>{count}</span>
    </div>
  );
}

function SidebarGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: "6px 10px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
      }}
    >
      {children}
    </div>
  );
}

function NoteRow({
  color,
  title,
  snippet,
  meta,
  pinned = false,
  topBorder = true,
}: {
  color?: string;
  title: string;
  snippet: string;
  meta: string;
  pinned?: boolean;
  topBorder?: boolean;
}) {
  return (
    <div
      style={{
        padding: pinned ? "13px 12px" : "13px 6px",
        borderRadius: pinned ? 8 : 0,
        background: pinned ? "var(--accent-soft)" : "transparent",
        borderTop: !pinned && topBorder ? "1px solid var(--line-1)" : "none",
        color: "var(--fg-1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />}
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 13,
          color: "var(--fg-3)",
          lineHeight: 1.45,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {snippet}
      </div>
      <div style={{ marginTop: 7, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{meta}</div>
    </div>
  );
}

function ListGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "6px 6px", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

function WorkspaceShell() {
  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      {/* ── SIDEBAR ─────────────────────────────────────────────── */}
      <div style={{ width: 248, flex: "none", background: "var(--bg-2)", borderInlineEnd: "1px solid var(--line-1)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "18px 16px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--line-1)", borderRadius: 6, background: "var(--bg-1)" }}>
            <MyneMark size={18} radius={4} />
            <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Personal</span>
            <Icon name="chevron-down" size={11} color="var(--fg-3)" strokeWidth={1.6} />
          </div>
        </div>
        <div style={{ padding: "0 16px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34, border: "1px solid var(--line-1)", borderRadius: 6, background: "var(--bg-1)", padding: "0 10px" }}>
            <Icon name="search" size={15} color="var(--line-3)" strokeWidth={1.6} />
            <span style={{ fontSize: 13, color: "var(--line-3)", flex: 1 }}>Search</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-2)" }}>⌘K</span>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "4px 8px" }}>
          <SidebarItem
            active
            label="All notes"
            count="48"
            icon={
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
                <path d="M3 5h14M3 10h14M3 15h9" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            }
          />
          <SidebarItem
            label="Pinned"
            count="2"
            icon={<Icon name="folder" size={17} color="var(--fg-3)" strokeWidth={1.6} />}
          />
          <SidebarGroupLabel>Folders</SidebarGroupLabel>
          <FolderItem color="var(--label-slate)" label="Specs" count="12" />
          <FolderItem color="var(--label-moss)" label="Work" count="18" />
          <FolderItem color="var(--label-ochre)" label="Reading" count="9" />
          <SidebarGroupLabel>Library</SidebarGroupLabel>
          <SidebarItem
            label="Graph"
            icon={
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
                <circle cx="5" cy="14" r="2.2" stroke="var(--fg-3)" strokeWidth="1.6" />
                <circle cx="15" cy="11.5" r="2.2" stroke="var(--fg-3)" strokeWidth="1.6" />
                <circle cx="11" cy="5" r="2.2" stroke="var(--fg-3)" strokeWidth="1.6" />
                <path d="M6.8 12.4l2.6-5.8M7 13.6l5.9-1.4" stroke="var(--fg-3)" strokeWidth="1.5" />
              </svg>
            }
          />
          <SidebarItem label="Trash" icon={<Icon name="trash" size={17} color="var(--fg-3)" strokeWidth={1.6} />} />
        </div>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
            <span style={{ fontSize: 12, color: "var(--fg-3)" }}>Synced · 2m ago</span>
          </div>
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="7" r="3" stroke="var(--fg-3)" strokeWidth="1.6" />
            <path d="M4 16c0-3 2.7-5 6-5s6 2 6 5" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* ── LIST ────────────────────────────────────────────────── */}
      <div style={{ width: 316, flex: "none", borderInlineEnd: "1px solid var(--line-1)", display: "flex", flexDirection: "column", background: "var(--bg-1)" }}>
        <div style={{ padding: "18px 18px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>All notes</h1>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ width: 32, height: 32, borderRadius: 6, border: "1px solid var(--line-1)", background: "var(--bg-1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                  <path d="M4 6h12M6 10h8M9 14h2" stroke="var(--fg-2)" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </div>
              <div style={{ width: 32, height: 32, borderRadius: 6, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="plus" size={16} color="var(--accent-on)" strokeWidth={2} />
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 7 }}>
            <span style={{ padding: "5px 11px", borderRadius: 999, background: "var(--accent)", color: "var(--accent-on)", fontSize: 12, fontWeight: 600 }}>All</span>
            <span style={{ padding: "5px 11px", borderRadius: 999, background: "var(--bg-2)", border: "1px solid var(--line-1)", color: "var(--fg-2)", fontSize: 12, fontWeight: 500 }}>Specs</span>
            <span style={{ padding: "5px 11px", borderRadius: 999, background: "var(--bg-2)", border: "1px solid var(--line-1)", color: "var(--fg-2)", fontSize: 12, fontWeight: 500 }}>Work</span>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 12px 12px" }}>
          <ListGroupLabel>Pinned</ListGroupLabel>
          <NoteRow pinned color="var(--label-slate)" title="Threat model v2" snippet="We assume a powerful network adversary that can observe all traffic…" meta="2m ago · 3 links" />
          <ListGroupLabel>Today</ListGroupLabel>
          <NoteRow topBorder={false} color="var(--label-moss)" title="Weekly review — 06-15" snippet="Shipped the sync conflict resolver. Next: mobile share sheet…" meta="Today · 5 links" />
          <NoteRow color="var(--label-ochre)" title="Inbox — quick capture" snippet="Three loose thoughts to file later…" meta="Today · 0 links" />
          <ListGroupLabel>Earlier</ListGroupLabel>
          <NoteRow topBorder={false} title="Project Aurora — kickoff" snippet="Scope, owners, and the first three milestones…" meta="Mon · 8 links" />
          <NoteRow title="Key rotation" snippet="Device keys rotate on re-pair. The vault key never leaves the device…" meta="Jun 9 · 4 links" />
        </div>
      </div>

      {/* ── DETAIL / EDITOR ─────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-1)", minWidth: 0 }}>
        <div style={{ height: 52, flex: "none", borderBottom: "1px solid var(--line-1)", display: "flex", alignItems: "center", padding: "0 18px", gap: 14 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>Specs / Threat model v2</div>
          <div style={{ flex: 1 }} />
          <Icon name="edit" size={19} color="var(--fg-2)" strokeWidth={1.6} />
          <Icon name="share" size={19} color="var(--fg-2)" strokeWidth={1.6} />
          <svg width="19" height="19" viewBox="0 0 22 22" fill="none">
            <rect x="3" y="4" width="16" height="14" rx="2" stroke="var(--fg-2)" strokeWidth="1.6" />
            <path d="M14 4v14" stroke="var(--fg-2)" strokeWidth="1.6" />
          </svg>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "34px 56px", minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.2, letterSpacing: "-0.02em", fontWeight: 600, color: "var(--fg-display)" }}>
            Threat model v2
          </h1>
          <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>edited 2m ago · 412 words</div>
          <h2 style={{ margin: "28px 0 0", fontSize: 21, fontWeight: 600 }}>Adversaries</h2>
          <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.75, maxWidth: 620 }}>
            We assume a powerful network adversary that can observe all traffic and compromise the
            relay. The vault key is derived from the passphrase and{" "}
            <span style={{ background: "var(--highlight)", padding: "0 2px", borderRadius: 2 }}>never leaves the device</span>.
          </p>
          <p style={{ margin: "14px 0 0", fontSize: 16, lineHeight: 1.75, maxWidth: 620 }}>
            Ciphertext is opaque to the server: see{" "}
            <span style={{ color: "var(--accent)", borderBottom: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)" }}>
              [[Key rotation]]
            </span>{" "}
            for how device keys are re-derived on re-pair.
          </p>
          <ul style={{ margin: "14px 0 0", paddingInlineStart: 22, fontSize: 16, lineHeight: 1.8, maxWidth: 620 }}>
            <li>Network observer — sees timing + size only</li>
            <li>
              Malicious relay — stores{" "}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 3, padding: "0 5px" }}>
                ciphertext
              </span>
            </li>
            <li>Lost device — protected by passphrase</li>
          </ul>
          <blockquote style={{ margin: "20px 0 0", paddingInlineStart: 16, borderInlineStart: "2px solid var(--line-2)", color: "var(--fg-2)", fontSize: 16, lineHeight: 1.65, maxWidth: 600 }}>
            A note the server can read is a note someone else can read.
          </blockquote>
        </div>
      </div>
    </div>
  );
}

export const ipadScreens: ScreenDef[] = [
  { id: "WS-01", label: "Workspace — three-pane", Component: WorkspaceShell, platforms: ["ipad"], orientation: "landscape" },
  ...ipadEditorScreens,
  ...ipadCommandScreens,
];
