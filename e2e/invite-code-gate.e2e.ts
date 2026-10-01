// The invite-code admission gate, end-to-end against a REAL myne-server
// (myne-md/myne#800, decisions/sync/0625).
//
//   ic1-ic3: the server's own gate over HTTP. No code and a wrong code are
//             refused with distinguishing `error_code`s, and the correct code
//             registers. These need only the spawned server (no app), so they
//             are the deterministic half.
//   ic4: the client half. A sync config that carries an invite code prefills
//             the field in Settings then Sync through the real IPC read.
//
// The server gate is also covered by a Go test in `myne-server`; the E2E adds the
// wire shape the client actually sends and the client field round-trip.
//
// KDF: weak generator fixtures (params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported, uniqueAccountSeed } from "./support/sync-server";
import { launchDevice, syncConfigSeed } from "./support/multi-device";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  openSettings,
  dismissImporterOffer,
  unlockToEditor,
} from "./support/flows";

const INVITE = "e2e-invite-code-0000000000000001";
const serverSupported = syncServerSupported().ok;

/** A syntactically valid register body; the gate runs before the verifier is used. */
function registerBody(username: string, inviteCode?: string): string {
  return JSON.stringify({
    account_hash_hex: username,
    username,
    salt_hex: "11".repeat(16),
    iterations: 4096,
    stored_key_hex: "aa".repeat(32),
    server_key_hex: "bb".repeat(32),
    ...(inviteCode !== undefined ? { invite_code: inviteCode } : {}),
  });
}

async function postRegister(url: string, body: string): Promise<{ status: number; error?: string }> {
  const resp = await fetch(`${url}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  let error: string | undefined;
  try {
    const parsed = (await resp.json()) as { error_code?: string };
    error = parsed.error_code;
  } catch {
    // 200 returns `{"ok":true}` and no error_code; a parse failure is not the point.
  }
  return { status: resp.status, error };
}

describe.skipIf(!serverSupported)("ic · invite-code gate over the wire", () => {
  it("ic1: a missing code is refused with invite_code_required", async () => {
    const srv = await startSyncServer({ inviteCode: INVITE });
    try {
      const r = await postRegister(srv.url, registerBody("42".repeat(16)));
      expect(r.status).toBe(403);
      expect(r.error).toBe("invite_code_required");
    } finally {
      await srv.teardown();
    }
  });

  it("ic2: a wrong code is refused with invite_code_invalid", async () => {
    const srv = await startSyncServer({ inviteCode: INVITE });
    try {
      const r = await postRegister(srv.url, registerBody("43".repeat(16), "not-the-code"));
      expect(r.status).toBe(403);
      expect(r.error).toBe("invite_code_invalid");
    } finally {
      await srv.teardown();
    }
  });

  it("ic3: the correct code registers", async () => {
    const srv = await startSyncServer({ inviteCode: INVITE });
    try {
      // A unique hash so this file's scenarios cannot collide with each other.
      const hash = uniqueAccountSeed().replace(/[^0-9a-f]/g, "").padEnd(32, "0").slice(0, 32);
      const r = await postRegister(srv.url, registerBody(hash, INVITE));
      expect(r.status).toBe(200);
      expect(r.error).toBeUndefined();
    } finally {
      await srv.teardown();
    }
  });

  it("ic4: an open server ignores the field (self-host unchanged)", async () => {
    const srv = await startSyncServer();
    try {
      const r = await postRegister(srv.url, registerBody("44".repeat(16)));
      expect(r.status).toBe(200);
    } finally {
      await srv.teardown();
    }
  });
});

const uiSupported = harnessSupported().ok && serverSupported;

describe.skipIf(!uiSupported)("ic-ui · invite code in client settings", () => {
  it("ic5: a seeded invite code prefills the Settings then Sync field", async () => {
    const srv = await startSyncServer({ inviteCode: INVITE });
    let password = "";
    const a = await launchDevice(0, {
      seedConfig: syncConfigSeed(srv.url, INVITE),
      seed: (appDataDir) => {
        const v = seedVault(appDataDir, { password: "CanaryPass-9-animals!" });
        password = v.password;
      },
    });
    try {
      await unlockToEditor(a.session, password);
      await dismissImporterOffer(a.session);
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();
      const field = await a.session.byTestId("sync.endpoint-invite-input");
      expect(await field.attribute("value")).toBe(INVITE);
      await closeSettings(a.session);
    } finally {
      await a.teardown();
    }
  });

  it("ic6: enrolling with no invite code shows the required refusal inline", async () => {
    // The gated server refuses the NEW account; the client must name the remedy
    // rather than show the generic credential banner.
    const srv = await startSyncServer({ inviteCode: INVITE });
    let account = "";
    let password = "";
    const a = await launchDevice(0, {
      seedConfig: syncConfigSeed(srv.url),
      seed: (appDataDir) => {
        const v = seedVault(appDataDir, { password: "CanaryPass-9-animals!" });
        account = v.account;
        password = v.password;
      },
    });
    try {
      await unlockToEditor(a.session, password);
      await dismissImporterOffer(a.session);
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();
      await (await a.session.byTestId("sync.enroll.account-input")).sendKeys(account);
      await (await a.session.byTestId("sync.enroll.password-input")).sendKeys(password);
      await (await a.session.byTestId("sync.enroll.submit")).click();
      const banner = await a.session.byTestId("sync.enroll.error", { timeoutMs: 30_000 });
      expect(await banner.text()).toContain("invite code");
      expect(await banner.text()).not.toContain("password");
      await closeSettings(a.session);
    } finally {
      await a.teardown();
    }
  });
});
