// `useAttachmentTransfers` — in-flight attachment transfer state for the sync
// progress UI (MYND-423).
//
// ⚠️ MOCK BACKEND (pending MYND-424): the resumable attachment transport exists
// server-side (myne-server/internal/attachments), but the client sync engine that
// drives uploads/downloads does not yet. This hook reads from a small in-memory
// registry the future engine will push to; today it is empty unless seeded (the
// component renders its empty state). When MYND-424 lands, the engine becomes the
// registry's writer — the hook + component API stay identical.

import { useEffect, useState } from "react";

/** Direction of an in-flight transfer. */
export type TransferDirection = "upload" | "download";

/** Lifecycle of a transfer. */
export type TransferStatus = "active" | "paused" | "done" | "error";

export interface AttachmentTransfer {
  /** Stable id (the attachment-id hex prefix is fine for display). */
  id: string;
  /** Human-readable name (the catalog filename). */
  name: string;
  direction: TransferDirection;
  /** Bytes transferred so far (resume-aware). */
  transferred: number;
  /** Total ciphertext bytes. */
  total: number;
  status: TransferStatus;
}

// --- mock registry (future: the MYND-424 sync engine is the writer) ---

let registry: AttachmentTransfer[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Seed/replace the mock transfer list (tests + the design preview only). */
export function __seedMockTransfers(transfers: AttachmentTransfer[]): void {
  registry = transfers;
  emit();
}

export function useAttachmentTransfers(): AttachmentTransfer[] {
  const [transfers, setTransfers] = useState<AttachmentTransfer[]>(registry);
  useEffect(() => {
    const update = () => setTransfers(registry);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return transfers;
}
