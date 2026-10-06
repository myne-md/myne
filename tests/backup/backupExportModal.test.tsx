// @vitest-environment jsdom
//
// The manual "Back up vault" path (myne-md/myne#817).
//
// `plugin:backup|vault_export_backup` takes a REQUIRED `vault_id: String`
// (myne-md/myne#250). The modal used to call `exportBackup(destination)` with
// no id, which sent `vaultId: null`, failed argument deserialization, and
// surfaced the "unknown failure" copy. This pins the fix at the call shape:
// the active vault id reaches the binding, and an unresolved id renders copy
// instead of invoking.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.hoisted(() => vi.fn());
const exportBackup = vi.hoisted(() => vi.fn());
const backupDefaultFilename = vi.hoisted(() => vi.fn());
const onBackupProgress = vi.hoisted(() => vi.fn());
const backupCancel = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/platform/dialog", () => ({ save }));
vi.mock("../../src/lib/vault-backup", () => ({
  backupCancel,
  backupDefaultFilename,
  exportBackup,
  onBackupProgress,
}));

import { BackupExportModal } from "../../src/components/backup/BackupExportModal";

beforeEach(() => {
  save.mockReset().mockResolvedValue("/tmp/out.myne-backup");
  exportBackup.mockReset().mockResolvedValue({ members: 1 });
  backupDefaultFilename.mockReset().mockResolvedValue("Myne backup.myne-backup");
  onBackupProgress.mockReset().mockResolvedValue(() => {});
  backupCancel.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("BackupExportModal vault target", () => {
  it("passes the active vault id to exportBackup", async () => {
    render(
      <BackupExportModal
        open
        vaultId="vid-1"
        onClose={() => {}}
        onOpenDrill={() => {}}
      />,
    );
    await waitFor(() =>
      expect(exportBackup).toHaveBeenCalledWith("/tmp/out.myne-backup", "vid-1"),
    );
  });

  it("renders copy and does not invoke when the vault id is unresolved", async () => {
    render(
      <BackupExportModal
        open
        vaultId={null}
        onClose={() => {}}
        onOpenDrill={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("backup-export.error")).toBeTruthy(),
    );
    expect(exportBackup).not.toHaveBeenCalled();
  });
});
