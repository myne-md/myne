// `<SaveStatus>` — BottomBar right-cluster component showing the
// `useAutosave` status. Visual canon: Penpot
// `screen------save-status-states` (frame id
// `01376058-0c2f-8002-8008-0662c3742739`).
//
// PRD stories 49-53 + Q11 (icon + text + live-tick + manual retry).
//
// 5 state renders + narrow-viewport icon-only fallback (~120px text
// budget threshold; falls back to dot/icon + tooltip).

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime, useTick } from "./relativeTime";
import type { SaveStatus as SaveStatusValue } from "../useAutosave";
import { isStorageFull } from "../../lib/storage-pressure";
import { StatusMark } from "../../components/Spinner";
import { ActionStatus } from "../../components/ActionStatus";

const ROOT_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-3)",
  maxWidth: 220,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const DOT_BASE_STYLE: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--fg-3)",
  flexShrink: 0,
};

const RETRY_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  margin: 0,
  font: "inherit",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--accent)",
  textDecoration: "underline",
  cursor: "pointer",
};

const SEP_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  margin: "0 4px",
};

/** The readout and the unsynced mark, spaced (myne-md/myne#603).
 *
 * The host supplied no spacing at all, which is how the mark came to be glued to
 * the last character on all three states that show one. It belongs here rather
 * than at the host, so every surface that mounts this inherits it.
 *
 * `--space-2` (8px) rather than the readout's own internal `6`, and the extra
 * two pixels are the point: inside the readout the gap separates parts of ONE
 * sentence, and this gap separates that sentence from a different fact. A mark
 * set at the same rhythm as the readout's own children would read as one more
 * of them. */
const GROUP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

export type SaveStatusProps = {
  status: SaveStatusValue;
  onRetry: () => void;
  /**
   * Whether the note this readout describes is **not yet on the server**
   * (phase3-web-client task 23).
   *
   * Rendered as a trailing marker rather than as a sixth `status` value, because
   * it is an orthogonal fact and folding it in would make the two mutually
   * exclusive: "Saved" and "not on the server" are simultaneously true for every
   * note in the seconds after a save, and that combination is exactly the one
   * the user needs to be able to see.
   */
  unsynced?: boolean;
};

export function SaveStatus({ status, onRetry, unsynced = false }: SaveStatusProps) {
  const { t } = useTranslation();
  // Sits OUTSIDE the readout rather than inside one of its six branches: the
  // save state and the sync state are independent, and every branch would
  // otherwise need the same trailing node.
  //
  // WRAPPED, and the wrapper is the fix rather than decoration
  // (myne-md/myne#603). This used to be a bare fragment, so the marker was a
  // flex sibling of whatever the bottom bar wrapped the item in, and that
  // wrapper (`Editor.tsx`'s right-cluster bar item) sets `align-items: center`
  // with no `gap`. The readout's own `gap: 6` is INTERNAL to its span and does
  // nothing for a sibling, so the mark butted straight against the last
  // character: `6 min ago▲`. One inline-flex container here owns the spacing
  // between the readout and the mark, on every host that mounts this.
  return (
    <span style={GROUP_STYLE}>
      <SaveStatusReadout status={status} onRetry={onRetry} />
      {/* `cloud-off`, and it never turns (myne-md/myne#603). It was the readout's
          own arc, which on `editing` put two identical grey marks a pixel apart
          meaning two different things: "autosave is armed" and "not on the
          server". It was then a solid triangle, which was distinct from the arc
          and depicted nothing, so it read as a bullet down a column of rows. A
          cloud with a slash says the sentence out loud: this note is not on the
          server.

          "Not on the server yet" is a state, not an activity: an edit made
          offline stays unsynced for as long as the device stays offline, and a
          marker rotating through all of that would be claiming work is in
          flight that is not. Same glyph and same size as the sidebar row's, so
          the two read as one fact seen twice rather than two facts. */}
      {unsynced && (
        <StatusMark
          name="cloud-off"
          testId="editor.unsynced-marker"
          label={t("notes.row.unsyncedLabel")}
          title={t("notes.row.unsyncedTitle")}
        />
      )}
      {/* The spoken half, and it is a SEPARATE, ALWAYS-MOUNTED node on purpose.
          The arc used to carry `role="status"` itself, which announced nothing:
          an `aria-live` region reports a CONTENT change, the arc has no text
          content, and it was mounted only while unsynced, so the region did not
          exist before the change it was meant to announce. This one is always in
          the tree and its text goes from empty to the phrase, which is the
          change a screen reader reports. Bottom bar only: the sidebar renders
          one marker per unsynced row, and a screenful of live regions
          re-labelled at once when a push starts is a storm nobody can mute. */}
      <ActionStatus
        visuallyHidden
        testId="editor.unsynced-announcement"
        message={unsynced ? t("notes.row.unsyncedLabel") : null}
      />
    </span>
  );
}

