// @vitest-environment jsdom
//
// Component tests for `src/components/settings/VaultPanel.tsx`. Drives the
// three sub-views (idle / change-password / delete-vault) and the vault-label
// rename control, asserting the real handler wiring: callback fan-out on
// success, error-banner mapping, force-relock dispatch for the suspicion
// variants, and the disk-targeted vault-delete path. The two heavy child forms
// (PasswordChangeForm with its async zxcvbn meter; DeleteVaultConfirmForm) are
// stubbed to plain buttons so each test can fire their `onSubmit`/`onCancel`
// props deterministically — the unit under test is VaultPanel's orchestration,
// not the forms (which have their own tests).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── Mock the IPC-boundary lib wrappers + path helpers ──────────────────────
const changePassword = vi.fn();
const deleteVault = vi.fn();
const prefsRead = vi.fn();
const setVaultLabel = vi.fn();
const listVaults = vi.fn();
const memberVaultStatus = vi.fn();

vi.mock("../../src/lib/vault-change-password", () => ({
  changePassword: (...a: unknown[]) => changePassword(...a),
}));
vi.mock("../../src/lib/vault-delete", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/vault-delete")>(
    "../../src/lib/vault-delete",
  );
  return { ...actual, deleteVault: (...a: unknown[]) => deleteVault(...a) };
});
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setVaultLabel: (...a: unknown[]) => setVaultLabel(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));
vi.mock("../../src/lib/vault-list", () => ({
  listVaults: (...a: unknown[]) => listVaults(...a),
  orderByLastUnlock: (v: unknown[]) => v,
}));
// Keep every other export real; only the member-vault probe is driven.
vi.mock("../../src/lib/personAccount", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/personAccount")>()),
  memberVaultStatus: (...a: unknown[]) => memberVaultStatus(...a),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: () => Promise.resolve("/data"),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

// ── Stub the two child forms so we can drive their callbacks directly ──────
vi.mock("../../src/components/PasswordChangeForm", () => ({
  PasswordChangeForm: (props: {
    onSubmit: (a: string, b: string) => void;
    onCancel: () => void;
    inFlight?: boolean;
    error?: string | null;
  }) => (
    <div data-testid="pcf">
      <span data-testid="pcf.inflight">{String(props.inFlight)}</span>
      {props.error != null && <div data-testid="pcf.error">{props.error}</div>}
      <button data-testid="pcf.submit" onClick={() => props.onSubmit("cur", "new")}>
        submit
      </button>
      <button data-testid="pcf.cancel" onClick={props.onCancel}>
        cancel
      </button>
    </div>
  ),
}));
vi.mock("../../src/components/DeleteVaultConfirmForm", () => ({
  DeleteVaultConfirmForm: (props: {
    onSubmit: () => void;
    onCancel: () => void;
    onContinueAfterPartial: () => void;
    inFlight?: boolean;
    partialFailContext: { kind: string; remainingCount?: number } | null;
  }) => (
    <div data-testid="dvcf">
      <span data-testid="dvcf.inflight">{String(props.inFlight)}</span>
      {props.partialFailContext != null && (
        <div data-testid="dvcf.partial">{props.partialFailContext.kind}</div>
      )}
      <button data-testid="dvcf.submit" onClick={props.onSubmit}>
        submit
      </button>
      <button data-testid="dvcf.cancel" onClick={props.onCancel}>
        cancel
      </button>
      <button data-testid="dvcf.continue" onClick={props.onContinueAfterPartial}>
        continue
      </button>
    </div>
  ),
}));

import { VaultPanel } from "../../src/components/settings/VaultPanel";

const PREFS = { label: "" };

beforeEach(() => {
  changePassword.mockReset().mockResolvedValue(undefined);
  deleteVault.mockReset().mockResolvedValue(undefined);
  setVaultLabel.mockReset().mockResolvedValue(undefined);
  prefsRead.mockReset().mockResolvedValue({ ...PREFS });
  listVaults.mockReset().mockResolvedValue({ ok: [{ id: "v-active" }] });
  memberVaultStatus.mockReset().mockResolvedValue(false);
});

afterEach(cleanup);

function renderPanel(overrides: Partial<Parameters<typeof VaultPanel>[0]> = {}) {
  const props = {
    // #250: the panel no longer resolves its own target — the vault it erases
    // is threaded in from Settings, which got it from the Editor's stage.
    vaultId: "v-active" as string | null,
    onChangePasswordSuccess: vi.fn(),
    onDeleteVaultSuccess: vi.fn(),
    onInFlightChange: vi.fn(),
    onForceRelock: vi.fn(),
    ...overrides,
  };
  render(<VaultPanel {...props} />);
  return props;
}

describe("VaultPanel — idle view", () => {
  it("renders the change-password CTA + danger zone", async () => {
    renderPanel();
    expect(screen.getByTestId("settings.change-password-cta")).toBeTruthy();
    expect(screen.getByText("Delete vault…")).toBeTruthy();
    // The label loads from prefs on mount.
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
  });

  it("CTA switches to the change-password sub-view; Cancel returns to idle", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    expect(screen.getByTestId("pcf")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pcf.cancel"));
    expect(screen.queryByTestId("pcf")).toBeNull();
    expect(screen.getByTestId("settings.change-password-cta")).toBeTruthy();
  });
});

// The backend refuses change-password with `VaultNotUnlocked` whenever the vault
// slot is not unlocked, on any vault; it used to land in a default arm that only
// warned in DEV and left the form open (myne-md/myne#858).
describe("VaultPanel: member vault", () => {
  it("hides the owner password control and points at the shared-vault unlock", async () => {
    memberVaultStatus.mockResolvedValueOnce(true);
    renderPanel();
    await waitFor(() =>
      expect(screen.queryByTestId("settings.change-password-cta")).toBeNull(),
    );
    expect(memberVaultStatus).toHaveBeenCalledWith("v-active");
    expect(screen.getByTestId("settings.member-vault-notice")).toBeTruthy();
    expect(screen.queryByTestId("pcf")).toBeNull();
  });

  it("surfaces VaultNotUnlocked as a banner rather than a silent no-op", async () => {
    changePassword.mockRejectedValueOnce({ kind: "VaultNotUnlocked" });
    renderPanel();
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("pcf.error").textContent).toBe(
        "Unlock this vault before changing its password.",
      ),
    );
  });
});

