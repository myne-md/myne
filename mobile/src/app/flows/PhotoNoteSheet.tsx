// Photo to note: the reviewed draft between a photograph and a note
// (myne-md/myne#926).
//
// **Why a sheet at all.** The image is OCR'd at import, so by the time the user
// taps the entry the text exists only as an invisible search layer. Writing it
// into the note without showing it would put a machine's guess into prose nobody
// authored, and a wrong sentence in a note reads as something the user wrote.
// So the flow's centre is this surface: the photograph, its reading, an editable
// field, and one explicit commit.
//
// **The text is a DRAFT and this sheet is where that is decided**, not a
// formality. Every path out of here is a user action (commit, cancel, or the
// drawer's own dismiss, which cancels), and nothing is written before one.
//
// **Importing is its own phase, and it is the long one.** The image is imported
// through the ordinary attachment path, which runs PP-OCRv5 and can take seconds
// on a page-sized photo. The sheet therefore opens on the picked file (a local
// object URL) BEFORE the vault has an id for it, so the seconds are spent looking
// at the photograph rather than at a dimmed toolbar button. `reading` is then the
// short part: decrypting the cache entry the import just wrote.
//
// **Reading is a state, not a spinner over a dead form.** From `reading` onward
// the field is editable while the answer is in flight, and a reading that lands
// after the user has typed is OFFERED rather than dropped or forced in: replacing
// what they typed would discard the one correction the sheet exists to collect,
// and dropping it silently loses the page. The offer appends.
//
// **Plaintext.** The text is note-body class (AS1) plaintext held in this
// component's state while the sheet is open. It is rendered as inert editable
// text, never as markdown or HTML, and never logged. The caller (EditorFlow)
// owns the delete-on-cancel and the lock teardown, because it is the caller that
// created the attachment and knows whether a write already happened.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button, Segmented, Sheet, Spinner } from "../../components";
import { attachmentSrc } from "../../lib/attachmentRef";
import { attachmentReadExtractedText } from "../../lib/attachments";

/** Where the committed block lands: the note that is open, or a new one. */
export type PhotoNoteDestination = "note" | "new";

/**
 * The sheet's whole state machine.
 *
 *   importing  the file is being encrypted + OCR'd into the vault (no id yet)
 *   reading    the cache probe is in flight (the field is already usable)
 *   ready      a reading arrived; the field holds it (or the user's edit)
 *   empty      the probe found nothing, so the image can still be added alone
 *   off        the device-local OCR preference was off at import, so nothing
 *              was written and there is nothing to probe
 *   locked     the vault locked between the import and the read
 *   failed     the read itself failed (host IO), which is NOT an empty page
 *
 * `empty` and `failed` deliberately render the same OFFER (add the image alone)
 * with different sentences: a user who photographs a blank whiteboard and a user
 * whose disk read failed both need the same next action, and only the sentence
 * should differ.
 */
type Phase =
  | "importing"
  | "reading"
  | "ready"
  | "empty"
  | "off"
  | "locked"
  | "failed";