function SaveStatusReadout({ status, onRetry }: { status: SaveStatusValue; onRetry: () => void }) {
  const { t } = useTranslation();
  // Subscribe to the shared 30s tick so "Saved · N min ago" auto-updates.
  useTick();

  switch (status.status) {
    case "clean":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.saved")}
          title={t("notes.saveStatus.saved")}
        >
          <span style={DOT_BASE_STYLE} />
          {t("notes.saveStatus.saved")}
        </span>
      );

    case "editing":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.editing")}
          title={t("notes.saveStatus.editingTitle")}
        >
          {/* `circle-dashed`: a ring drawn in dashes, which is what "started and
              not closed" looks like. It was a three-quarter arc, which depicts
              nothing and was read as a spinner that had stopped
              (myne-md/myne#603).

              STATIC, not spinning (myne-md/myne#566). `AUTOSAVE_IDLE_MS` is one
              second, so `editing` is the state anyone typing is in for the whole
              of a writing session, and a mark turning through all of it is the
              looping ambient animation `docs/design/README.md` bans by name
              ("No looping animations. No subtle pulses on the encrypted-status
              indicator. The product is calm."). It is also the wrong sentence
              under this component's grammar: a still mark means work is
              OUTSTANDING and a turning one means work is IN FLIGHT, and text
              waiting on a debounce is outstanding. Motion is left to `saving`
              and `conflict`, which are bounded and short, and both of those draw
              `loader-circle` rather than this, so the two are never told apart
              by rotation alone. */}
          <StatusMark name="circle-dashed" label={null} />
          {t("notes.saveStatus.editingEllipsis")}
        </span>
      );

    case "saving":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.saving")}
          title={t("notes.saveStatus.savingEllipsis")}
        >
          {/* `loader-circle`, turning: the app's established in-flight glyph
              (`VaultSwitcher`, `AttachmentsLibrary`), so a disk write here reads
              the same as every other bounded operation in the product. A
              different icon from `editing`'s rather than the same one turning,
              because a state told apart by motion alone is told apart only to
              someone watching it (myne-md/myne#603). */}
          <StatusMark spinning tone="accent" name="loader-circle" label={null} />
          <span style={{ color: "var(--fg-1)" }}>
            {t("notes.saveStatus.savingEllipsis")}
          </span>
        </span>
      );

    case "saved": {
      const rel = formatRelativeTime(status.at);
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.savedRelative", { rel })}
          title={t("notes.saveStatus.savedRelative", { rel })}
        >
          <span style={DOT_BASE_STYLE} />
          {t("notes.saveStatus.saved")}
          <span style={SEP_STYLE}>·</span>
          {rel || t("common.justnow")}
        </span>
      );
    }

    case "error": {
      // Storage exhaustion gets its own words (phase3-web-client task 91).
      // "Save failed: click Retry" is advice that cannot work while the disk or
      // the origin's quota is full: the user would retry forever. And the
      // sentence that matters most is the one a generic failure never says —
      // an edit that could not be written locally is **also not on the server**,
      // so there is no second copy waiting to be recovered.
      const full = isStorageFull(status.error);
      return (
        <span
          data-testid="editor.save-status"
          data-storage-full={full ? "true" : undefined}
          style={{ ...ROOT_STYLE, color: "var(--warning)" }}
          aria-label={t(full ? "notes.saveStatus.storageFull" : "notes.saveStatus.saveFailed")}
          title={t(
            full ? "notes.saveStatus.storageFullTitle" : "notes.saveStatus.saveFailedTitle",
          )}
        >
          {/* `circle-x`, not a literal `✕` in an 8px box. The canon bans a
              unicode symbol standing in for an icon by name ("No unicode
              symbols as icons (e.g. ✓ ✗ →). Use Lucide's `check`, `x`,
              `arrow-right`"), and the old form also put a third glyph size into
              a readout that already had two. Inherits the span's `--warning`
              rather than taking a `tone`: the failure colour belongs to the
              whole readout here, not to the mark alone. */}
          <StatusMark
            name="circle-x"
            // Decorative: the very next span renders this same phrase as text.
            label={null}
            style={{ color: "inherit" }}
          />
          <span style={{ color: "var(--fg-1)" }}>
            {t(full ? "notes.saveStatus.storageFull" : "notes.saveStatus.saveFailed")}
          </span>
          <span style={SEP_STYLE}>·</span>
          <button type="button" style={RETRY_BUTTON_STYLE} onClick={onRetry}>
            {t("notes.saveStatus.retry")}
          </button>
        </span>
      );
    }

    // §11.3 keep-both in flight: the save lost to a sync pull; the buffer is
    // being preserved as a conflict copy and the pane re-based. Transient —
    // ends `clean` once the pulled body is adopted. Same moving affordance
    // as `saving` (work is happening, no action needed).
    case "conflict":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.conflict")}
          title={t("notes.saveStatus.conflictTitle")}
        >
          <StatusMark spinning tone="accent" name="loader-circle" label={null} />
          <span style={{ color: "var(--fg-1)" }}>
            {t("notes.saveStatus.conflict")}
          </span>
        </span>
      );
  }
}