describe("VaultPanel — change password", () => {
  it("success calls changePassword + onChangePasswordSuccess, returns to idle", async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    expect(changePassword).toHaveBeenCalledWith("cur", "new");
    await waitFor(() =>
      expect(props.onChangePasswordSuccess).toHaveBeenCalledTimes(1),
    );
    // Back to idle (form unmounted).
    expect(screen.queryByTestId("pcf")).toBeNull();
  });

  it("maps a banner error variant to copy without firing success", async () => {
    changePassword.mockRejectedValueOnce({ kind: "InvalidCredentialOrVault" });
    const props = renderPanel();
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("pcf.error").textContent).toBe(
        "Wrong current password or vault file is corrupted.",
      ),
    );
    expect(props.onChangePasswordSuccess).not.toHaveBeenCalled();
    // Stays on the form (banner shown).
    expect(screen.getByTestId("pcf")).toBeTruthy();
  });

  it("WeakNewPassword maps to its own banner copy", async () => {
    changePassword.mockRejectedValueOnce({ kind: "WeakNewPassword" });
    renderPanel();
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("pcf.error").textContent).toBe(
        "New password must be at least 12 characters.",
      ),
    );
  });

  it("InvalidVaultMeta routes to onForceRelock(Corrupted) with no banner", async () => {
    changePassword.mockRejectedValueOnce({ kind: "InvalidVaultMeta" });
    const onForceRelock = vi.fn();
    renderPanel({ onForceRelock });
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    await waitFor(() =>
      expect(onForceRelock).toHaveBeenCalledWith({ kind: "Corrupted" }),
    );
    expect(screen.queryByTestId("pcf.error")).toBeNull();
  });

  it("VaultMetaChangedExternally force-relocks with the suspicion reason", async () => {
    changePassword.mockRejectedValueOnce({ kind: "VaultMetaChangedExternally" });
    const onForceRelock = vi.fn();
    renderPanel({ onForceRelock });
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    await waitFor(() =>
      expect(onForceRelock).toHaveBeenCalledWith(
        { kind: "Exists" },
        "vault-meta-changed-externally",
      ),
    );
  });

  it("VaultLockedDuringChange force-relocks with its informational reason", async () => {
    changePassword.mockRejectedValueOnce({ kind: "VaultLockedDuringChange" });
    const onForceRelock = vi.fn();
    renderPanel({ onForceRelock });
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    await waitFor(() =>
      expect(onForceRelock).toHaveBeenCalledWith(
        { kind: "Exists" },
        "vault-locked-during-change",
      ),
    );
  });

  it("raises onInFlightChange(true) while the IPC is pending", async () => {
    let resolveIpc: () => void = () => {};
    changePassword.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolveIpc = res;
      }),
    );
    const onInFlightChange = vi.fn();
    renderPanel({ onInFlightChange });
    fireEvent.click(screen.getByTestId("settings.change-password-cta"));
    onInFlightChange.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId("pcf.submit"));
    });
    // The pending submit raised the in-flight flag.
    expect(onInFlightChange).toHaveBeenCalledWith(true);
    await act(async () => {
      resolveIpc();
    });
    await waitFor(() => expect(onInFlightChange).toHaveBeenCalledWith(false));
  });
});

