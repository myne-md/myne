// Opaque registration identifiers (MYND-619, task 7).
//
// ── The problem this solves ────────────────────────────────────────────────
//
// The shared scheduling core identifies a reminder by **where the task lives**:
// `myne.reminder.<noteId>.<lineIndex>`. That is exactly the right key for a diff
// — editing a task's wording must not orphan its registration — and exactly the
// wrong thing to hand an operating system. Anything placed in a registration is
// written into the platform's own persistence and, on Android, into a pending
// intent: a note identifier there is correlatable metadata sitting in plaintext
// outside the AEAD envelope, readable by the at-rest device adversary and by
// local malware (`threat-model.md` §7).
//
// ── The shape of the fix ───────────────────────────────────────────────────
//
// A **translating notifier**. The reconciliation pass keeps working entirely in
// locator space — it never learns that anything was renamed — and the swap
// happens at the one boundary where a value actually crosses into the platform.
// What the OS receives is 16 random bytes as hex: no prefix, no structure,
// nothing derived from the task, and a fresh one per registration.
//
// The map is **memory only**. Persisting `opaque → locator` would put the note
// identifier straight back into the plaintext store this exists to keep it out
// of, which would be the whole exercise undone in a file nobody reads.
//
// ── What that costs, stated plainly ────────────────────────────────────────
//
// The map does not survive the app being killed. On the next start `listPending`
// returns identifiers this session cannot attribute, so the pass sees them as
// orphans, cancels them, and registers the target again with fresh ones. That is
// **self-healing but not free**: one cancel-and-reschedule cycle per cold start.
// It is the correct trade — the alternative is a plaintext file mapping OS
// identifiers to notes — and it is why unknown identifiers are passed through
// unchanged rather than dropped: a registration this session cannot name is
// still one it must be able to withdraw.
//
// It also means a tapped identifier cannot be resolved back to a task after a
// cold start. Resolving a tap is **not this module's job** — see
// `reminderTap.ts` and the note recorded for the mobile task surface.

import type { MobileReminderNotifier, PendingReminder, ReminderPayload } from "./reminders";

/** Locator (`myne.reminder.…`) → the opaque identifier the platform holds. */
const opaqueByLocator = new Map<string, string>();
/** The reverse, for translating what the platform reports back. */
const locatorByOpaque = new Map<string, string>();

/** Bytes of randomness per registration. */
const OPAQUE_BYTES = 16;

/**
 * A fresh opaque identifier.
 *
 * Deliberately structureless: no `myne.` prefix, no counter, no timestamp.
 * Nothing about it should distinguish one registration from another beyond being
 * different, because the platform store is readable by an adversary who should
 * learn only how many reminders exist and when — never which is which.
 */
function mintOpaque(): string {
  const bytes = new Uint8Array(OPAQUE_BYTES);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The opaque identifier for a locator, minting one on first use. */
export function opaqueFor(locator: string): string {
  const existing = opaqueByLocator.get(locator);
  if (existing !== undefined) return existing;
  const minted = mintOpaque();
  opaqueByLocator.set(locator, minted);
  locatorByOpaque.set(minted, locator);
  return minted;
}

/** The locator behind an opaque identifier, or `null` if this session never minted it. */
export function locatorFor(opaque: string): string | null {
  return locatorByOpaque.get(opaque) ?? null;
}

/** Drop one mapping — after a cancel, so a later re-registration gets a new identifier. */
function forget(locator: string): void {
  const opaque = opaqueByLocator.get(locator);
  if (opaque === undefined) return;
  opaqueByLocator.delete(locator);
  locatorByOpaque.delete(opaque);
}

/**
 * Drop every mapping.
 *
 * Called on the lifecycle events that cancel every registration — the setting
 * turned off, the vault deleted, the password changed — and by tests. Keeping a
 * mapping for registrations that no longer exist would let a stale identifier
 * resolve to a task the user has since removed.
 */
export function resetReminderIdentity(): void {
  opaqueByLocator.clear();
  locatorByOpaque.clear();
}

/**
 * Wrap a notifier so that only opaque identifiers ever reach the platform.
 *
 * The pass above this speaks locators; the platform below it speaks opaque
 * identifiers; neither knows the other exists.
 */
export function opaqueNotifier(inner: MobileReminderNotifier): MobileReminderNotifier {
  return {
    async listPending(): Promise<readonly PendingReminder[]> {
      const held = await inner.listPending();
      return held.map((entry) => ({
        // An identifier this session cannot name is reported AS ITSELF, not
        // dropped: the target set will not contain it, so the pass cancels it —
        // which is exactly what should happen to a registration left behind by a
        // previous run of the app.
        id: locatorFor(entry.id) ?? entry.id,
        at: entry.at,
      }));
    },

    async schedule(payload: ReminderPayload): Promise<void> {
      await inner.schedule({ id: opaqueFor(payload.id), at: payload.at });
    },

    async cancel(id: string): Promise<void> {
      // Two kinds of id arrive here: a locator the pass wants withdrawn, and an
      // unattributable identifier `listPending` passed straight through. The
      // second must reach the platform untranslated or the orphan can never be
      // cleared.
      const opaque = opaqueByLocator.get(id);
      await inner.cancel(opaque ?? id);
      if (opaque !== undefined) forget(id);
    },

    async cancelAll(): Promise<void> {
      await inner.cancelAll();
      resetReminderIdentity();
    },
  };
}
