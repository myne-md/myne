// `useAccountStatus` — the authed `GET /account/status` projection surfaced to
// Settings → Sync (MYND-570). Wired to `plugin:sync|sync_account_status`.
//
// Read-at-rest only: the panel fetches once on mount. Refusal banners do NOT
// depend on this hook — a refused push carries its own reason + figures in the
// response body (`ErrBodyWire`), so there is no fetch on the refusal path where
// the §5.2 per-account limiter could answer 429 and mask the very 507 being
// explained.
//
// Degrades to `null` rather than an error state: a self-hosted or older server
// without the route simply has no usage block (server-protocol.md §7).

import { useEffect, useState } from "react";
import { invoke } from "../platform/core";

/**
 * The server's live projection of its own enforcement state for the calling
 * account. Ceilings are the RESOLVED effective values (`quota_override ??
 * plan ?? global default`), computed server-side by the same resolver the
 * enforcement guard uses — never raw overrides.
 *
 * `0` means **unlimited** for both ceilings (the server's existing convention
 * for `QuotaCeilingBytes` / `MYNE_MAX_DEVICES_PER_ACCOUNT`). It never means a
 * ceiling of zero, so a client must not render a meter against it.
 */
export interface AccountStatus {
  /** Deduplicated ciphertext bytes stored for this account (AS17 total). */
  stored_bytes: number;
  /** Effective storage ceiling in bytes; `0` = unlimited. */
  quota_bytes: number;
  /** Enrolled, non-retired devices. */
  device_count: number;
  /** Effective device cap; `0` = unlimited. */
  max_devices: number;
  /** Operator freeze: push + enroll blocked, pull never blocked. */
  frozen: boolean;
}

export interface AccountStatusHook {
  /** The projection, or `null` while loading and when unavailable. */
  status: AccountStatus | null;
  /** True once the first attempt resolved (either way) — gates the render. */
  settled: boolean;
}

/** `0` is the server's unlimited sentinel, not a real ceiling of zero. */
export function isUnlimited(ceiling: number): boolean {
  return ceiling === 0;
}

export function useAccountStatus(): AccountStatusHook {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invoke<AccountStatus | null>("plugin:sync|sync_account_status")
      .then((s) => {
        if (!cancelled) setStatus(s ?? null);
      })
      .catch(() => {
        // No endpoint (self-hosted / older server), not enrolled, or offline —
        // the block is absent, never an error. The engine reports transport
        // failure through its own status/banners.
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, settled };
}
