// @vitest-environment jsdom
//
// The shell-level `inert` owner (myne-md/myne#728, task 8).
//
// Every dialog here already said `aria-modal="true"` and trapped Tab, and both
// were real. Neither makes the background inert: a trap contains the Tab key
// and nothing else, so a screen reader's virtual cursor still read the page
// behind the dialog, a click still landed there, and `aria-modal` is an
// assertion some assistive technology honours and some ignores.
//
// Three things can go wrong in a way nothing else reports, and each has a test
// below, because each is SILENT:
//
//   1. inerting an ANCESTOR of the overlay inerts the overlay itself. It still
//      renders, it still looks right, and it refuses every click.
//   2. two overlays each restoring on close: the second restore undoes the
//      first one's state, so closing the inner dialog un-inerts the page while
//      the outer one is still open.
//   3. clearing an `inert` this module did not set: the collapsed sidebar is
//      inert for its own reason, and an owner that removed the attribute
//      blindly would quietly make a collapsed pane focusable again.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { useOverlayInert } from "../../src/hooks/useOverlayInert";
import { openModal } from "@myne/editor/host/lib/imperative-modal";
import {
  isInertByOverlay,
  KEEP_REACHABLE_ATTR,
  openOverlayCount,
  popOverlay,
  pushOverlay,
  resetOverlayInert,
} from "../../src/lib/overlay-inert";

afterEach(() => {
  // `cleanup` first: the React cases below mount components whose effects
  // pop their overlay on unmount, and unmounting after the stack was reset
  // would pop an entry that is no longer there.
  cleanup();
  resetOverlayInert();
  document.body.innerHTML = "";
});

/**
 *   body
 *     #app
 *       #main
 *     #collapsed      (inert already, for its OWN reason)
 *     #overlay-a
 *       #inner
 *         #overlay-b
 *
 * `#collapsed` sits at body level ON PURPOSE: it has to be a SIBLING the walk
 * actually visits, or the "leave an inert we did not set" case is vacuous. It
 * was nested one level deeper at first, where the walk never reaches it, and
 * removing the guard the test claims to cover changed nothing.
 */
function shell(): Record<string, HTMLElement> {
  document.body.innerHTML = `
    <div id="app"><div id="main"><button>m</button></div></div>
    <div id="collapsed" inert><button>s</button></div>
    <div id="overlay-a"><div id="inner"><div id="overlay-b"></div></div></div>
  `;
  const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  return {
    app: byId("app"),
    collapsed: byId("collapsed"),
    main: byId("main"),
    a: byId("overlay-a"),
    inner: byId("inner"),
    b: byId("overlay-b"),
  };
}

describe("the overlay inert owner", () => {
  it("inerts the siblings of the open overlay", () => {
    const el = shell();
    pushOverlay(el.a);
    expect(el.app.hasAttribute("inert")).toBe(true);
  });

  it("never inerts the overlay or anything it sits inside", () => {
    // The silent failure: an inert overlay renders, looks right, and refuses
    // every click.
    const el = shell();
    pushOverlay(el.b);
    expect(el.b.hasAttribute("inert")).toBe(false);
    expect(el.inner.hasAttribute("inert")).toBe(false);
    expect(el.a.hasAttribute("inert")).toBe(false);
    expect(document.body.hasAttribute("inert")).toBe(false);
  });

  it("walks every level up to the body, not just the overlay's own parent", () => {
    const el = shell();
    pushOverlay(el.b);
    // `#app` is a sibling of `#overlay-a`, two levels above `#overlay-b`.
    expect(el.app.hasAttribute("inert")).toBe(true);
  });

  it("restores on close", () => {
    const el = shell();
    pushOverlay(el.a);
    popOverlay(el.a);
    expect(el.app.hasAttribute("inert")).toBe(false);
    expect(openOverlayCount()).toBe(0);
  });

  it("keeps the page inert while an OUTER overlay is still open", () => {
    // The nested case. Two independent owners would each restore on close and
    // the inner one's restore would un-inert the page under the outer one.
    const el = shell();
    pushOverlay(el.a);
    pushOverlay(el.b);
    popOverlay(el.b);
    expect(el.app.hasAttribute("inert")).toBe(true);
    popOverlay(el.a);
    expect(el.app.hasAttribute("inert")).toBe(false);
  });

  it("re-derives from the new top when a second overlay opens", () => {
    const el = shell();
    pushOverlay(el.a);
    expect(el.inner.hasAttribute("inert")).toBe(false);
    pushOverlay(el.b);
    // `#inner` is now on the path to the top, and `#app` is still off it.
    expect(el.inner.hasAttribute("inert")).toBe(false);
    expect(el.app.hasAttribute("inert")).toBe(true);
  });

  it("leaves an inert it did not set, and does not clear it on teardown", () => {
    // The collapsed sidebar is inert for its own reason. Clearing it here
    // would quietly make a collapsed pane focusable again. `#collapsed` is a
    // sibling the walk visits, so the guard is actually consulted.
    const el = shell();
    expect(el.collapsed.hasAttribute("inert")).toBe(true);
    pushOverlay(el.a);
    expect(isInertByOverlay(el.collapsed)).toBe(false);
    popOverlay(el.a);
    expect(el.collapsed.hasAttribute("inert")).toBe(true);
  });

  it("is idempotent: re-registering moves an overlay to the top, it does not stack it", () => {
    const el = shell();
    pushOverlay(el.a);
    pushOverlay(el.b);
    pushOverlay(el.a);
    expect(openOverlayCount()).toBe(2);
    popOverlay(el.a);
    expect(openOverlayCount()).toBe(1);
    // `b` is top again, so the page stays inert.
    expect(el.app.hasAttribute("inert")).toBe(true);
  });

  it("ignores a pop for something never pushed", () => {
    const el = shell();
    pushOverlay(el.a);
    popOverlay(el.b);
    expect(openOverlayCount()).toBe(1);
    expect(el.app.hasAttribute("inert")).toBe(true);
  });

  it("does nothing for an overlay that has left the document", () => {
    const el = shell();
    pushOverlay(el.a);
    el.a.remove();
    pushOverlay(el.a);
    expect(el.app.hasAttribute("inert")).toBe(false);
  });
});

