// The device-join QR dialog (myne-md/myne#831). The QR block used to sit as a
// full-width row under the Devices section; it is a rarely used action, so it
// is an icon in the Devices header that opens this dialog instead.
//
// The QR itself is `DeviceJoinQr` unchanged, with its own heading suppressed
// because the modal header carries the title.
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { DeviceJoinQr } from "./DeviceJoinQr";

const BODY_STYLE: CSSProperties = {
  padding: "var(--space-5)",
  overflowY: "auto",
};

export function DeviceJoinQrDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell
      open={open}
      title={t("sync.deviceJoinQr.title")}
      onClose={onClose}
      labelId="device-join-qr-title"
      testId="sync.device-join-qr.dialog"
    >
      <div style={BODY_STYLE}>
        <DeviceJoinQr showTitle={false} />
      </div>
    </ModalShell>
  );
}
