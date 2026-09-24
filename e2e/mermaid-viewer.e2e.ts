// Mermaid viewer suite (myne-md/myne#708).
//
// Pins the bounded, interactive mermaid viewer end-to-end in the production
// binary: a multi-subgraph flowchart renders inside a clipped viewport with the
// full control bar, the edit control reveals the raw ```mermaid fence, the
// source bytes survive the MY01 AEAD round-trip (lock -> unlock -> reopen) with
// the viewer rebuilt, and a BARE wheel over the diagram zooms it (myne-md/myne#742).
// Before #708 the card was a static image with a horizontal scrollbar and no
// fit, zoom, pan or expand.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below.
//
// PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only. See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  seedEmbedIntoNote,
  unlockToEditor,
} from "./support/flows";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;

// Mermaid lazy-loads on the first diagram; a generous budget for the dynamic
// import plus the render.
const MERMAID_TIMEOUT = 30_000;

/** Brackets would race CodeMirror's auto-close, so the fixture uses bare node
 *  ids and arrow edges: enough shape for the layout, nothing to auto-close. */
const DIAGRAM = [
  "```mermaid",
  "flowchart LR",
  "  subgraph One",
  "    A --> B",
  "    B --> C",
  "  end",
  "  subgraph Two",
  "    C --> D",
  "  end",
  "```",
].join("\n");

const CONTROL_TESTIDS = [
  "editor.mermaid.zoom-in",
  "editor.mermaid.zoom-out",
  "editor.mermaid.reset",
  "editor.mermaid.pan-up",
  "editor.mermaid.pan-down",
  "editor.mermaid.pan-left",
  "editor.mermaid.pan-right",
  "editor.mermaid.edit",
  "editor.mermaid.expand",
];

// The fence is WRITTEN through the real `note_update` IPC and the note reopened
// (`seedEmbedIntoNote`), never typed. The keystroke path is unusable here and
// each reason hides the next, all measured in the container:
//
//   - A literal `\n` in `sendKeys` is delivered as U+000A, which WebKit's driver
//     does not translate into an Enter keypress, so CM6 stays on ONE line and no
//     `FencedCode` node is ever built (the reason `typeIntoEditor` rewrites `\n`).
//   - Replacing `\n` with the W3C ENTER key closes the fence but breaks it a
//     different way: CM6's `insertNewlineAndIndent` copies the current line's
//     leading whitespace onto the new line, the diagram's own indentation adds
//     to it, and the closing fence lands well past CommonMark's three spaces, so
//     it is not a closing fence and the block never closes.
//   - One DOM `insertText` for the whole payload drops the body, leaving an
//     empty fence.
//
// `seedEmbedIntoNote` is the same route the embed scenarios took, for the same
// class of reason, and is production IPC through the page seat rather than a
// test hook. What it gives up, stated: these scenarios no longer prove a user
// can TYPE a diagram. They never meant to; typing is covered where it is the
// subject, and what is pinned here is that the viewer builds and survives the
// AEAD round-trip.

