// Inline attachment TEXT preview suite (MYND-268 Tier-1, PR #98
// polish/editor-outline; widget `editor/src/attachments/widgets.ts`
// `AttachmentTextPreviewWidget`, backend `attachment_read_text` in
// `src-tauri/src/plugins/attachments/read_text.rs`).
//
// Pins the Tier-1 flow through the production binary: a `.txt` attachment
// (stored as `application/octet-stream`, MYND-173) embedded form-C in a note
// renders an INLINE READ-ONLY preview — the widget decrypts the plaintext via
// the real `attachment_read_text` IPC (through the real capability ACL, the
// PR's a9c46e3 grant) and shows it in an inert `<pre>`; the card is
// `contenteditable="false"` (CM6 marks non-editable widget DOM), so the
// decrypted text cannot be edited in place.
//
// What is driven vs. asserted:
//   - Import is page-seat IPC (`pageSeatInvoke`) because attachment import
//     goes through a native file picker WebDriver can't drive (the gf1 /
//     attachment-cleanup precedent). The import happens BEFORE the note is
//     created: the editor's attachment catalog loads once per editor mount
//     (catalog.ts), so the fresh mount that opens the new note sees the row.
//   - The form-C embed `![[att:<id>|name.txt]]` is typed through the real
//     real `note_update` IPC via `seedEmbedIntoNote`, then the note is
//     reopened so the fresh editor mount loads a catalog that HAS the import.
//     Not typed: driving `![[` through WebDriver races CodeMirror's bracket
//     auto-close, which cost four CI rounds (see that helper's header).
//   - The preview body is asserted by the CARD's own textContent carrying the
//     decrypted marker (element-scoped — the raw embed alias can't satisfy it,
//     the widget replaced that range).
//
// SCOPE NOTE (honest): the shipped widget has NO expand/collapse affordance —
// the Tier-1 preview renders inline unconditionally (loading chip → body;
// failure degrades to the file-card header). There is therefore no
// expand/collapse step to drive; this pins render + decrypt + read-only.
//
// SYNC-13: the attachment payload/filename are scenario content, not
// credentials. KDF: weak generator fixture (unlock reads params from
// vault.meta).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  seedEmbedIntoNote,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";


const IPC_TIMEOUT = 15_000;

/** Distinctive decrypted-content marker (single alnum token — survives the
 *  inert `<pre>` verbatim; only the DECRYPT round-trip can put it on screen). */
const MARKER = "tierbironizlemeicerik7k2m9w";
const FILENAME = "deneme-notlari.txt";
const FILE_TEXT = `${MARKER}\nikinci satir govde metni`;

/** Import the fixture .txt as an attachment from the page seat (the gf1
 *  pattern — real IPC, zero test hooks) and return its catalog id. */
async function importTxt(s: Session): Promise<string> {
  const bytes = Array.from(new TextEncoder().encode(FILE_TEXT));
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes, filename: FILENAME } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should accept the .txt file").toBeUndefined();
  return (r.ok as { id: string }).id;
}


// QUARANTINED (flaky-test epic): the #1 cross-branch flake — the
// `attachment-text-preview` widget mount timed out on a contended CI runner
// across 6 unrelated branches (none touching attachments), i.e. host
// resource starvation, not a preview bug. Runs in the non-blocking
// `e2e-quarantine` step until the contention fix lands. See scenario.ts's gate note.
// DE-QUARANTINED (myne-md/myne#555). The quarantine reason was
// runner contention, and it was wrong for the same reason it was wrong for
// `nav1`: the first seeding test in a vitest process builds `e2e-fixture-gen`
// with `cargo build --release` INSIDE its own budget, ~171 s against a 180 s
// `testTimeout`. Which spec paid it depended only on which one seeded first,
// which is why the victim moved between runs and read as a loaded host.
// `e2e/support/global-setup.ts` now pays that build once per vitest invocation,
// before any worker starts. Measured after the fix, `--retry=0`, warm
// container: 16 consecutive clean runs, which is the bar `e2e/AGENTS.md` sets.
describeE2E("tp1 inline txt attachment preview decrypts read-only (MYND-268)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a form-C .txt embed renders the decrypted text inline, non-editable", async () => {
    let password = "";
    await scenario(
      "tp1-attachment-text-preview",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Import FIRST (page-seat IPC), THEN open a fresh note: the catalog
        // loads once per editor mount, so this ordering is what makes the
        // embed resolve instead of tombstoning (catalog.ts contract).
        const id = await importTxt(s);

        await createNote(s, "Onizleme Notu");
        await seedEmbedIntoNote(s, `![[att:${id}|${FILENAME}]]`);

        // The Tier-1 widget mounts…
        await s.byTestId("attachment-text-preview");
        // …and its body fills with the DECRYPTED plaintext once the real
        // `attachment_read_text` round-trip lands (loading chip → <pre>).
        // Element-scoped read: the card's own textContent, so a raw
        // (unreplaced) embed alias could never satisfy this.
        await s.waitUntil(
          async () => {
            const card = await s.waitForElement(
              testIdSelector("attachment-text-preview"),
              { timeoutMs: 2_000 },
            );
            return (await card.textContent()).includes(MARKER) ? true : null;
          },
          { label: "decrypted preview text visible in the card", timeoutMs: 30_000 },
        );

        // Header chrome carries the filename (the file-card chrome the
        // preview extends), and the widget is READ-ONLY: CM6 stamps
        // non-editable widget DOM contenteditable=false, so the decrypted
        // text is inert — not part of the editable document surface.
        const card = await s.byTestId("attachment-text-preview");
        expect((await card.textContent()).includes(FILENAME)).toBe(true);
        expect(await card.attribute("contenteditable")).toBe("false");
      },
    );
  });
});
