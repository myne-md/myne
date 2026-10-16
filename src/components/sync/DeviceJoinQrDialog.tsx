// The device-join QR dialog (myne-md/myne#831). The QR block used to sit as a
// full-width row under the Devices section; it is a rarely used action, so it
// is an icon in the Devices header that opens this dialog instead.
//
// Two variants share it (myne-md/myne): `account` is the owner's (paste the
// account number), `member` is a member's own second device (no input at all).
// The QR itself is `DeviceJoinQr` unchanged, with its own heading suppressed
// because the modal header carries the title.
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { DeviceJoinQr, type DeviceJoinQrVariant } from "./DeviceJoinQr";

const BODY_STYLE: CSSProperties = {
  padding: "var(--space-5)",
  overflowY: "auto",
};

export function DeviceJoinQrDialog({
  open,
  onClose,
  variant = "account",
}: {
  open: boolean;
  onClose: () => void;
  variant?: DeviceJoinQrVariant;
}) {
  const { t } = useTranslation();
  const isMember = variant === "member";
  return (
    <ModalShell
      open={open}
      title={t(isMember ? "sync.memberJoinQr.title" : "sync.deviceJoinQr.title")}
      onClose={onClose}
      labelId={isMember ? "member-join-qr-title" : "device-join-qr-title"}
      testId={
        isMember ? "sync.member-join-qr.dialog" : "sync.device-join-qr.dialog"
      }
    >
      <div style={BODY_STYLE}>
        <DeviceJoinQr showTitle={false} variant={variant} />
      </div>
    </ModalShell>
  );
}