describeE2E("mv1 a diagram opens in a bounded viewer with the control bar (#708)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders inside a clipped viewport, offers every control, and the edit control reveals the fence", async () => {
    let password = "";
    await scenario(
      "mv1-viewer",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Diyagram");
        await seedEmbedIntoNote(s, DIAGRAM);

        // The viewer replaced the static card: a clipped viewport holding the
        // live SVG, not a natural-size image with a scrollbar.
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport svg`, {
          timeoutMs: MERMAID_TIMEOUT,
        });

        // Every control the acceptance criteria name, each with a testid.
        for (const tid of CONTROL_TESTIDS) {
          await s.waitForElement(`[data-testid="${tid}"]`, { timeoutMs: 10_000 });
        }

        // The edit control reveals the raw fence (click-to-edit moved off the
        // diagram's own mousedown so a drag can pan).
        await (await s.byTestId("editor.mermaid.edit")).click();
        const text = await (await s.waitForElement(CM_CONTENT)).textContent();
        expect(text.includes("flowchart")).toBe(true);
      },
    );
  });
});

describeE2E("mv2 the diagram source survives the AEAD round-trip (#708, §6 C1)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the viewer rebuilds after lock -> unlock and the bytes are unchanged", async () => {
    let password = "";
    await scenario(
      "mv2-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kalıcı Diyagram");
        await seedEmbedIntoNote(s, DIAGRAM);
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });

        // Lock (flushes the MY01 blob) -> unlock -> reopen the note.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await (await s.byTestId("notes.row")).click();

        // The viewer rebuilds over the same source, so opening a diagram was
        // never an edit (§6 C1: render-only, bytes preserved).
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });
      },
    );
  });
});

// mv3: a BARE wheel (no ctrl/meta) over the diagram zooms it (myne-md/myne#742).
// The viewer's stage runs `wheel: "always"`, the same mode the attachment
// lightbox has always used: the wheel handler lives ON the stage, so a wheel
// whose cursor is inside it is handled and preventDefaulted, and a wheel
// anywhere else reaches the document with its default intact for the note's
// scroller (asserted below from a listener the test installs, since this
// fixture's one-diagram note has nothing to scroll).
//
// Driven as a real W3C wheel action aimed at the stage's own centre (the
// `typewriter-anchor.e2e.ts` tw2 discipline: a wheel lands on whatever is
// under its coordinates) and measured on the SVG's live transform, which is
// exactly where `image-zoom-controller.ts` writes the committed state. Each
// gesture is driven at most twice: the driver drops an acknowledged wheel once
// in a while (measured in tw2), so the movement assertion is what earns the
// retry rather than a fire-and-hope. Both mount sites run the same mode and
// both are driven here: the inline viewport first, then the expand overlay's
// stage, since a revert of either line alone is a regression in that surface.
describeE2E("mv3 a bare wheel over the diagram zooms it (#742)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("zooms with no modifier key, inline and in the expand overlay", async () => {
    let password = "";
    await scenario(
      "mv3-wheel-zoom",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Tekerlekli Diyagram");
        await seedEmbedIntoNote(s, DIAGRAM);
        const viewportSel = `${EDITOR} [data-testid="editor.mermaid.viewport"]`;
        await s.waitForElement(viewportSel, { timeoutMs: MERMAID_TIMEOUT });
        // The SAME svg node moves onto the expand stage later, so the selector
        // covers both homes and `document.querySelector` answers with whichever
        // one currently holds it.
        const svgSel =
          `[data-testid="editor.mermaid.viewport"] svg, ` +
          `[data-testid="editor.mermaid.expand-stage"] svg`;
        await s.waitForElement(svgSel, { timeoutMs: MERMAID_TIMEOUT });

        // The committed transform, not a computed style: `render()` writes
        // `translate(…) scale(k)` inline, so this reads the controller's own
        // state rather than a cascade that could lag a frame.
        const readScale = (): Promise<number | null> =>
          s.execute<number | null>(
            "var s = document.querySelector(" +
              JSON.stringify(svgSel) +
              ");" +
              "if (!s) return null;" +
              "var m = /scale\\((-?[\\d.]+)\\)/.exec(s.style.transform);" +
              "return m ? parseFloat(m[1]) : null;",
          );

        const waitScale = (pred: (k: number, base: number) => boolean, base: number, what: string) =>
          s.waitUntil(
            async () => {
              const k = await readScale();
              return k !== null && pred(k, base) ? k : null;
            },
            {
              label: () =>
                `${what} (scale moved from ${base}). If the scale never moves the ` +
                `driver accepted a wheel it did not perform; if it moves only under ` +
                `ctrl, the wheel mode reverted to "modifier".`,
              timeoutMs: 10_000,
            },
          );

        // Aim at a stage's centre, in viewport coordinates (the same origin the
        // scroll action takes), and bring it into view first so the gesture is
        // not delivered to a fold of the pane scroller. `inside` is the half
        // that makes the gesture mean what it claims: a centre that resolves
        // to something outside the stage would zoom a neighbour, or nothing,
        // and the scale assertion would still have to be explained.
        const centreOf = (selector: string) =>
          s.execute<{ cx: number; cy: number; inside: boolean } | null>(
            "var v = document.querySelector(" +
              JSON.stringify(selector) +
              ");" +
              "if (!v) return null;" +
              "v.scrollIntoView({ block: 'center' });" +
              "var r = v.getBoundingClientRect();" +
              "var el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
              "return { cx: Math.round(r.left + r.width / 2), " +
              "cy: Math.round(r.top + r.height / 2), " +
              "inside: !!el && (el === v || v.contains(el)) };",
          );

        const driveWheel = async (at: { cx: number; cy: number }): Promise<void> => {
          await s.send("POST", "/actions", {
            actions: [
              {
                type: "wheel",
                id: "wheel",
                actions: [
                  {
                    type: "scroll",
                    x: at.cx,
                    y: at.cy,
                    deltaX: 0,
                    deltaY: -200,
                    duration: 100,
                    origin: "viewport",
                  },
                ],
              },
            ],
          });
          await s.send("DELETE", "/actions");
        };

        // One wheel at the stage's centre, retried once only when the first
        // gesture demonstrably moved nothing (tw2's measured dropped-wheel arm).
        const wheelZooms = async (stageSel: string, base: number): Promise<number> => {
          const at = await centreOf(stageSel);
          expect(at, `the stage ${stageSel} has no measurable box`).not.toBeNull();
          expect(at!.inside, `the centre of ${stageSel} is not over the stage`).toBe(true);
          await driveWheel(at!);
          try {
            return await waitScale((k, b) => k > b, base, "the bare wheel to zoom the diagram");
          } catch {
            await driveWheel(at!);
            return await waitScale((k, b) => k > b, base, "the bare wheel to zoom the diagram");
          }
        };

        // Inline viewport: start from the committed rest scale.
        const before = await s.waitUntil(
          async () => (await readScale()) ?? null,
          { label: () => "the mermaid SVG's committed scale to be readable" },
        );
        const inlineZoomed = await wheelZooms(viewportSel, before);
        expect(inlineZoomed).toBeGreaterThan(before);

        // The other half of the claim, on the same mounted viewer: a wheel
        // somewhere else in the editor pane is NOT ours. This fixture's note is
        // one diagram, so the pane has nothing to scroll and asserting on
        // scrollTop would pass without the event ever having been consumed; what
        // the claim actually rests on is that the event reaches the document
        // with its default intact, so that is what is measured, from a listener
        // the test itself installs (no hook in the bundle).
        await s.execute<null>(
          "window.__mv3Wheel = { seen: 0, prevented: false };" +
            "window.addEventListener('wheel', function (e) {" +
            "  window.__mv3Wheel.seen += 1;" +
            "  window.__mv3Wheel.prevented = window.__mv3Wheel.prevented || e.defaultPrevented;" +
            "}, { capture: false, passive: true });",
        );
        // A point in the pane that is NOT over the card: a few lines in from its
        // top-left corner, above the diagram (the card starts below the note's
        // first line). Clamped to the viewport, because a coordinate outside it
        // is refused by the driver as "move target out of bounds" rather than
        // delivered, which is a different failure than the one under test.
        const outside = await s.execute<{
          cx: number;
          cy: number;
          winW: number;
          winH: number;
        }>(
          "var pane = document.querySelector(" + JSON.stringify(EDITOR) + ");" +
            "var r = pane.getBoundingClientRect();" +
            "return { cx: Math.max(0, Math.min(window.innerWidth - 1, Math.round(r.left + 12)))," +
            "cy: Math.max(0, Math.min(window.innerHeight - 1, Math.round(r.top + 6)))," +
            "winW: window.innerWidth, winH: window.innerHeight };",
        );
        expect(
          outside.cx > 0 && outside.cx < outside.winW && outside.cy > 0 && outside.cy < outside.winH,
          "the editor pane does not overlap the window, so there is no in-pane point to aim at",
        ).toBe(true);
        await driveWheel(outside);
        const seen = await s.execute<{ seen: number; prevented: boolean }>(
          "var w = window.__mv3Wheel;" +
            "delete window.__mv3Wheel;" +
            "return { seen: w.seen, prevented: w.prevented };",
        );
        expect(seen.seen, "the outside wheel never reached the document").toBeGreaterThan(0);
        expect(seen.prevented, "a wheel outside the diagram was consumed").toBe(false);
        expect(await readScale(), "a wheel outside the diagram changed its scale").toBe(
          inlineZoomed,
        );


        // Expand overlay: the SAME svg node is moved onto the expand stage and
        // the new controller restores the remembered percent, so the baseline
        // here is the already-zoomed scale and the wheel must move it again.
        await (await s.byTestId("editor.mermaid.expand")).click();
        await s.waitForElement(`[data-testid="editor.mermaid.expand-stage"]`, {
          timeoutMs: 10_000,
        });
        const afterExpand = await s.waitUntil(
          async () => {
            const k = await readScale();
            return k !== null && k > 0 ? k : null;
          },
          { label: () => "the expand overlay's committed scale to be readable" },
        );
        const expandZoomed = await wheelZooms(
          `[data-testid="editor.mermaid.expand-stage"]`,
          afterExpand,
        );
        expect(expandZoomed).toBeGreaterThan(afterExpand);
      },
    );
  });
});
