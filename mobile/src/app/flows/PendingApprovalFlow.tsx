// The `pending-approval` stage's screen (myne-md/myne#535, mobile half).
//
// It renders the join flow's own wait rather than a second implementation of it:
// the approval poll and the §6.3 fingerprint compare are one flow, and a copy
// here would be a second place "has an approval landed" is answered — the shape
// that left the two clients' compares drifted for months (`myne-md/myne#462`).
//
// What this wrapper adds is the one thing the flow cannot own: the vault is
// UNLOCKED on this stage, deliberately (the wait exists so a sync cycle can claim
// the token, and the claim needs `root_key`), and the idle auto-lock lives inside
// the editor. So the same hook the editor uses is armed here, for the same A6
// reason the web client's wait screen arms it (`design-notes/clients/0519`).
//
// The exits are the shell's: `onApproved` addresses the editor, `onMismatch` is
// the join flow's own un-enrol-then-leave, and `onCancel` locks and re-probes
// back to the unlock form.

import { JoinFlow } from "./JoinFlow";
import { usePrefs } from "../../lib/use-prefs";
import { useIdleAutoLock } from "../../hooks/useIdleAutoLock";
import type { VaultId } from "../../lib/stage";

export interface PendingApprovalFlowProps {
  vaultId?: VaultId;
  onApproved: (vaultId?: VaultId) => void;
  onCancel: () => void;
}

export function PendingApprovalFlow({ vaultId, onApproved, onCancel }: PendingApprovalFlowProps) {
  const { prefs } = usePrefs();
  // Idle re-lock for the one post-unlock screen that is not the editor. It locks
  // and then re-probes, which lands on the unlock form for this vault — the same
  // destination `onCancel` chooses, because a locked vault is a locked vault
  // whoever asked.
  useIdleAutoLock(onCancel, prefs.auto_lock_seconds);

  // The three doors the wait cannot reach: the recovered-join exit belongs to the
  // credential form, and the member/person QR arms to the scanner, neither of
  // which renders from the wait. No-ops rather than `onCancel` on purpose — a
  // door that somehow became reachable must not lock the vault as its answer.
  const notReachable = () => {};

  return (
    <JoinFlow
      initiallyPending
      initialVaultId={vaultId}
      onComplete={onApproved}
      onCancel={onCancel}
      onRecovering={notReachable}
      onMemberJoin={notReachable}
      onPersonJoin={notReachable}
    />
  );
}
