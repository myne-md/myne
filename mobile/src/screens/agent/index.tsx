import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Title, Lead, ListGroup, ListRow, Button, Icon, Chip, LIST_TOP } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Agent surfaces (prefix AG). Static design-board mocks of the agent flows the
 * app ships (`src/app/flows/AiChatFlow.tsx`, `AiReviewFlow.tsx`, `AiScopeSheet.tsx`,
 * `MemorySection.tsx`, `AiConsentScreen`), built so a store listing frame can
 * show the agent WITHOUT depicting anything the product does not do.
 *
 * Two rules this section exists to hold:
 *
 * 1. **The agent is off until a person turns it on.** AG-01 is the default
 *    state and AG-02 is the switch, and neither is skippable in the sequence
 *    the store frame reads.
 * 2. **Nothing is sent anywhere until a provider is NAMED.** The state AG-02
 *    lands on is enabled with the provider unsaid, which is the only state in
 *    which a frame can claim that nothing left the device.
 * 3. **Mobile runs no model on device.** `mobile/src-tauri/src/plugins/agent/state.rs`
 *    holds `NoLocalEngine` and says so: on a phone every AI request goes to a
 *    user-named remote provider, by decision. `docs/threat-model.md` states the
 *    invariant this section holds: no note content, prompt or model output
 *    leaves the device unless the user has named a provider, and when one is
 *    named the notes a run is pointed at DO leave the device for that provider.
 *    Nothing here offers, or implies, on-device inference.
 *
 * Style discipline: no hardcoded visual value `scripts/check-token-adoption.mjs`
 * counts, because an unrecorded file's baseline is 0. The ratchet reads colour
 * literals and numeric radius/padding/gap/margin/font-size/weight in inline
 * styles; it does NOT read a quoted box-string, a unitless `lineHeight`, or a
 * bare `width`/`height` number, and this file carries those as residue (the
 * `Note`/`Turn` line-heights). Everything the ratchet DOES count is a
 * `var(--token)`, including the nav header's padding, which was a quoted
 * box-string until the review measured the blind spot and moved it to the space
 * scale rather than documenting the evasion.
 *
 * No `t()`: the gallery is design-review chrome rendered outside the app, not a
 * wired surface, so these are literals like the other boards' labels.
 */

// ── Shared bits ──────────────────────────────────────────────────────────────

/** Back chevron + parent label. A div, not a button: a board mock does nothing. */
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
        <Icon name="chevron-left" size={16} color="var(--accent)" flip />
        {label}
      </div>
    </div>
  );
}

/** Page title + optional lede, in the flow-header rhythm. */
function Header({ title, lede }: { title: string; lede?: string }) {
  return (
    <div style={{ padding: "var(--space-5) var(--space-5) var(--space-3)" }}>
      <Title>{title}</Title>
      {lede && <Lead>{lede}</Lead>}
    </div>
  );
}

/** Tinted sentence block. Used for the two frames whose whole point is copy. */
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

/** One prose line of the fake conversation, aligned left or right. */
function Turn({ mine = false, children }: { mine?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "78%",
          background: mine ? "var(--accent)" : "var(--bg-2)",
          color: mine ? "var(--accent-on)" : "var(--fg-1)",
          borderRadius: "var(--radius-3)",
          padding: "var(--space-3) var(--space-4)",
          fontSize: "var(--text-base)",
          lineHeight: 1.45,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A mono meta line, for scope counts and timestamps. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-3)",
      }}
    >
      {children}
    </div>
  );
}

// ── AG-01 · Intelligence, off (the default) ──────────────────────────────────

function IntelligenceOff() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll>
        <Header title="Intelligence" />
        <div style={{ padding: "0 var(--space-5)" }}>
          <ListGroup
            footer="Off by default. Nothing runs, and nothing is sent anywhere, until you turn it on and name a provider yourself."
          >
            <ListRow title="Intelligence" detail="Off" chevron testID="agent.board.intelligence" />
            <ListRow title="Ask about your notes" detail="Off" />
            <ListRow title="Writing assistant" detail="Off" isLast />
          </ListGroup>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── AG-02 · Turn it on (enabled, provider deliberately unnamed) ───────────────

