// The plain surface's in-app Open control (myne-md/myne#788, task 10b).
//
// The native Markdown-filtered dialog runs host-side (`plainFileOpenDialog`),
// so the picked file arrives through the same `plain-file:opened` event as
// every other ingress and no path ever reaches this component. A refusal is
// typed (the plugin's closed error enum); the kinds the dialog filter cannot
// prevent (an oversized file, a file the picker still allowed through) get a
// visible sentence here, because this is the one ingress where the user is
// looking at the app.
//
// Styling is token-bound (`docs/design/colors_and_type.css`), zero literals,
// so the control follows every built-in palette.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../components/primitives/IconButton";
import { plainFileOpenDialog } from "../platform/plainFile";

/** The Rust enum's internally-tagged variant name (`rename_all` on the enum). */
function errorKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function refusalKey(error: unknown): string {
  switch (errorKind(error)) {
    case "unsupported_extension":
      return "plainFile.openRefusedType";
    case "too_large":
      return "plainFile.openRefusedTooLarge";
    default:
      // Covers `gate_off` (the toggle went off while this tab stayed open),
      // `not_a_file`, `not_utf8` and any I/O failure: one calm sentence.
      return "plainFile.openFailed";
  }
}

export function OpenFileButton() {
  const { t } = useTranslation();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await plainFileOpenDialog();
    } catch (error) {
      setRefusal(t(refusalKey(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span style={{ marginLeft: "auto", display: "inline-flex", flexShrink: 0 }}>
        <IconButton
          icon="folder"
          label={t("plainFile.open")}
          tooltip
          bordered
          disabled={busy}
          testId="plain-file.open"
          onClick={() => void open()}
        />
      </span>
      {refusal !== null && (
        <span
          role="alert"
          data-testid="plain-file.open-error"
          style={{
            color: "var(--danger)",
            fontSize: "var(--text-xs)",
            whiteSpace: "nowrap",
          }}
        >
          {refusal}
        </span>
      )}
    </>
  );
}