describe("VaultPanel — delete vault", () => {
  it("Delete vault… opens the confirm sub-view; Cancel returns to idle", () => {
    renderPanel();
    fireEvent.click(screen.getByText("Delete vault…"));
    expect(screen.getByTestId("dvcf")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dvcf.cancel"));
    expect(screen.queryByTestId("dvcf")).toBeNull();
  });

  it("success targets the vault it was given + fires onDeleteVaultSuccess", async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByText("Delete vault…"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("dvcf.submit"));
    });
    expect(deleteVault).toHaveBeenCalledWith("v-active");
    await waitFor(() =>
      expect(props.onDeleteVaultSuccess).toHaveBeenCalledTimes(1),
    );
  });

  it("PartialDelete reject switches the form to post-fail mode", async () => {
    deleteVault.mockRejectedValueOnce({
      kind: "PartialDelete",
      detail: { remaining_count: 3 },
    });
    const props = renderPanel();
    fireEvent.click(screen.getByText("Delete vault…"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("dvcf.submit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("dvcf.partial").textContent).toBe(
        "partial-delete",
      ),
    );
    // Not yet a success — the user must click Continue.
    expect(props.onDeleteVaultSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dvcf.continue"));
    expect(props.onDeleteVaultSuccess).toHaveBeenCalledTimes(1);
  });

  // #250: an unresolved target is not a reason to erase something else. The
  // panel used to pass `undefined`, which the backend read as "the active
  // vault" — resolved from a cache the quick-unlock path never stamped.
  it("refuses to delete when no vault id has resolved", async () => {
    const props = renderPanel({ vaultId: null });
    fireEvent.click(screen.getByText("Delete vault…"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("dvcf.submit"));
    });
    expect(deleteVault).not.toHaveBeenCalled();
    expect(props.onDeleteVaultSuccess).not.toHaveBeenCalled();
  });

  it("bug-canary reject (VaultNotUnlocked) shows no post-fail banner, no success", async () => {
    deleteVault.mockRejectedValueOnce({ kind: "VaultNotUnlocked" });
    const props = renderPanel();
    fireEvent.click(screen.getByText("Delete vault…"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("dvcf.submit"));
    });
    // Stays on the idle confirm form; never a partial banner, never success.
    await waitFor(() => expect(deleteVault).toHaveBeenCalled());
    expect(screen.queryByTestId("dvcf.partial")).toBeNull();
    expect(props.onDeleteVaultSuccess).not.toHaveBeenCalled();
  });
});

