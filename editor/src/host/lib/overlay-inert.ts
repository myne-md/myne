// One owner for `inert` while an overlay is open (myne-md/myne#728, task 8).
//
// Every dialog in this tree says `aria-modal="true"` and traps Tab, and both
// are real. Neither is the same thing as the background being INERT. A focus
// trap contains the Tab key; it does not stop a screen reader's virtual cursor
// from reading the page behind the dialog, it does not stop a click-to-focus
// from landing back there, and `aria-modal` is an assertion some assistive
// technology honours and some ignores. `inert` is the browser-enforced version
// of the same claim: the subtree stops being focusable, clickable and
// reachable by assistive technology at once.
//
// Why ONE owner rather than each overlay setting it:
//
//   - `inert` must go on the SIBLINGS of the overlay at every level up to the
//     body, never on an ancestor of it. Get that wrong and the overlay inerts
//     itself, which is silent: the dialog renders, looks right, and refuses
//     every click.
//   - Overlays nest (the vault switcher opens a confirm dialog; settings opens
//     an export modal). Two independent owners would each restore on close and
//     the second restore would undo the first one's state. A stack has one
//     answer: whatever is on top owns the page.
//   - A subtree can be inert for its OWN reason, and the collapsed sidebar
//     already is. An owner that removed the attribute on teardown without
//     knowing who set it would silently un-inert a collapsed pane, so only
//     elements this module marked are unmarked here.
//
// Module-scope rather than a React context, so an overlay mounted through a
// portal outside every provider can still register. Nothing outside React
// uses that today and the header used to claim otherwise, which is the
// documented-but-unwired shape this repository treats as its own defect
// class: a module doc that asserts coverage nobody has.
//
// WHAT REGISTERS, and what deliberately does not:
//
//   - `ModalShell`, and through it every dialog built on it. Plus the three
//     carve-outs that call `useFocusTrap` directly (`SettingsModal`,
//     `CommandPalette`, `QuickPicker`) and the eleven dialogs that build
//     their own backdrop and never went through the shell at all:
//     `TrashPanel`, `ArchivePanel`, `SnapshotsPanel`, `RecoveredNotes`,
//     `NoteExportModal`, `NotePdfExportNotice`, `ExportEgressNotice`,
//     `ObsidianImportModal`, `ImporterOnboardingOffer`, `JoinDeviceModal`.
//
//     Those eleven are here because the review of this pass found that this
//     header claimed them and the code did not: four surfaces registered out
//     of seventeen carrying `aria-modal`, under a comment reading "and
//     through it every dialog built on it". That is the exact
//     documented-but-unwired shape named two paragraphs up, in the file that
//     names it. `tests/a11y/overlayInert.test.tsx` now scans for
//     `aria-modal` across `src/` and fails on any site that neither
//     registers nor carries a written reason, so the next dialog cannot
//     repeat it and this list cannot go stale again.
//   - `ContextMenu` and `VaultSwitcher` do NOT, and that is a decision rather
//     than a gap: both are MENUS, dismissed by clicking outside them, and an
//     inert background does not receive pointer events, so inerting it would
//     break their primary mouse exit. They are keyboard-operable instead
//     (focus in on open, arrows, Escape restoring focus).
//   - `ScopeExpansionDialog` does NOT, and that is a decision: it renders
//     INLINE inside the agent panel rather than over the page, so there is no
//     background to inert. (Its `aria-modal` is questionable on the same
//     grounds and predates this pass; left alone rather than widened here.)
//   - The imperative modals (`imperative-modal.ts`, which `promptForText`,
//     the attachment rename prompt, the diff-preview, the wikilink converter,
//     the attachment lightbox and the task-field editors all build on) DO
//     register as of this pass: `openModal` pushes its backdrop on mount and
//     pops it in its idempotent `close`. That is why this module lives in the
//     editor package with `src/lib/overlay-inert.ts` as a re-export shim: one
//     module instance, so a React overlay and a vanilla-DOM one share one
//     stack, and the shared skeleton is the one place the guarantee has to
//     live rather than each caller remembering to register.

/**
 * Marks an element that must stay reachable even while an overlay owns the
 * page. Set by the element itself, read only here, so the exemption lives at
 * the surface that needs it rather than as a list in this module that would
 * drift from it.
 *
 * Deliberately NOT a general escape hatch: `tests/a11y/overlayInert.test.tsx`
 * holds the set of users to the one the threat model requires, so a second
 * one costs a reviewer's argument.
 */
export const KEEP_REACHABLE_ATTR = "data-overlay-keep-reachable";

/** Open overlays, innermost last. The last entry owns the page. */
const stack: HTMLElement[] = [];

/** Elements THIS module marked inert, so teardown restores exactly those. */
let marked: HTMLElement[] = [];

function unmarkAll(): void {
  for (const el of marked) el.removeAttribute("inert");
  marked = [];
}

/**
 * Re-derive the inert set from the current top of the stack.
 *
 * The walk goes from the topmost overlay up to `document.body`, marking every
 * sibling on the way. It never touches the path itself, which is what keeps an
 * overlay from inerting its own ancestors.
 */
function apply(): void {
  unmarkAll();
  const top = stack[stack.length - 1];
  if (top === undefined || !top.isConnected) return;

  const next: HTMLElement[] = [];
  let node: HTMLElement = top;
  for (;;) {
    const parent = node.parentElement;
    if (parent === null) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      if (!(sibling instanceof HTMLElement)) continue;
      // Already inert for its own reason (the collapsed sidebar). Leaving it
      // alone means teardown leaves it alone too.
      if (sibling.hasAttribute("inert")) continue;
      // Opted out, and one opt-out exists for a reason the threat model makes
      // normative rather than a preference (myne-md/myne#728, found in
      // review). `ScreenCaptureEscape`'s trigger is a SIBLING of every
      // overlay in `App.tsx`, so inerting the siblings took it out of the tab
      // order and out of the accessibility tree. `threat-model.md` section 6
      // requires the consented device-local override to be "reachable from a
      // keyboard-focusable control on every pre-unlock screen", and
      // `JoinDeviceModal` is a PRE-UNLOCK overlay: on Windows 10 19041+, the
      // one platform where the capture layer is effective, that window is a
      // black rectangle with the account number, the recovery-phrase ceremony
      // and the device-join QR behind it. Inerting the hatch there is a
      // data-loss path, not an accessibility nit, and section 6 says so.
      if (sibling.hasAttribute(KEEP_REACHABLE_ATTR)) continue;
      sibling.setAttribute("inert", "");
      next.push(sibling);
    }
    if (parent === parent.ownerDocument.body) break;
    node = parent;
  }
  marked = next;
}

/** Register an overlay as open. Idempotent: a re-register moves it to the top. */
export function pushOverlay(el: HTMLElement): void {
  const at = stack.indexOf(el);
  if (at !== -1) stack.splice(at, 1);
  stack.push(el);
  apply();
}

/** Deregister an overlay. Safe to call for one that was never pushed. */
export function popOverlay(el: HTMLElement): void {
  const at = stack.indexOf(el);
  if (at === -1) return;
  stack.splice(at, 1);
  apply();
}

/** How many overlays are open. For tests and for a caller that needs to know. */
export function openOverlayCount(): number {
  return stack.length;
}

/** Whether `el` is currently inert because of an overlay. For tests. */
export function isInertByOverlay(el: HTMLElement): boolean {
  return marked.includes(el);
}

/** Drop all state. Tests only; a leaked stack entry would leak into the next test. */
export function resetOverlayInert(): void {
  unmarkAll();
  stack.length = 0;
}
