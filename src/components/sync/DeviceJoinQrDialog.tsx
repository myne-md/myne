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
  const isPerson = variant === "person";
  const titleKey = isMember
    ? "sync.memberJoinQr.title"
    : isPerson
      ? "sync.personJoinQr.title"
      : "sync.deviceJoinQr.title";
  const testId = isMember
    ? "sync.member-join-qr.dialog"
    : isPerson
      ? "sync.person-join-qr.dialog"
      : "sync.device-join-qr.dialog";
  return (
    <ModalShell
      open={open}
      title={t(titleKey)}
      onClose={onClose}
      labelId={
        isMember
          ? "member-join-qr-title"
          : isPerson
            ? "person-join-qr-title"
            : "device-join-qr-title"
      }
      testId={testId}
    >
      <div style={BODY_STYLE}>
        <DeviceJoinQr showTitle={false} variant={variant} />
      </div>
    </ModalShell>
  );
}