describe("VaultPanel — vault label rename", () => {
  it("Save is disabled until the draft differs from the saved label", async () => {
    prefsRead.mockResolvedValue({ label: "Work" });
    renderPanel();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings.label-input") as HTMLInputElement).value,
      ).toBe("Work"),
    );
    const save = screen.getByTestId("settings.label-save") as HTMLButtonElement;
    // No diff yet → disabled.
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "Home" },
    });
    expect(save.disabled).toBe(false);
  });

  it("Save persists the trimmed draft and re-disables on success", async () => {
    renderPanel();
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "  My Vault  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.label-save"));
    });
    expect(setVaultLabel).toHaveBeenCalledWith("My Vault");
    const save = screen.getByTestId("settings.label-save") as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
  });

  it("an empty draft clears the label (null) on save", async () => {
    prefsRead.mockResolvedValue({ label: "Existing" });
    renderPanel();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings.label-input") as HTMLInputElement).value,
      ).toBe("Existing"),
    );
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.label-save"));
    });
    expect(setVaultLabel).toHaveBeenCalledWith(null);
  });

  it("Enter in the input triggers the save", async () => {
    renderPanel();
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "Renamed" },
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("settings.label-input"), {
        key: "Enter",
      });
    });
    expect(setVaultLabel).toHaveBeenCalledWith("Renamed");
  });

  // myne-md/myne#411. The device-local name cache does not sync, so another
  // device shows the name IT last decrypted until this vault is unlocked there.
  // That sentence is the whole mitigation for the window (clearing on
  // sync-head movement and a fixed expiry were both rejected), which is why it
  // is pinned here rather than left to review.
  it("no cross-device notice while the draft matches what is saved", async () => {
    prefsRead.mockResolvedValue({ label: "Existing" });
    renderPanel();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings.label-input") as HTMLInputElement).value,
      ).toBe("Existing"),
    );
    expect(screen.queryByTestId("settings.label-rename-notice")).toBeNull();
  });

  it("renaming surfaces the cross-device notice before the save lands", async () => {
    prefsRead.mockResolvedValue({ label: "Existing" });
    renderPanel();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings.label-input") as HTMLInputElement).value,
      ).toBe("Existing"),
    );
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "Renamed" },
    });
    const notice = screen.getByTestId("settings.label-rename-notice");
    expect(notice.textContent ?? "").toMatch(/other devices/i);
    expect(notice.textContent ?? "").toMatch(/earlier name/i);
    expect(notice.textContent ?? "").toMatch(/unlock/i);
  });

  it("does not claim an old name when there was never a name", async () => {
    // The gate is `labelChanged`, which is true on the FIRST naming of a
    // never-named vault: `savedLabel` starts "". The other devices are showing
    // `Vault N` there, not an old name, so copy that said "the old name" was
    // false in probably the most common use of the field.
    //
    // The fix broadened the copy rather than narrowing the gate, because
    // narrowing it would go quiet in a case that genuinely needs it:
    // `vault.prefs.label` syncs and the device-local stored copy does not, so a
    // vault whose label was cleared on THIS device can still be sitting under
    // its old name on another one, with `savedLabel` back at "".
    prefsRead.mockResolvedValue({ label: null });
    renderPanel();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings.label-input") as HTMLInputElement).value,
      ).toBe(""),
    );
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "First name" },
    });
    const notice = screen.getByTestId("settings.label-rename-notice");
    const text = notice.textContent ?? "";
    expect(text).toMatch(/other devices/i);
    expect(text).toMatch(/placeholder/i);
    // The sentence must not assert that an old name exists.
    expect(text).not.toMatch(/the old name/i);
  });

  it("CLEARING the name surfaces it too, which is the case it exists for", async () => {
    // Someone emptying the field is renaming precisely to get a name off a
    // screen. Silence here would be actively misleading, because the old name
    // is exactly what the other devices keep.
    prefsRead.mockResolvedValue({ label: "Tax Returns" });
    renderPanel();
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings.label-input") as HTMLInputElement).value,
      ).toBe("Tax Returns"),
    );
    fireEvent.change(screen.getByTestId("settings.label-input"), {
      target: { value: "" },
    });
    expect(screen.getByTestId("settings.label-rename-notice")).toBeTruthy();
  });
});
