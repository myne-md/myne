// Generic file attachment (MYND-173) — vault-count precondition: 1.
//
// Pins the generic (non-image/PDF) file attachment flow through the production
// binary end-to-end:
//   - a file whose bytes the magic-byte sniffer does NOT recognize imports
//     successfully as an opaque `application/octet-stream` attachment (the old
//     allowlist would have rejected it with `UnsupportedType`); and
//   - the new `attachment_export` command — invoked through the real
//     capability ACL — round-trips the DECRYPTED bytes byte-for-byte to a
//     user-chosen destination (the export-only "use" path: there is no inline
//     content preview for a generic file).
//
// What is driven vs. asserted:
//   - Import is page-seat IPC (`pageSeatInvoke`) because attachment import goes
//     through a native file picker WebDriver can't drive (the attachment-cleanup
//     precedent). The success payload's `content_type` is asserted = octet-stream.
//   - Export is asserted by invoking `attachment_export` to a container-temp
//     destination and reading the file back byte-for-byte (the `note-export`
//     precedent). The native save dialog itself is the picker WebDriver can't
//     drive, so the command is exercised directly with a known path; the
//     byte-identity of the written plaintext is the proof. (The dialog wiring is
//     unit-tested TS-side; intercepting `plugin:dialog|save` per the ne3 fetch-
//     seam template is a follow-up once the in-editor card UI is E2E-driven.)
//
// The in-editor file-card RENDER (its `attachment-card*` testids + overflow
// menu) is intentionally NOT forced into E2E: surfacing it needs the editor's
// catalog to reflect an IPC-side import, which is not robustly reachable through
// real UI here. Per `e2e/AGENTS.md` that state is a Vitest-DOM concern; the
// production testids are in place (`attachment-card`, `attachment-card.export`
// /`.rename`/`.remove`/`.reveal`) for when a UI-driving path lands.
//
// SYNC-13: the attachment-id + the file payload are scenario content, not
// credentials; no password/phrase appears in any assert. KDF: weak generator
// fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per
// `e2e/AGENTS.md` definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge (it introduces the
// `plugin:attachments|attachment_export` IPC path through the real ACL).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** Opaque bytes the magic-byte sniffer does NOT recognize → stored as
 *  application/octet-stream (the generic-file path, not the render allowlist). */
const DOC_BYTES: number[] = Array.from(
  new TextEncoder().encode("opaque generic file \u0000\u0001 contents — MYND-173"),
);

async function importGeneric(
  s: Session,
  filename: string,
): Promise<{ id: string; contentType: string }> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: DOC_BYTES, filename } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should accept a generic file").toBeUndefined();
  const ok = r.ok as { id: string; content_type: string };
  return { id: ok.id, contentType: ok.content_type };
}

describeE2E("generic file attachment (MYND-173)", () => {
  it("gf1 — a generic file imports as octet-stream and exports byte-for-byte", async () => {
    let seeded: SeededVault;
    await scenario(
      "gf1-generic-file",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // ---- a non-sniffable file imports as an opaque octet-stream attachment ----
        const { id, contentType } = await importGeneric(s, "quarterly-budget.docx");
        expect(
          contentType,
          "a file outside the render allowlist stores as octet-stream, not rejected",
        ).toBe("application/octet-stream");

        // ---- attachment_export round-trips the decrypted bytes to a chosen path ----
        const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "myne-gf-export-"));
        try {
          const destination = path.join(exportsDir, "exported.docx");
          const exp = await pageSeatInvoke(
            s,
            "plugin:attachments|attachment_export",
            { id, destination, overwrite: true },
            IPC_TIMEOUT,
          );
          expect(exp.err, "attachment_export should succeed").toBeUndefined();
          expect(
            Array.from(fs.readFileSync(destination)),
            "the exported plaintext is byte-identical to the imported file",
          ).toEqual(DOC_BYTES);
        } finally {
          fs.rmSync(exportsDir, { recursive: true, force: true });
        }
      },
    );
  });
});
