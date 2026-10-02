// The `myne://open-file` confirmation layer (myne-md/myne#788, task 12).
//
// A website can mint `myne://open-file` links, so this dialog is the control
// that stands between a link and the user's disk, not a courtesy: NOTHING
// opens until Confirm. The path shown is the host-resolved CANONICAL path
// (never the link's claim), because a confirmation that shows one file while
// opening another is worse than no confirmation at all.
//
// Cancel, Esc, the backdrop and the close button all write nothing: the
// request is simply dropped. The confirmed open re-validates gate, extension
// and size host-side, so nothing this component saw is trusted later.
//
// Mounted by `App` (so it can appear over any vault stage, including
// locked), which also drains the latch; this component is presentational
// plus the in-flight/error state of the one action.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { ModalShell, UNSOLICITED_MODAL_Z } from "../components/primitives/ModalShell";
import { plainFileOpenConfirmed } from "../platform/plainFile";

const BODY_STYLE: CSSProperties = {
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const QUESTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  margin: 0,
};

const PATH_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
  margin: 0,
  padding: "var(--space-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  overflowWrap: "anywhere",
};

const ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
};

interface OpenFileConfirmProps {
  /** The canonical path resolved host-side; the one thing Confirm acts on. */
  path: string;
  onClose: () => void;
}

export function OpenFileConfirm({ path, onClose }: OpenFileConfirmProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await plainFileOpenConfirmed(path);
      onClose();
    } catch {
      // The open re-validated and refused (the file moved, was deleted or
      // grew past the cap between resolve and confirm). Show a bounded
      // sentence and keep the dialog up; nothing sensitive is in the error.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      title={t("plainFile.deeplink.title")}
      onClose={onClose}
      labelId="plain-file-deeplink-title"
      closeLabel={t("plainFile.deeplink.cancel")}
      // Opened by an OS event rather than by the user, so it can land over an
      // already-open surface; the shared level would paint it under the
      // command palette while the focus trap still gave it the keyboard.
      zIndex={UNSOLICITED_MODAL_Z}
    >
      <div style={BODY_STYLE}>
        <p style={QUESTION_STYLE}>{t("plainFile.deeplink.body")}</p>
        <code data-testid="plain-file.deeplink.path" style={PATH_STYLE}>
          {path}
        </code>
        {failed && (
          <p style={ERROR_STYLE} data-testid="plain-file.deeplink.error">
            {t("plainFile.deeplink.failed")}
          </p>
        )}
        <div style={ACTIONS_STYLE}>
          <Button
            variant="secondary"
            data-testid="plain-file.deeplink.cancel"
            onClick={onClose}
          >
            {t("plainFile.deeplink.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="plain-file.deeplink.confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {t("plainFile.deeplink.confirm")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
