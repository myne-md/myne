import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Title, Lead, ListGroup, ListRow, Button, Icon, Chip, MonoBox, LIST_TOP, ACCOUNT_NUMBER_SPECIMEN } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Collaboration surfaces (prefix MB). Static design-board mocks of what mobile
 * ships today: the person identity substrate and its out-of-band code, the
 * member roster with signed display names, a per-device binding, and a note
 * whose edits carry names.
 *
 * **What this section depicts for a phone, and what it deliberately does not.**
 * Mobile reaches the roster and the invite ACCEPT side:
 * `SyncMembersPanel` / `useMembers` list the members and devices, and
 * `personAcceptInvite` claims an invite. It has NO caller for
 * `personCreateInvite`, `personSetMemberName` or `personRemoveMember`, so the
 * creation wizard (`MB-02`), the rename (`MB-04`) and the removal (`MB-06`) are
 * the desktop feature-parity design target and are recorded as unreachable in
 * `NOT_REACHABLE_ON_MOBILE` (`scripts/check-store-publishable.mjs`). The framed
 * roster (`MB-03`) therefore states what a phone genuinely does: everyone on
 * that vault reads the same notes, and your own account and other vaults stay
 * yours, and claims nothing about a removal a phone cannot perform.
 *
 * - **No live presence and no co-editing cursor.** Real-time collaboration is
 *   NOT shipped: `docs/vision.md` reversed the anti-feature on 2026-10-10 for a
 *   future release. A listing frame showing a peer's cursor would be depicting a
 *   flow a user cannot reach, which is Apple guideline 2.3.1 (misleading
 *   metadata). The `live-awareness relay` README says the codec landed and the
 *   production path is not wired, so there is nothing to show yet either way.
 * - **No "collaborate in real time" claim in any caption.** The honest claim is
 *   that a vault can be SHARED and that member names are signed by the person
 *   they name.
 *
 * **Overlap with `MV-05` resolved rather than duplicated.** `MV-05 Join from
 * another device` stays in the multi-vault section, because joining a vault from
 * your own second device and claiming an invite into someone else's vault are
 * the same screen reached from two places. This section renders the roster and
 * the invite side, and deliberately renders no join step.
 *
 * Style discipline: no hardcoded visual value `scripts/check-token-adoption.mjs`
 * counts, because an unrecorded file's baseline is 0. The ratchet reads colour
 * literals and numeric radius/padding/gap/margin/font-size/weight in inline
 * styles; it does NOT read a quoted box-string, a unitless `lineHeight`, or a
 * bare `width`/`height` number, and this file carries the last two
 * (`Monogram`'s 32 and the note line-heights). Those residue values are
 * deliberate and unreachable to a custom theme, and they are named here rather
 * than covered by a "zero literals" claim the guard cannot hold. The nav
 * header's padding was a quoted box-string until the review measured that blind
 * spot, and it moved to the space scale instead of being documented as an
 * evasion.
 *
 * No `t()`: gallery chrome, not a wired surface.
 */

/**
 * THE PINNED IDENTIFIERS. The account number is ONE constant, shared with the
 * whole board (`ACCOUNT_NUMBER_SPECIMEN` in `mobile/src/components/misc.tsx`),
 * so there is exactly one specimen and not several.
 *
 * A frame rendered from this board ends up in a public store listing, so an
 * account number or a recovery phrase that reached one would be published
 * permanently. `scripts/check-web-testids.mjs` exists partly on the reasoning
 * that the account number is one keystroke from the DOM and that screenshots and
 * CI artefacts are among the places it can land. A store image is the most
 * public such place, so the values are fixed, identical in every render, and
 * must never be read from a live vault.
 *
 * The shared specimen is a VALID Crockford-base32 display form whose Damm-32
 * check character was verified once against the Rust implementation, the same
 * one-time check `scripts/check-store-frame-identifiers.mjs` records in its own
 * header; nothing runs that derivation in this tree. The
 * phrase fragment shows TWO of twenty-four words, which cannot reconstruct a
 * phrase, and both are BIP-39 list words so the specimen reads as real without
 * being usable.
 */
const PINNED_PHRASE_FRAGMENT = ["01", "harbor", "03", "lantern"];

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
        <Icon name="chevron-left" size={16} color="var(--accent)" flip />
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

function Meta({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

/** Round monogram, the roster's leading glyph. */
function Monogram({ name }: { name: string }) {
  return (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: "var(--radius-pill)",
        background: "var(--bg-2)",
        color: "var(--fg-2)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--weight-semibold)",
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

// ── MB-01 · Your person identity ─────────────────────────────────────────────

function PersonIdentity() {
  return (
    <Screen>
      <NavHeader label="Identity" />
      <ScreenScroll>
        <Header
          title="Your person identity"
          lede="One identity, derived from your recovery phrase, that works across every vault you are in. It is not tied to a vault and no vault credential can open it."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="Your code">
            <ListRow title={<Meta>MYNE-PERSON-1:0f3a…c81d</Meta>} leading={<Icon name="fingerprint" size={18} color="var(--fg-2)" />} isLast />
          </ListGroup>
          <ListGroup header="Account number">
            <ListRow title={<Meta>{ACCOUNT_NUMBER_SPECIMEN}</Meta>} isLast />
          </ListGroup>
          <Note>
            The code carries public material only, and you share it out of band, in person or over a channel you
            already trust. The relay never carries it.
          </Note>
          <ListGroup header="Recovery phrase">
            <ListRow title={<Meta>{PINNED_PHRASE_FRAGMENT.join(" · ")}</Meta>} trailing={<Chip>24 words</Chip>} isLast />
          </ListGroup>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── MB-02 · Invite someone to the vault ──────────────────────────────────────

function InviteToVault() {
  return (
    <Screen>
      <NavHeader label="Members" />
      <ScreenScroll>
        <Header title="Invite someone" lede="You are inviting them to this vault, not to your account. They get the notes in it and nothing else." />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="Their code">
            <ListRow title={<Meta>Paste a MYNE-PERSON-1 code</Meta>} leading={<Icon name="link" size={18} color="var(--fg-2)" />} chevron isLast />
          </ListGroup>
          <ListGroup header="This invite">
            <ListRow title="Expires" detail="in 7 days" />
            <ListRow title="Can invite others" detail="No" isLast />
          </ListGroup>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button>Send invite</Button>
            <Button variant="ghost">Cancel</Button>
          </div>
          <Note>
            The invite is signed by you as the vault owner and claimed once. Nothing about your other vaults is
            visible to them.
          </Note>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── MB-03 · Members ──────────────────────────────────────────────────────────

function MemberRoster() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <ScreenScroll>
        <Header title="Members" lede="Everyone who can read this vault. Names are signed by the person they name." />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="3 people">
            <ListRow title="Ada" detail="Owner" leading={<Monogram name="Ada" />} trailing={<Icon name="check" size={16} color="var(--fg-3)" />} chevron />
            <ListRow title="Mert" detail="Member" leading={<Monogram name="Mert" />} trailing={<Icon name="check" size={16} color="var(--fg-3)" />} chevron />
            <ListRow title="You" leading={<Monogram name="You" />} trailing={<Icon name="check" size={16} color="var(--fg-3)" />} chevron isLast />
          </ListGroup>
          <ListGroup header="Devices">
            <ListRow title="iPhone" detail="Ada" leading={<Icon name="cloud" size={18} color="var(--fg-2)" />} chevron />
            <ListRow title="iPhone" leading={<Icon name="cloud" size={18} color="var(--fg-2)" />} chevron />
            <ListRow title="Pixel" leading={<Icon name="cloud" size={18} color="var(--fg-2)" />} chevron isLast />
          </ListGroup>
          <Note>
            Everyone here reads the same notes in this vault. You join with an invite the owner sends, and your
            own account and your other vaults stay yours.
          </Note>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── MB-04 · Names you can verify ─────────────────────────────────────────────

function NameVerification() {
  return (
    <Screen>
      <NavHeader label="Members" />
      <ScreenScroll>
        <Header
          title="What should we call you?"
          lede="Your name is visible to everyone in this vault. It is signed by the identity you already have, so nobody else can set it."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <MonoBox value="Mert" testId="members.board.name" />
          <ListGroup footer="A name is a label, not an identity. Two people can choose the same one, and the fingerprint is what tells them apart.">
            <ListRow title="Signed by your identity" detail="yes" trailing={<Icon name="check" size={16} color="var(--fg-3)" />} isLast />
          </ListGroup>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button>Set name</Button>
            <Button variant="ghost">Not now</Button>
          </div>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── MB-05 · One vault, shared ────────────────────────────────────────────────

function SharedNote() {
  return (
    <Screen>
      <NavHeader label="Project Ivy: spec" />
      <ScreenScroll>
        <Header
          title="Project Ivy: spec"
          lede="A note in a shared vault. Each edit carries the name of whoever made it."
        />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <Note>
            The retry budget is five attempts, per note. Backoff doubles from two seconds.
          </Note>
          <Meta>Ada · yesterday</Meta>
          <Note tone="accent">
            Decided per note rather than per vault, because a single large attachment should not spend the whole
            vault's budget.
          </Note>
          <Meta>Mert · 2h ago</Meta>
          <ListGroup header="Who can read this">
            <ListRow title="Ada" detail="Owner" leading={<Monogram name="Ada" />} isLast={false} />
            <ListRow title="Mert" detail="Member" leading={<Monogram name="Mert" />} isLast={false} />
            <ListRow title="You" leading={<Monogram name="You" />} isLast />
          </ListGroup>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── MB-06 · Leave or remove ──────────────────────────────────────────────────

function RemoveMember() {
  return (
    <Screen>
      <NavHeader label="Members" />
      <ScreenScroll>
        <Header title="Remove Mert?" lede="They stop receiving new changes. Notes they already have stay readable to them, and the server refuses their token." />
        <div style={{ padding: "0 var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <ListGroup header="What happens">
            <ListRow title="Vault access" detail="Ends" />
            <ListRow title="Their own notes" detail="Untouched" />
            <ListRow title="Their device binding" detail="Cleared" isLast />
          </ListGroup>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button>Remove Mert</Button>
            <Button variant="ghost">Cancel</Button>
          </div>
          <Note>
            This cannot be undone by re-inviting. A new invite starts a new membership with a new key.
          </Note>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

export const memberScreens: ScreenDef[] = [
  { id: "MB-01", label: "Your person identity", Component: PersonIdentity },
  { id: "MB-02", label: "Invite someone to the vault", Component: InviteToVault },
  { id: "MB-03", label: "Members and devices", Component: MemberRoster },
  { id: "MB-04", label: "Set your member name", Component: NameVerification },
  { id: "MB-05", label: "A note in a shared vault", Component: SharedNote },
  { id: "MB-06", label: "Remove a member", Component: RemoveMember },
];
