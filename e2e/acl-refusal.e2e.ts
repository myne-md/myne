// The capability ACL actually REFUSES (test-audit #42/#44).
//
// acl1 — a command the capability withholds is refused by the Tauri host, the
//        refusal names the permission that would have granted it, and the
//        refusal has TEETH: the withheld effect does not happen.
//
// WHY THIS SCENARIO EXISTS. Every existing capability test in this repo checks
// what `src-tauri/capabilities/*.json` DECLARES — that a permission is listed,
// that the JSON is shaped right, that the UI's capability descriptor and the
// web dispatcher's refusal table agree. Not one of them observes Tauri
// enforcing any of it. That is a gap of exactly the kind the repo's own rule
// warns about ("verifying a guard means breaking it"): the ACL is a
// security-load-bearing file (`src-tauri/AGENTS.md`) whose enforcement had
// never been seen, only assumed. A capability file that stopped being wired to
// the runtime at all — a build-time regression, a Tauri upgrade changing how
// capabilities resolve — would leave every existing test green.
//
// It cannot be a Vitest test. The ACL lives in the Rust host and is applied on
// the IPC path; only the production bundle over real IPC can be refused by it.
//
// WHY `window.close` IS THE PROBE. The default capability grants
// `core:window:default` plus TWO explicit mutators, `allow-destroy` and
// `allow-start-dragging`, and deliberately does not grant `allow-close`.
// (`allow-show` was a third until myne-md/myne#483 removed it: its one consumer,
// the reveal after idle auto-lock, now asks the host for a fixed
// protect/show/protect/focus sequence instead of driving the window itself. It
// was also this scenario's positive control, which is why the control below is
// now `is_visible`.) That asymmetry is what makes this a test of the ACL rather
// than of the plugin's presence: the same plugin answers a granted sibling in
// the same run. `src/platform/app-exit.ts` calls `destroy()` rather than
// `close()` for exactly this reason, so the withheld permission is a live
// product decision, not an oversight this scenario would be pinning.
//
// WHY THE ASSERTION IS ON THE MESSAGE. An IPC call can fail for reasons that
// have nothing to do with the ACL — a bad argument shape, a missing plugin, a
// panicking handler — and a test that only asserted "it rejected" would pass on
// every one of them, including on a build where the ACL was not applied at all.
// The denial this build produces names its own source:
//
//     Command plugin:window|close not allowed by ACL
//
// so the assertion anchors on BOTH halves — the exact command that was refused,
// and the words "not allowed by ACL". Neither can be produced by a
// deserialization failure, which is what makes this unfakeable.
//
// (Recorded because it cost a run to find out: this is NOT the verbose format
// in `tauri-2.11.5/src/ipc/authority.rs` — `<cmd> not allowed. Permissions
// associated with this command: <list>` — which is what reading the crate
// suggests and which does not name the ACL at all. The short form above is what
// actually reaches the page. Assert against what the binary emits, not against
// what the source of a dependency looks like it will emit.)
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta). SYNC-13: no credential reaches an assertion here.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";

/** The withheld one. Granted siblings in the same capability: destroy, show,
 *  start-dragging. */
const WITHHELD = "plugin:window|close";
/** The granted one, and harmless against an already-visible window. Its job is
 *  to prove the plugin is registered and page-seat IPC reaches it, so a refusal
 *  of the sibling cannot be "the whole plugin is missing". */
// A READ inside `core:window:default`, chosen over a mutator so the control
// cannot itself change what the scenario is observing. It must stay a command
// the default bundle grants: this is the half that proves a refusal below is
// the ACL refusing rather than the plugin being absent.
const GRANTED = "plugin:window|is_visible";

describeE2E("acl1 the capability ACL refuses a withheld command (test-audit #42/#44)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("answers a granted window command, refuses the withheld sibling by name, and the window survives", async () => {
    let password = "";
    await scenario(
      "acl1-capability-refusal",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // 1. CONTROL — the granted sibling resolves. Without this, a refusal
        //    below would be equally consistent with "the window plugin is not
        //    registered in this build", which is not what is being tested.
        const granted = await pageSeatInvoke(s, GRANTED, {}, 20_000);
        expect(
          granted.err,
          `${GRANTED} is granted by the default capability and must resolve`,
        ).toBeUndefined();

        // 2. REFUSAL — the withheld sibling is rejected, and the rejection says
        //    which permission was missing. Both halves are asserted; see header.
        const refused = await pageSeatInvoke(s, WITHHELD, {}, 20_000);
        expect(refused.err, `${WITHHELD} is NOT granted and must be refused`).toBeDefined();
        const message = String(refused.err);
        expect(message, "the refusal must name the ACL as its source").toContain(
          "not allowed by ACL",
        );
        expect(message, "the refusal must be about the command actually sent").toContain(
          WITHHELD,
        );

        // 3. TEETH — the refusal actually stopped the effect. A refused
        //    `window.close` that closed the window anyway would satisfy both
        //    assertions above and be a total failure of the boundary, so the
        //    surviving window is the assertion that matters most: the app's own
        //    chrome is still on screen and the same IPC seat still answers.
        //
        //    NOT `editor.content`. This scenario seeds a vault with NO notes,
        //    and with nothing open the editor pane renders the note switcher
        //    rather than a CodeMirror document — so that testid never mounts,
        //    and waiting for it timed out for a reason that had nothing to do
        //    with the ACL. The sidebar's `+` is present on every unlocked
        //    vault, notes or not.
        await s.byTestId("notes.new-menu");
        const stillThere = await pageSeatInvoke(s, GRANTED, {}, 20_000);
        expect(
          stillThere.err,
          "the window survived the refused close and still answers IPC",
        ).toBeUndefined();
      },
    );
  });
});