export function PhotoNoteSheet({
  attachmentId,
  filename,
  previewUrl,
  ocrEnabled,
  onCommit,
  onCancel,
  onOpenOcrSetting,
}: {
  /** The attachment this flow imported, or `null` while the import is running.
   *  The caller owns its lifetime. */
  attachmentId: string | null;
  /** Display filename, the sheet's heading. */
  filename: string;
  /** A local `blob:` URL for the picked file, so the photograph is on screen
   *  before the vault can serve it. `null` once the flow has no local copy. */
  previewUrl: string | null;
  /** The device-local `attachment_ocr_enabled` value AS THE IMPORT SAW IT, not
   *  the live preference. The cache entry was written (or skipped) inside the
   *  import, so a switch flipped afterwards cannot change what this photo has;
   *  reading the live value would re-probe a cache that was never written and
   *  replace the honest "reading is off" sentence with a false claim about the
   *  page. The caller freezes it at import for exactly that reason. */
  ocrEnabled: boolean;
  /** Commit `text` (possibly empty: the image-alone path) to a destination. */
  onCommit: (text: string, destination: PhotoNoteDestination) => Promise<void>;
  /** Abandon: the caller deletes the attachment this flow imported. */
  onCancel: () => void;
  /** Route to the setting that owns the OCR switch (Settings → Data). */
  onOpenOcrSetting: () => void;
}) {
  const { t } = useTranslation();
  // Frozen on the FIRST render, belt and braces with the caller: the cache entry
  // was written or skipped inside the import, so whatever the preference says
  // later, this photo was read or it was not. Taking the live prop would let a
  // flip re-probe a cache nobody wrote.
  const ocrEnabledAtImport = useRef(ocrEnabled);
  const enabled = ocrEnabledAtImport.current;
  const [phase, setPhase] = useState<Phase>(
    attachmentId === null ? "importing" : enabled ? "reading" : "off",
  );
  const [text, setText] = useState("");
  // The user typed while the read was in flight. The read must not overwrite it,
  // and must not vanish either: it waits here for an explicit "add".
  const editedRef = useRef(false);
  const [pendingReading, setPendingReading] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [destination, setDestination] = useState(0);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The import finished, so leave `importing`. Separate from the probe because
  // the id flips from null to a string on a re-render the probe must then react
  // to, and folding the two would re-run the probe on every unrelated render.
  useEffect(() => {
    if (attachmentId === null) return;
    setPhase((p) => (p === "importing" ? (enabled ? "reading" : "off") : p));
  }, [attachmentId, enabled]);

  useEffect(() => {
    if (attachmentId === null || !enabled) return;
    let cancelled = false;
    void attachmentReadExtractedText(attachmentId).then((read) => {
      if (cancelled || !mountedRef.current) return;
      switch (read.kind) {
        case "text":
          if (editedRef.current) setPendingReading(read.entry.text);
          else setText(read.entry.text);
          setTruncated(read.entry.truncated);
          setPhase("ready");
          break;
        case "none":
          setPhase("empty");
          break;
        case "locked":
          setPhase("locked");
          break;
        default:
          setPhase("failed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentId, enabled]);

  const commit = useCallback(
    async (value: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await onCommit(value, destination === 1 ? "new" : "note");
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, destination, onCommit],
  );

  const importing = phase === "importing";
  const canCommit = phase !== "locked" && !importing && !busy;
  // `failed` keeps the field: a correction typed during the read is still the
  // user's text, and hiding it while the commit sends it would write bytes the
  // surface was not showing. Showing it is also the honest state.
  const showsField =
    phase === "reading" || phase === "ready" || phase === "empty" || phase === "failed";
  const src = previewUrl ?? (attachmentId === null ? null : attachmentSrc(attachmentId));

  return (
    <Sheet
      onClose={onCancel}
      style={{ maxHeight: "92%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {/* `data-phase` publishes the state machine. A test that wants "after the
          read landed" has no other deterministic signal: `reading` and `ready`
          render the same field, so asserting on the field's value races the
          state update (the first version of that test went green with the guard
          removed, which is how the phase attribute came to exist). */}
      <div
        data-testid="photo-note.sheet"
        data-attachment-id={attachmentId ?? ""}
        data-phase={phase}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", flex: "none" }}
      >
        <span
          style={{
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={filename}
        >
          {filename}
        </span>
      </div>

      <div style={{ marginTop: "var(--space-3)", flex: 1, minHeight: 0, overflowY: "auto" }}>
        {/* The photograph stays visible in every state: it is the source of
            truth, and correcting the text without it is guesswork. */}
        {src !== null && (
          <img
            src={src}
            alt=""
            data-testid="photo-note.preview"
            style={{
              display: "block",
              width: "100%",
              maxHeight: "30vh",
              objectFit: "contain",
              borderRadius: "var(--radius-3)",
              background: "var(--bg-2)",
            }}
          />
        )}

        {importing && (
          <div
            data-testid="photo-note.importing"
            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)", color: "var(--fg-3)" }}
          >
            <Spinner />
            <span style={{ fontSize: "var(--text-sm)" }}>{t("photoNote.importing")}</span>
          </div>
        )}

        {phase === "reading" && (
          <div
            data-testid="photo-note.reading"
            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)", color: "var(--fg-3)" }}
          >
            <Spinner />
            <span style={{ fontSize: "var(--text-sm)" }}>{t("photoNote.reading")}</span>
          </div>
        )}

        {(phase === "empty" || phase === "failed") && (
          <p style={NOTE_TEXT} data-testid={`photo-note.${phase}`}>
            {t(phase === "empty" ? "photoNote.noText" : "photoNote.readFailed")}
          </p>
        )}

        {phase === "off" && (
          <div data-testid="photo-note.ocr-off" style={{ marginTop: "var(--space-3)" }}>
            <p style={NOTE_TEXT}>{t("photoNote.ocrOff")}</p>
            <Button
              variant="ghost"
              onClick={onOpenOcrSetting}
              data-testid="photo-note.open-ocr-setting"
              style={{ marginTop: "var(--space-1)" }}
            >
              {t("photoNote.ocrOffAction")}
            </Button>
          </div>
        )}

        {phase === "locked" && (
          <p style={NOTE_TEXT} data-testid="photo-note.locked">
            {t("photoNote.locked")}
          </p>
        )}

        {showsField && (
          <>
            <textarea
              data-testid="photo-note.text"
              aria-label={t("photoNote.textLabel")}
              value={text}
              onChange={(e) => {
                editedRef.current = true;
                setText(e.target.value);
              }}
              placeholder={t("photoNote.textPlaceholder")}
              spellCheck={false}
              style={{
                width: "100%",
                marginTop: "var(--space-3)",
                padding: "var(--space-3)",
                minHeight: "18vh",
                resize: "vertical",
                boxSizing: "border-box",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-base)",
                lineHeight: 1.55,
                color: "var(--fg-1)",
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-2)",
              }}
            />
            {/* A reading that arrived after the user started typing waits here
                instead of overwriting them or disappearing. */}
            {pendingReading !== null && (
              <div data-testid="photo-note.pending-reading" style={{ marginTop: "var(--space-2)" }}>
                <p style={NOTE_TEXT}>{t("photoNote.readingArrived")}</p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setText((current) => `${current.trimEnd()}\n\n${pendingReading}`);
                    setPendingReading(null);
                  }}
                  data-testid="photo-note.add-reading"
                  style={{ marginTop: "var(--space-1)" }}
                >
                  {t("photoNote.addReading")}
                </Button>
              </div>
            )}
            {/* Load-bearing honesty, and deliberately a plain sentence rather
                than the transcript's verbatim note: that one is about a machine
                hearing words, this one about a machine SEEING them, and reusing
                it would describe the wrong mechanism. */}
            <p style={NOTE_TEXT} data-testid="photo-note.honesty">
              {t("photoNote.machineText")}
            </p>
            {/* A head-only reading is a partial page presented as the page, so
                it says so where the other honesty claim lives. */}
            {truncated && (
              <p style={NOTE_TEXT} data-testid="photo-note.truncated">
                {t("photoNote.truncated")}
              </p>
            )}
          </>
        )}
      </div>

      {canCommit && (
        <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <Segmented
            options={[t("common.thisnote"), t("common.newnote")]}
            active={destination}
            onChange={setDestination}
            ariaLabel={t("photoNote.destinationLabel")}
            testIdPrefix="photo-note.destination"
          />
          <Button
            onClick={() => void commit(text)}
            disabled={phase === "reading" || busy}
            data-testid="photo-note.commit"
          >
            {destination === 1 ? t("photoNote.commitNew") : t("photoNote.commitNote")}
          </Button>
          {/* The escape hatch for a read that is slow, or a page whose text is
              not what the user wanted: the photograph alone is a legitimate
              outcome, and offering it here is cheaper than making the user wait
              for a reading they will delete.
              It sends the FIELD, not "": a user who typed a correction while
              waiting would otherwise lose their own words, which exist only in
              this component's state and have no snapshot to recover from. */}
          {phase === "reading" && (
            <Button
              variant="secondary"
              onClick={() => void commit(text)}
              data-testid="photo-note.image-only"
            >
              {t("photoNote.imageOnly")}
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel} data-testid="photo-note.cancel">
            {t("common.cancel")}
          </Button>
        </div>
      )}

      {(phase === "locked" || importing) && (
        <Button variant="secondary" onClick={onCancel} data-testid="photo-note.cancel">
          {t("common.cancel")}
        </Button>
      )}
    </Sheet>
  );
}

const NOTE_TEXT: CSSProperties = {
  margin: "var(--space-2) 0 0",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
};
