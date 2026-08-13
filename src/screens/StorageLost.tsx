// The local copy went away underneath a live session (phase3-web-client task 22).
//
// # Why this is not `FailClosedError`
//
// `FailClosedError`'s contract is one reason, one CTA, no detail — the right
// shape for "we cannot safely continue and you must quit". This is a different
// situation with a different honest answer, and two of its parts do not fit that
// contract at all: it has to **list** what was lost before offering to proceed,
// and on a client whose local store is a cache of a server-held vault the remedy
// is a real, safe action rather than a dead end.
//
// # The two states it renders, and why they are not merged
//
// * **Evicted** — the container is gone. On a browser this is an origin
//   eviction under storage pressure: the user did nothing, nothing is damaged,
//   and every synced byte is on the server. Calling this "corrupted" (which is
//   what a boot-vocabulary-only client would do) sends someone looking for a
//   backup of something that is intact.
// * **Unopenable** — the container is there and `vault.meta` cannot be read as
//   one. On a double-buffered store that means BOTH copies failed, not that the
//   newest write was torn — the seam already falls back. Task 18 stops at the
//   fallback and says nothing about this case; task 22's fourth criterion is
//   that it must not be a dead end, and this is where it stops being one.
//
// # What is honest about the unsynced list
//
// The notes named here are **gone**, not pending. They were never on the server
// and their only copy was the store that just vanished. The screen says that in
// those words rather than offering a recovery it cannot perform. The list comes
// from the last answer `useUnsyncedEdits` had before the loss — a browser cannot
// read an evicted store to find out afterwards, and the running session's own
// memory is the only place that knowledge still exists.
//
// # Identity, and why "no user action beyond unlocking" is not achievable
//
// Task 22's fifth criterion asks the eviction path to "preserve or legibly
// re-establish device identity". Preservation is impossible: `device_id` lives
// in `sync-state.json` inside the evicted container (task 37's decision), so
// eviction takes it with everything else. What is left is the legible half —
// this browser re-enrols as a NEW device and lands **pending** until an existing
// device approves it, and the screen says so BEFORE the user commits, rather
// than letting them discover it on a waiting screen they did not expect.

import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
  ctaHover,
  ctaStyle,
} from "../components/primitives/CenteredCard";
import { has } from "../platform/capabilities";

export type StorageLostKind = "evicted" | "unopenable";

export interface StorageLostProps {
  kind: StorageLostKind;
  /**
   * Titles (or ids, when a title was never loaded) of notes the server had not
   * acknowledged when the loss was detected. Empty is the good case and is
   * stated as such — silence would read as "we did not check".
   */
  unsyncedTitles: string[];
  /**
   * Discard what is left of the local store and start over from the server.
   * Offered only where the vault is server-held; a client whose local copy IS
   * the vault must never be handed an erase button on a storage fault.
   */
  onReDownload: () => void;
  /** Lock and re-probe — the answer for a client with no server to fall back on. */
  onLock: () => void;
}

const LIST_STYLE: CSSProperties = {
  ...CARD_BODY_STYLE,
  margin: "var(--space-2) 0",
  paddingInlineStart: "var(--space-5)",
  maxHeight: 180,
  overflowY: "auto",
};

/** The shared card CTA, sized to its label rather than to the card. Was a
 *  byte-for-byte copy of `ctaStyle()` — three of them, in three files — which is
 *  how all three silently missed the hover/press feedback when it landed. */
const CTA_STYLE: CSSProperties = {
  ...ctaStyle(false),
  marginTop: "var(--space-2)",
  alignSelf: "flex-start",
};

/** How many titles to name before summarising. A wall of 300 rows is not a
 *  report, and the count carries the weight past a handful anyway. */
const MAX_NAMED = 12;

export function StorageLost({ kind, unsyncedTitles, onReDownload, onLock }: StorageLostProps) {
  const { t } = useTranslation();
  // The re-download door exists only where the vault is server-held. On a
  // local-only client the same storage fault means the notes are simply gone,
  // and an "erase and re-download" button would be an offer the platform cannot
  // honour — the same rule that keeps "Restore from a backup" off the web
  // client's fail-closed screen, applied in the other direction.
  const serverHeld = !has("localOnlyVault");
  const named = unsyncedTitles.slice(0, MAX_NAMED);
  const overflow = unsyncedTitles.length - named.length;

  return (
    <CenteredCard>
      <div
        role="alert"
        aria-live="assertive"
        data-testid="storage-lost.root"
        data-kind={kind}
        style={{ display: "contents" }}
      >
        <h1 style={CARD_TITLE_STYLE} data-testid="storage-lost.title">
          {t(kind === "evicted" ? "storageLost.evicted.title" : "storageLost.unopenable.title")}
        </h1>
        <p style={CARD_BODY_STYLE}>
          {t(kind === "evicted" ? "storageLost.evicted.body" : "storageLost.unopenable.body")}
        </p>

        {unsyncedTitles.length === 0 ? (
          // Said out loud rather than left blank. "Nothing was lost" is the
          // single most useful sentence on this screen when it is true, and an
          // empty space where a list would go reads as "we did not look".
          <p style={CARD_BODY_STYLE} data-testid="storage-lost.all-synced">
            {t("storageLost.allSynced")}
          </p>
        ) : (
          <>
            <p style={CARD_BODY_STYLE} data-testid="storage-lost.unsynced-intro">
              {t("storageLost.unsyncedIntro", { count: unsyncedTitles.length })}
            </p>
            <ul style={LIST_STYLE} data-testid="storage-lost.unsynced-list">
              {named.map((title, i) => (
                <li key={`${title}-${i}`} data-testid="storage-lost.unsynced-item">
                  {title}
                </li>
              ))}
            </ul>
            {overflow > 0 && (
              <p style={CARD_BODY_STYLE} data-testid="storage-lost.unsynced-overflow">
                {t("storageLost.unsyncedOverflow", { count: overflow })}
              </p>
            )}
          </>
        )}

        {serverHeld ? (
          <>
            {/* Stated before the button, not after: re-enrolling lands this
                browser pending until another device approves it, and finding
                that out afterwards is how a routine recovery turns into a
                user believing they are locked out. */}
            <p style={CARD_BODY_STYLE} data-testid="storage-lost.reenrol-notice">
              {t("storageLost.reEnrolNotice")}
            </p>
            <button
              type="button"
              onClick={onReDownload}
              style={CTA_STYLE}
              {...ctaHover(false)}
              data-testid="storage-lost.redownload-cta"
            >
              {t("storageLost.reDownloadCta")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onLock}
            style={CTA_STYLE}
            {...ctaHover(false)}
            data-testid="storage-lost.lock-cta"
          >
            {t("storageLost.lockCta")}
          </button>
        )}
      </div>
    </CenteredCard>
  );
}