describe("the React binding registers an overlay that mounts late", () => {
  // The trap: the effect's deps cannot see an element arriving on a LATER
  // render. `SnapshotsPanel` is the live shape - `useOverlayInert(ref, open)`
  // with a render guard of `if (!open || noteId === null) return null` - so
  // with `open` true and the id not yet resolved the backdrop is absent, the
  // effect reads a null ref and returns, and nothing re-runs it. The overlay
  // is then never registered and the background stays fully reachable, with
  // no error on either side.

  function Late({ mounted }: { mounted: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useOverlayInert(ref, true);
    return (
      <div>
        <div data-testid="background">behind</div>
        {mounted ? <div ref={ref} data-testid="overlay" /> : null}
      </div>
    );
  }

  it("registers once the element appears, not only if it was there first", () => {
    const { rerender } = render(<Late mounted={false} />);
    expect(openOverlayCount(), "nothing to register yet").toBe(0);
    rerender(<Late mounted />);
    expect(
      openOverlayCount(),
      "the overlay must register when its element arrives on a later render",
    ).toBe(1);
    expect(isInertByOverlay(screen.getByTestId("background"))).toBe(true);
  });

  it("unregisters when the element goes away again", () => {
    const { rerender } = render(<Late mounted />);
    expect(openOverlayCount()).toBe(1);
    rerender(<Late mounted={false} />);
    expect(openOverlayCount()).toBe(0);
    expect(isInertByOverlay(screen.getByTestId("background"))).toBe(false);
  });
});

/** Every `.ts`/`.tsx` under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full: string = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the screen-capture escape stays reachable behind an overlay", () => {
  // Not an accessibility nicety: `myne-agents/docs/threat-model.md` section 6 requires
  // the consented device-local override to be "reachable from a
  // keyboard-focusable control on every pre-unlock screen", and
  // `JoinDeviceModal` is a pre-unlock overlay. On Windows 10 19041+, the one
  // platform where the capture layer is effective, that window is a black
  // rectangle with the account number, the recovery-phrase ceremony and the
  // device-join QR behind it, so inerting the hatch is a data-loss path.
  //
  // This regressed the moment `JoinDeviceModal` was registered with the
  // owner, which happened in this branch while fixing a different finding.

  function shellWithEscape() {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    const escape = document.createElement("button");
    escape.setAttribute(KEEP_REACHABLE_ATTR, "");
    escape.setAttribute("data-testid", "escape");
    const plain = document.createElement("div");
    const overlay = document.createElement("div");
    root.append(escape, plain, overlay);
    document.body.append(root);
    return { escape, plain, overlay };
  }

  it("leaves the marked element alone while every other sibling goes inert", () => {
    const el = shellWithEscape();
    pushOverlay(el.overlay);
    expect(el.plain.hasAttribute("inert"), "an ordinary sibling is inert").toBe(true);
    expect(
      el.escape.hasAttribute("inert"),
      "the escape hatch must stay reachable: threat-model.md section 6",
    ).toBe(false);
    popOverlay(el.overlay);
  });

  it("still inerts that sibling when the marker is absent", () => {
    // The other direction, so the test cannot pass by the walk having
    // stopped reaching these elements at all.
    const el = shellWithEscape();
    el.escape.removeAttribute(KEEP_REACHABLE_ATTR);
    pushOverlay(el.overlay);
    expect(el.escape.hasAttribute("inert")).toBe(true);
    popOverlay(el.overlay);
  });

  it("does not leave the marker element inert after teardown either", () => {
    const el = shellWithEscape();
    pushOverlay(el.overlay);
    popOverlay(el.overlay);
    expect(el.escape.hasAttribute("inert")).toBe(false);
    expect(el.plain.hasAttribute("inert")).toBe(false);
  });

  it("an imperative, non-React modal registers on the same stack", () => {
    // `imperative-modal.ts` is the shared skeleton behind `promptForText`, the
    // attachment rename prompt, the diff-preview, the wikilink converter, the
    // lightbox and the task-field editors. It has to register with the SAME
    // owner the React overlays use: a second stack would let an imperative
    // modal and a React one both "own" the page, and the background behind a
    // prompt would stay reachable by a virtual cursor and a click.
    const behind = document.createElement("div");
    document.body.appendChild(behind);

    const modal = openModal({ onDismiss: () => {} });
    expect(behind.hasAttribute("inert")).toBe(true);
    expect(openOverlayCount()).toBe(1);

    modal.close();
    expect(behind.hasAttribute("inert")).toBe(false);
    expect(openOverlayCount()).toBe(0);
  });

  it("is used by exactly the surface the threat model requires, and no other", () => {
    // The marker is not a general escape hatch. A second user costs a
    // reviewer's argument rather than passing silently.
    //
    // The definition moved to the editor package (`editor/src/host/lib/overlay-inert.ts`)
    // with the imperative-modal registration, so it is outside this `src/`
    // scan; `ScreenCaptureEscape` is the one SETTER of the attribute, which is
    // the surface the threat model names.
    const users = tsFiles("src").filter((f) =>
      /KEEP_REACHABLE_ATTR/.test(readFileSync(f, "utf8")),
    );
    expect(users.sort()).toEqual(["src/components/ScreenCaptureEscape.tsx"]);
  });
});

/**
 * The ADOPTION roster (myne-md/myne#728, review).
 *
 * Everything above tests the owner's stack mechanics, and all of it passed
 * while four surfaces of seventeen actually registered. That is the gap this
 * scan closes: the primitive was correct, its module header claimed
 * "`ModalShell`, and through it every dialog built on it", and thirteen
 * dialogs built their own backdrop and never went near the shell. For those,
 * correctness rested on `aria-modal` alone, which is exactly the state the
 * issue's gap 6 describes and which this pass was supposed to end.
 *
 * Compared BOTH ways, the shape `check-twin-inventory.mjs` uses: a new
 * `aria-modal` site with no registration and no reason fails, and a recorded
 * reason whose file no longer carries `aria-modal` fails as stale.
 */
const NOT_OVERLAYS: Record<string, string> = {
  "src/notes/agent/components/ScopeExpansionDialog.tsx":
    "Renders INLINE inside the agent panel rather than over the page, so " +
    "there is no background to inert. Its `aria-modal` is questionable on " +
    "the same grounds and predates this pass.",
  "src/lib/promptForText.ts":
    "REGISTERS through `openModal(` (myne-md/myne#728): the imperative-DOM " +
    "skeleton pushes its backdrop and pops it in `close`, so the caller does " +
    "not call `useOverlayInert` itself. Kept here only so the reason is " +
    "written down; the scan's `openModal(` arm accepts it.",
  "src/components/primitives/ModalShell.tsx":
    "IS the shell: it registers, and every dialog built on it inherits that.",
};

describe("every modal overlay registers with the owner", () => {
  const sites = tsFiles("src").filter((f) =>
    readFileSync(f, "utf8").includes('aria-modal'),
  );

  it("finds the modal surfaces at all", () => {
    // Non-vacuity: a scan that stops matching reports a clean tree.
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it("every one registers, or is recorded with a reason", () => {
    // `useOverlayInert(` with the paren, not the bare name. The first
    // version matched the identifier, which the IMPORT line also carries, so
    // deleting the CALL and leaving the import reported clean - the same
    // hole `check-ipc-binding-callers.mjs` records about itself, found here
    // the same way, by injecting the defect and watching the test pass.
    //
    // `openModal(` is the second accepted registration: the imperative-DOM
    // skeleton (`imperative-modal.ts`) registers on its caller's behalf, and
    // its callers are the ones that carry `aria-modal`. Without this arm a
    // vanilla-DOM modal that registers correctly would read as unregistered.
    const unregistered = sites.filter((f) => {
      if (f in NOT_OVERLAYS) return false;
      const src = readFileSync(f, "utf8");
      return !src.includes("useOverlayInert(") && !src.includes("openModal(");
    });
    expect(
      unregistered,
      `Carries aria-modal but never registers with the overlay owner, so the background stays reachable by a virtual cursor and a click. Call \`useOverlayInert(backdropRef, open)\` (or build on \`openModal\`), or add the file to NOT_OVERLAYS with the reason it is not an overlay.\n${unregistered.join("\n")}`,
    ).toEqual([]);
  });

  it("a recorded reason does not outlive its file", () => {
    const stale = Object.keys(NOT_OVERLAYS).filter((f) => !sites.includes(f));
    expect(
      stale,
      `Recorded in NOT_OVERLAYS but no longer carries aria-modal. Drop the entry.\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("every reason is a reason", () => {
    for (const [file, reason] of Object.entries(NOT_OVERLAYS)) {
      expect(reason.length, `${file}'s reason is too short to be one`).toBeGreaterThan(40);
    }
  });
});