function TurnItOn() {
  return (
    <Screen>
      <NavHeader label="Intelligence" />
      <ScreenScroll>
        <Header
          title="Where should it run?"
          lede="You name where it runs: a service you choose, with a key you supply. Myne picks nothing for you, and nothing is sent until you do."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="Intelligence">
            <ListRow title="Intelligence" detail="On" />
            <ListRow title="Change notes" detail="Off" isLast />
          </ListGroup>
          <ListGroup header="Where it runs">
            <ListRow title="A service you name" detail="Not named" isLast />
          </ListGroup>
          <Note tone="accent">
            No provider is named yet, so there is nowhere for a question to go. Nothing leaves this device.
          </Note>
          <ListGroup header="Also available">
            <ListRow title="Memory" detail="Off" chevron isLast />
          </ListGroup>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── AG-03 · Ask about your notes ─────────────────────────────────────────────

function AskAboutNotes() {
  return (
    <Screen>
      <NavHeader label="Intelligence" />
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-3) var(--space-5)",
        }}
      >
        <Chip active>whole vault</Chip>
        <Meta>provider named</Meta>
      </div>
      <ScreenScroll>
        {/* What it can do, said before it does any of it. A chat screenshot alone
            reads as "there is a text box"; the user's report was that nothing about
            this frame said AGENT, so the abilities are the first thing on it. */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-1)",
            padding: "0 var(--space-5) var(--space-3)",
          }}
        >
          {[
            "summarise a note",
            "find a decision",
            "link two notes",
            "rewrite a paragraph",
            "pull out tasks",
          ].map((ability) => (
            <Chip key={ability}>{ability}</Chip>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
            padding: "0 var(--space-5)",
          }}
        >
          <Turn mine>What did I decide about the sync retry budget?</Turn>
          <Turn>
            You set it to five attempts with a doubling backoff, in the note dated 3 October. The budget is
            per note, not per vault, and a note that exhausts it is marked and left alone.
          </Turn>
          <Turn mine>Rewrite that paragraph so it reads as a decision.</Turn>
          <Turn>
            I can do that. It touches one paragraph in one note, and I will show you the change before it
            lands.
          </Turn>
        </div>
        <div style={{ padding: "var(--space-4) var(--space-5) 0" }}>
          <Note>Proposed edit, held for review. Nothing is written until you approve it.</Note>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── AG-04 · Proposed edit, held ──────────────────────────────────────────────

function ProposedEdit() {
  return (
    <Screen>
      <NavHeader label="Project Ivy: spec" />
      <ScreenScroll>
        <Header title="One paragraph changes" />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="This run">
            <ListRow title="Notes touched" detail="1" />
            <ListRow title="Lines changed" detail="2" />
            <ListRow title="Where it ran" detail="The service you named" isLast />
          </ListGroup>
          <Note>
            The retry budget is five attempts, per note. Backoff doubles from two seconds.
          </Note>
          <Note tone="accent">
            The retry budget is set to five attempts with a doubling backoff, decided per note rather than per
            vault. A note that exhausts its budget is marked and left alone.
          </Note>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button>Approve</Button>
            <Button variant="ghost">View diff</Button>
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="ghost">Revert this run</Button>
          </div>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── AG-05 · Review before it lands ───────────────────────────────────────────

function ReviewBeforeItLands() {
  return (
    <Screen>
      <NavHeader label="Intelligence" />
      <ScreenScroll>
        <Header title="Review changes" lede="Three notes in Project Ivy, from one run." />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup
            footer="Approving writes the changes to your notes. Nothing here is reversible after you lock the vault, so read the diff first."
          >
            <ListRow title="Project Ivy: spec" detail="2 lines" chevron />
            <ListRow title="Threat model: draft" detail="1 line" chevron />
            <ListRow title="Weekly review" detail="4 lines" chevron isLast />
          </ListGroup>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button>Approve all three</Button>
            <Button variant="ghost">Close</Button>
          </div>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── AG-06 · Memory ───────────────────────────────────────────────────────────

function Memory() {
  return (
    <Screen>
      <NavHeader label="Intelligence" />
      <ScreenScroll>
        <Header
          title="Memory"
          lede="What the agent carries between conversations. Written by you, held for review before it is used."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="Kept">
            <ListRow title="Prefers decisions written in the past tense" detail="2d ago" chevron />
            <ListRow title="Works on the sync spec on weekdays" detail="1w ago" chevron isLast />
          </ListGroup>
          <ListGroup header="Held for review">
            <ListRow
              title="Might prefer shorter summaries"
              detail="New"
              leading={<Icon name="clock" size={16} color="var(--fg-3)" />}
              chevron
              isLast
            />
          </ListGroup>
          <Meta>Memory syncs with the vault and is encrypted like every note.</Meta>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

export const agentScreens: ScreenDef[] = [
  { id: "AG-01", label: "Intelligence, off (default)", Component: IntelligenceOff },
  { id: "AG-02", label: "Turn it on, provider unnamed", Component: TurnItOn },
  { id: "AG-03", label: "Ask about your notes", Component: AskAboutNotes },
  { id: "AG-04", label: "Proposed edit, held for review", Component: ProposedEdit },
  { id: "AG-05", label: "Review changes", Component: ReviewBeforeItLands },
  { id: "AG-06", label: "Memory", Component: Memory },
];
