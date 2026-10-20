import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Title, Lead, ListGroup, ListRow, Icon, Chip, MonoBox, LIST_TOP } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Plain-file surfaces (prefix PT).
 *
 * This section exists because the store story makes a claim the board could not
 * depict: that the notes you export are ordinary files. Nothing under
 * `mobile/src/screens/` rendered a note as a file before `myne-md/myne#896`, and
 * the capture now fails by name when a frame names a screen the board does not
 * render, so the gap was loud rather than a silently empty plate.
 *
 * The claim is anchored to the EXPORT on purpose, and `/pr-review` is why. The
 * first version said "this is a file on your disk" and showed a file browser,
 * which mobile cannot honestly promise: there is no plain-file ingress on the
 * phone (`mobile/src/platform/plainFile.ts` says the plugin is never registered
 * and every command rejects at the host). Exporting plain markdown is real here,
 * so that is what the frame and its caption both say now.
 *
 * What it depicts is deliberately NOT Myne. An exported note is a `.md` file that
 * any editor opens, so the honest picture is a plain file browser listing `.md`
 * files, next to the same file's text with no Myne chrome around it. Drawing
 * Myne's own editor here would contradict the claim: the point is that the file
 * outlives the app.
 *
 * The browser chrome is neutral on purpose. It is not showing a screenshot of a
 * named third-party app, which would be a different claim and one we cannot keep.
 *
 * Style discipline: zero hardcoded visual values, same reason as the agent and
 * members sections. `scripts/check-token-adoption.mjs` treats an unrecorded file
 * as a baseline of 0 and fails on the first literal, and every existing gallery
 * screen is in recorded debt, so its neighbours could not be copied.
 *
 * No `t()`: gallery chrome, not a wired surface.
 */

// ── Shared bits ──────────────────────────────────────────────────────────────

function NavHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: "none",
        paddingTop: LIST_TOP,
        paddingBottom: "var(--space-3)",
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          color: "var(--accent)",
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-medium)",
        }}
      >
        <Icon name="chevron-right" size={16} color="var(--accent)" flip />
        {label}
      </div>
    </div>
  );
}

function Header({ title, lede }: { title: string; lede?: string }) {
  return (
    <div style={{ padding: "var(--space-5) var(--space-5) var(--space-3)" }}>
      <Title>{title}</Title>
      {lede && <Lead>{lede}</Lead>}
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

function Note({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "accent" }) {
  const style: CSSProperties =
    tone === "accent"
      ? { background: "var(--accent-soft)", color: "var(--accent)" }
      : { background: "var(--bg-2)", color: "var(--fg-2)" };
  return (
    <div
      style={{
        ...style,
        borderRadius: "var(--radius-3)",
        padding: "var(--space-3) var(--space-4)",
        fontSize: "var(--text-sm)",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

/** One line of plain markdown, rendered as text rather than as rich UI. */
function PlainLine({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.6,
        color: muted ? "var(--fg-3)" : "var(--fg-1)",
      }}
    >
      {children}
    </div>
  );
}

// ── PT-01 · The note as a file, in any file browser ──────────────────────────

function FileOnDisk() {
  return (
    <Screen>
      <NavHeader label="On this device" />
      <ScreenScroll>
        <Header
          title="Notes"
          lede="Export the vault and this is what you get: a folder of markdown files. No database, no proprietary container."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="3 files">
            <ListRow
              title="reading-list.md"
              detail="12 KB"
              leading={<Icon name="folder" size={18} color="var(--fg-3)" />}
            />
            <ListRow
              title="zettelkasten-index.md"
              detail="8 KB"
              leading={<Icon name="folder" size={18} color="var(--fg-3)" />}
            />
            <ListRow
              title="weekly-review.md"
              detail="4 KB"
              leading={<Icon name="folder" size={18} color="var(--fg-3)" />}
              isLast
            />
          </ListGroup>
          <ListGroup header="reading-list.md">
            <div style={{ padding: "var(--space-3) var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <PlainLine># Reading list</PlainLine>
              <PlainLine muted> </PlainLine>
              <PlainLine>- [x] Seeing Like a State</PlainLine>
              <PlainLine>- [ ] [[Zettelkasten index]]</PlainLine>
              <PlainLine muted> </PlainLine>
              <PlainLine muted>---</PlainLine>
              <PlainLine muted>updated: 2026-10-17</PlainLine>
            </div>
          </ListGroup>
          <Note>
            An exported file opens in any editor, on any machine, with or without Myne installed. If
            you stop trusting this project, you walk away with your notes.
          </Note>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <Chip>markdown</Chip>
            <Meta>one command, whole vault</Meta>
          </div>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── PT-02 · The same file open somewhere else ────────────────────────────────

function OpensAnywhere() {
  return (
    <Screen>
      <NavHeader label="On this device" />
      <ScreenScroll>
        <Header
          title="reading-list.md"
          lede="The exported file, opened by something that is not Myne. Nothing in it needs Myne to be readable."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <MonoBox value="# Reading list" testId="portable.board.heading" />
          <ListGroup footer="Wikilinks stay readable as links even where nothing resolves them. There is no lock-in hiding in the syntax.">
            <ListRow title={<PlainLine>- [x] Seeing Like a State</PlainLine>} />
            <ListRow title={<PlainLine>- [ ] [[Zettelkasten index]]</PlainLine>} isLast />
          </ListGroup>
          <Note tone="accent">
            Attachments sit beside the notes as ordinary files, and an export writes the whole tree out
            as markdown.
          </Note>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

export const portableScreens: ScreenDef[] = [
  { id: "PT-01", label: "Exported notes as plain files", Component: FileOnDisk },
  { id: "PT-02", label: "The exported file in another editor", Component: OpensAnywhere },
];
