import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Button, ACCOUNT_NUMBER_SPECIMEN } from "../../components";
import type { ScreenDef } from "../../gallery/types";
import { FieldLabel, SectionLabel } from "@myne/field-label";

/**
 * Settings detail screens (prefix ST). iOS grouped-list settings pages built to
 * the design's literal geometry: r:10 cards, 13px/14px rows, hairline separators,
 * 48×28 accent toggles. Light variant only — dark/AMOLED flip via CSS tokens.
 */

// ── Shared bits ──────────────────────────────────────────────────────────────

/** Top nav bar: back chevron + parent screen label, hairline underneath. */
function NavHeader({ label }: { label: string }) {
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

/** Page H1 — defaults to the 26/700 settings-detail title. */
function PageTitle({
  children,
  size = 26,
  weight = 700,
  margin = "4px 4px 0",
}: {
  children: ReactNode;
  size?: number;
  weight?: number;
  margin?: string;
}) {
  return (
    <h1
      style={{
        margin,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: "-0.02em",
        color: "var(--fg-display)",
      }}
    >
      {children}
    </h1>
  );
}

/** Inset grouped-list card. */
function Group({ children, mt = 0 }: { children: ReactNode; mt?: number }) {
  return (
    <div
      style={{
        marginTop: mt,
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      {children}
    </div>
  );
}

/** A single list row. `first` drops the top hairline. */
function Row({
  children,
  first = false,
  style,
}: {
  children: ReactNode;
  first?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "13px 14px",
        color: "var(--fg-1)",
        borderTop: first ? undefined : "1px solid var(--line-1)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The small disclosure chevron on navigation rows. */
function RowChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14" style={{ flex: "none" }}>
      <path
        d="M1 1l6 6-6 6"
        stroke="var(--line-2)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** iOS toggle, accent-on (48×28). Presentational only. */
function Toggle({ on = false }: { on?: boolean }) {
  return (
    <div
      style={{
        width: 48,
        height: 28,
        borderRadius: 999,
        background: on ? "var(--accent)" : "var(--line-2)",
        position: "relative",
        flex: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          insetInlineStart: on ? 23 : 3,
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "var(--bg-1)",
        }}
      />
    </div>
  );
}

/** Keyboard-shortcut chip. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        color: "var(--fg-2)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: 5,
        padding: "3px 8px",
      }}
    >
      {children}
    </span>
  );
}

// ── ST-01 · Account ───────────────────────────────────────────────────────────
function Account() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Account</PageTitle>
        <Group mt={16}>
          <Row first>
            <span style={{ fontSize: 16 }}>Account no.</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-2)" }}>
              {ACCOUNT_NUMBER_SPECIMEN}
            </span>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Vault label</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-3)" }}>
              <span style={{ fontSize: 16 }}>Personal</span>
              <RowChevron />
            </div>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Change password</span>
            <RowChevron />
          </Row>
        </Group>
        <SectionLabel>Encryption</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Key derivation</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-3)" }}>
              Argon2id
            </span>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Parameters</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-3)" }}>
              256 MiB · t=3 · p=2
            </span>
          </Row>
        </Group>
        <SectionLabel tone="danger">Danger zone</SectionLabel>
        <button
          style={{
            width: "100%",
            height: 48,
            border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
            borderRadius: 10,
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Delete vault
        </button>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-02 · Change password [keyboard] ────────────────────────────────────────
function ChangePassword() {
  return (
    <Screen>
      <NavHeader label="Account" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <PageTitle size={24} weight={600} margin="4px 0 0">
          Change password
        </PageTitle>
        <FieldLabel mt={18}>Current password</FieldLabel>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 50,
            border: "1px solid var(--line-2)",
            borderRadius: 6,
            background: "var(--bg-1)",
            padding: "0 14px",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.14em", color: "var(--fg-1)" }}>
            ••••••••
          </span>
        </div>
        <FieldLabel mt={16}>New password</FieldLabel>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 50,
            border: "1.5px solid var(--accent)",
            borderRadius: 6,
            background: "var(--bg-1)",
            padding: "0 14px",
            boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.14em", color: "var(--fg-1)" }}>
            ••••••••••
          </span>
          <span style={{ width: 2, height: 22, background: "var(--accent)", marginInlineStart: 2 }} />
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, display: "flex", gap: 4 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--accent)" }} />
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--accent)" }} />
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--accent)" }} />
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--line-1)" }} />
          </div>
          <span style={{ fontSize: 13, color: "var(--fg-2)" }}>Strong</span>
        </div>
        <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          This invalidates quick-unlock. Your recovery phrase is unchanged.
        </div>
      </div>
      <div style={{ flex: "none", padding: "14px 20px" }}>
        <Button>Change password</Button>
      </div>
    </Screen>
  );
}

// ── ST-03 · Privacy ───────────────────────────────────────────────────────────
function Privacy() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Privacy</PageTitle>
        <Group mt={16}>
          <Row first>
            <span style={{ fontSize: 16 }}>Screen-capture protection</span>
            <Toggle on />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Continue where I left off</span>
            <Toggle />
          </Row>
        </Group>
        <SectionLabel>Auto-lock</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Lock after</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-3)" }}>
              <span style={{ fontSize: 16 }}>5 minutes</span>
              <RowChevron />
            </div>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Quick unlock</span>
            <RowChevron />
          </Row>
        </Group>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-04 · Quick-unlock ──────────────────────────────────────────────────────
function QuickUnlock() {
  return (
    <Screen>
      <NavHeader label="Privacy" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle size={24}>Quick unlock</PageTitle>
        <div
          style={{
            marginTop: 12,
            background: "var(--warning-soft)",
            border: "1px solid color-mix(in srgb, var(--warning) 28%, transparent)",
            borderRadius: 8,
            padding: "11px 13px",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--warning)",
          }}
        >
          A convenience gate only. Your password is still required after a restart or auto-lock.
        </div>
        <Group mt={16}>
          <Row first>
            <span style={{ fontSize: 16 }}>Enable quick unlock</span>
            <Toggle on />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Face ID</span>
            <Toggle on />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>PIN</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-3)" }}>
              <span style={{ fontSize: 15 }}>Set · 6 digits</span>
              <RowChevron />
            </div>
          </Row>
        </Group>
        <div style={{ marginTop: 14, padding: "0 4px", fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          PIN must be at least 6 digits.
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-05 · Editor ────────────────────────────────────────────────────────────
function Editor() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Editor</PageTitle>
        <Group mt={16}>
          <Row first>
            <span style={{ fontSize: 16 }}>Default view</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Live</span>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Typography</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Comfortable</span>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Line numbers</span>
            <Toggle />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Spell check</span>
            <Toggle on />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Daily notes</span>
            <Toggle />
          </Row>
        </Group>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-06 · Files ─────────────────────────────────────────────────────────────
function Files() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Files</PageTitle>
        <SectionLabel mt={16}>On launch</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Last opened note</span>
            <svg width="16" height="16" viewBox="0 0 16 16" style={{ flex: "none" }}>
              <path
                d="M3 8.5l3 3 7-7.5"
                stroke="var(--accent)"
                strokeWidth="1.8"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Empty state</span>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Specific note…</span>
          </Row>
        </Group>
        <SectionLabel>New notes</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>New note location</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Current folder</span>
          </Row>
        </Group>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-07 · Appearance ────────────────────────────────────────────────────────
function Appearance() {
  const seg: CSSProperties = {
    flex: 1,
    textAlign: "center",
    padding: "8px 0",
    borderRadius: 6,
    fontSize: 13,
  };
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Appearance</PageTitle>
        <SectionLabel mt={16}>Theme</SectionLabel>
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
          <div style={{ ...seg, color: "var(--fg-2)" }}>System</div>
          <div
            style={{
              ...seg,
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              fontWeight: 600,
              color: "var(--fg-1)",
            }}
          >
            Light
          </div>
          <div style={{ ...seg, color: "var(--fg-2)" }}>Dark</div>
          <div style={{ ...seg, color: "var(--fg-2)" }}>AMOLED</div>
        </div>
        <SectionLabel>Custom themes</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Import theme (CSS)</span>
            <RowChevron />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Show edit times</span>
            <Toggle on />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Language</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>English</span>
          </Row>
        </Group>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-08 · Storage ───────────────────────────────────────────────────────────
function Storage() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Storage</PageTitle>
        <Group mt={16}>
          <Row first>
            <span style={{ fontSize: 16 }}>Vault location</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>
              …/Myne/Personal
            </span>
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Open in Files</span>
            <RowChevron />
          </Row>
        </Group>
        <SectionLabel>Backup</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Back up vault</span>
            <RowChevron />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Restore from backup</span>
            <RowChevron />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Automatic backup</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Daily</span>
          </Row>
        </Group>
        <SectionLabel>Import / export</SectionLabel>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Import from Obsidian</span>
            <RowChevron />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>Export whole vault</span>
            <RowChevron />
          </Row>
        </Group>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-09 · Hotkeys ───────────────────────────────────────────────────────────
function Hotkeys() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle>Hotkeys</PageTitle>
        <p style={{ margin: "6px 4px 0", fontSize: 13, color: "var(--fg-3)" }}>
          For a connected external keyboard.
        </p>
        <Group mt={14}>
          <Row first style={{ padding: "12px 14px" }}>
            <span style={{ fontSize: 15 }}>Quick switcher</span>
            <Kbd>⌘ O</Kbd>
          </Row>
          <Row style={{ padding: "12px 14px" }}>
            <span style={{ fontSize: 15 }}>New note</span>
            <Kbd>⌘ N</Kbd>
          </Row>
          <Row style={{ padding: "12px 14px" }}>
            <span style={{ fontSize: 15 }}>Search</span>
            <Kbd>⌘ ⇧ F</Kbd>
          </Row>
          <Row style={{ padding: "12px 14px" }}>
            <span style={{ fontSize: 15 }}>Insert wikilink</span>
            <Kbd>⌘ K</Kbd>
          </Row>
        </Group>
        <button
          style={{
            marginTop: 14,
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            padding: "0 4px",
          }}
        >
          Reset all
        </button>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-10 · About ─────────────────────────────────────────────────────────────
function About() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 0 18px" }}>
          <svg width="44" height="44" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="7" fill="var(--ink-1)" />
            <path
              d="M8 22 V10 L16 18 L24 10 V22"
              stroke="var(--paper)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div style={{ marginTop: 12, fontSize: 20, fontWeight: 600, color: "var(--fg-1)" }}>Myne</div>
          <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-3)" }}>
            Notes that belong to no one but you.
          </div>
          <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--line-3)" }}>
            0.4.1 · stable
          </div>
        </div>
        <Group>
          <Row first>
            <span style={{ fontSize: 16 }}>Threat model</span>
            <RowChevron />
          </Row>
          <Row>
            <span style={{ fontSize: 16 }}>License</span>
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>AGPL-3.0</span>
          </Row>
        </Group>
      </ScreenScroll>
    </Screen>
  );
}

// ── ST-11 · Connected extensions ──────────────────────────────────────────────
function ConnectedExtensions() {
  return (
    <Screen>
      <NavHeader label="Account" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <PageTitle size={24}>Connected extensions</PageTitle>
        <Group mt={16}>
          <Row first style={{ gap: 10 }}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style={{ flex: "none" }}>
              <circle cx="11" cy="11" r="8" stroke="var(--fg-2)" strokeWidth="1.5" />
              <path d="M11 3v16M3 11h16" stroke="var(--fg-2)" strokeWidth="1.2" />
            </svg>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Web clipper</div>
              <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Chrome · paired Jun 14</div>
            </div>
            <button
              style={{
                border: "none",
                background: "transparent",
                color: "var(--danger)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Revoke
            </button>
          </Row>
        </Group>
        <div style={{ marginTop: 14, padding: "0 4px", fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          Extensions can save clips into this vault. They never receive your password or keys.
        </div>
      </ScreenScroll>
    </Screen>
  );
}

export const settingsScreens: ScreenDef[] = [
  { id: "ST-01", label: "Account", Component: Account },
  { id: "ST-02", label: "Change password", Component: ChangePassword, keyboard: true },
  { id: "ST-03", label: "Privacy", Component: Privacy },
  { id: "ST-04", label: "Quick-unlock", Component: QuickUnlock },
  { id: "ST-05", label: "Editor", Component: Editor },
  { id: "ST-06", label: "Files", Component: Files },
  { id: "ST-07", label: "Appearance", Component: Appearance },
  { id: "ST-08", label: "Storage", Component: Storage },
  { id: "ST-09", label: "Hotkeys", Component: Hotkeys },
  { id: "ST-10", label: "About", Component: About },
  { id: "ST-11", label: "Connected extensions", Component: ConnectedExtensions },
];
