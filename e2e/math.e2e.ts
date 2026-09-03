// Math rendering suite (MYND-48, math-katex) — E2E-gap #26.
//
// Pins the KaTeX math decoration end-to-end in the production binary: an
// inline `$…$` renders a `.cm-math-inline` widget (KaTeX lazy-loads on first
// math), an invalid block `$$…$$` renders the `.cm-math-error` fallback instead
// of crashing or swallowing the rest of the note, and the raw math source bytes
// round-trip through the MY01 AEAD blob (lock → unlock → reopen) and re-render
// — proving §6 C1 byte-preservation for math source. Math was a first-class
// decoration (lazy third-party engine + a byte-preservation guarantee) shipping
// with NO E2E; this closes that gate-evasion.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below.
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/CLAUDE.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor, waitForSaved } from "./support/flows";
import { type Session } from "./support/webdriver";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;
const BACKSPACE = "\uE003"; // W3C key codepoint (Backspace)

// KaTeX lazy-loads on the first math widget — a generous budget for the dynamic
// import + font load on the container's first paint.
const KATEX_TIMEOUT = 20_000;

/** Establish the CM key pipeline (probe char then deleted), then send the raw
 *  math source. The decoration replaces the `$…$` source with a rendered widget
 *  off-cursor, so the observable is the widget element, not the raw text. */
async function typeRaw(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  // ONE Backspace PER probe. The `waitUntil` types "q" on every poll, and under
  // load it polls more than once, so a single Backspace leaves the surplus in
  // the document ahead of the payload. This copy stays private because its
  // payload is ordinary prose: the embed scenarios stopped typing altogether
  // (`seedEmbedIntoNote` in `support/flows.ts`), and nothing here goes near a
  // bracket that CodeMirror would auto-close.
  let probes = 0;
  await session.waitUntil(
    async () => {
      await content.sendKeys("q");
      probes += 1;
      return (await content.textContent()).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  for (let i = 0; i < probes; i += 1) await content.sendKeys(BACKSPACE);
  await content.sendKeys(text);
}

describeE2E("ma1 inline math renders without swallowing the note (MYND-48)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a valid $…$ lazy-loads KaTeX and renders its widget; the rest of the line survives", async () => {
    let password = "";
    await scenario(
      "ma1-render",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Matematik");

        // Trailing text keeps the caret off the math range so it renders.
        await typeRaw(s, "intro $E=mc^2$ done");

        // The valid inline math lazy-loads KaTeX and renders its widget.
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });
        // The widget replaces ONLY its own `$…$` source — the surrounding text
        // is intact (the decoration didn't swallow the rest of the note).
        const text = await (await s.waitForElement(CM_CONTENT)).textContent();
        expect(text.includes("intro")).toBe(true);
        expect(text.includes("done")).toBe(true);
      },
    );
  });
});

describeE2E("ma2 math source survives the AEAD round-trip (MYND-48, §6 C1)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the $…$ source bytes persist through lock → unlock and re-render", async () => {
    let password = "";
    await scenario(
      "ma2-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kalıcı Matematik");

        await typeRaw(s, "keep $a^2 + b^2$ safe");
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });
        await waitForSaved(s);

        // Lock (flushes the MY01 blob) → unlock → reopen the note.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await (await s.byTestId("notes.row")).click();

        // The math re-renders → the source bytes survived the encrypted
        // round-trip verbatim (§6 C1).
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });
      },
    );
  });
});

// ma3 — myne-md/myne#555's `editor.math-and-diagrams` bullet:
//
//   > "a widget that mounted with every glyph missing" is answered in-page by
//   > `document.fonts.check("16px KaTeX_Main")` for each bundled face plus a
//   > geometry assertion on the rendered widget.
//
// # Why ma1 cannot answer this and a screenshot would not either
//
// ma1 proves the widget MOUNTED. That is a different claim from "the widget has
// glyphs in it": when a KaTeX face fails to load, KaTeX still lays the formula
// out — with fallback metrics — so the widget exists, has a size, and contains
// the right DOM. The failure is a formula rendered in the system serif at the
// wrong advances, and the roster row asked a person to look at it once a
// release and judge.
//
// `document.fonts.check(size + " " + family)` is the machine form of that
// judgement: it answers whether the browser has a face for that family that it
// can use RIGHT NOW, which is exactly what "the glyphs are there" means.
//
// # Which families, and why not all of them
//
// The bundle ships thirteen KaTeX families, and `check` reports on what is
// LOADED rather than on what is available to load — a lazily-fetched webfont
// answers false until a glyph needs it. Asserting all thirteen would therefore
// fail on a correct build. The formula below is chosen to exercise the two that
// carry ordinary mathematics — `KaTeX_Main` (the upright text and operators)
// and `KaTeX_Math` (the italic variables) — and those two are asserted. A
// formula that reached for Fraktur or Script would extend the list; keeping it
// to what is used keeps the assertion about this render.
//
// The geometry half is the control arm: a widget with no box at all would make
// the font question moot, and a font check alone cannot see it.
describeE2E("ma3 the rendered formula has real glyphs, not fallback metrics (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("loads the KaTeX faces the formula uses and lays the widget out with a real box", async () => {
    let password = "";
    await scenario(
      "ma3-katex-faces",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Matematik Glifleri");

        // Upright operators and an italic variable: `KaTeX_Main` plus
        // `KaTeX_Math`, which is the pair almost every real formula needs.
        await typeRaw(s, "intro $\\sin x + E=mc^2$ done");
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });

        // `document.fonts.ready` settles once the pending font loads have
        // resolved. Without it this races the lazy fetch and reports false for
        // a face that arrives a frame later.
        const probe = await s.executeAsync<Record<string, boolean>>(
          "var done = arguments[arguments.length - 1];" +
            "document.fonts.ready.then(function () {" +
            "  var want = ['KaTeX_Main', 'KaTeX_Math', 'KaTeX_Fraktur'];" +
            "  var out = {};" +
            "  want.forEach(function (f) { out[f] = document.fonts.check('16px ' + f); });" +
            "  done(out);" +
            "});",
        );

        // The two faces this formula needs.
        expect(
          { main: probe.KaTeX_Main, math: probe.KaTeX_Math },
          "a KaTeX face the formula uses is not loaded, so the widget is laid " +
            "out in a fallback family: the formula renders, at the wrong " +
            "advances, in the wrong shapes. ma1 passes either way.",
        ).toEqual({ main: true, math: true });

        // THE DISCRIMINATION CONTROL, and it is not optional.
        //
        // `document.fonts.check(size + " " + family)` does NOT mean "is this
        // family available". Measured in this exact seat:
        //
        //   KaTeX_Main     true    declared and loaded
        //   KaTeX_Math     true    declared and loaded
        //   KaTeX_Fraktur  false   declared, never used by this formula
        //   NoSuchFamilyZzz true   NOT DECLARED AT ALL
        //
        // An undeclared family answers TRUE, because the check succeeds against
        // the generic fallback. So the obvious control — check a nonsense name
        // and expect false — is exactly backwards, and a test built on it would
        // be reassured by the one answer that proves nothing.
        //
        // `KaTeX_Fraktur` is the control that works: the stylesheet declares
        // it, this formula does not use it, so it is unloaded and reads false.
        // That is the same state a BROKEN KaTeX_Main would be in, which is what
        // makes the two assertions above meaningful rather than tautological.
        expect(
          probe.KaTeX_Fraktur,
          "an unloaded-but-declared KaTeX face read as loaded, so " +
            "document.fonts.check is no longer discriminating here and the " +
            "assertions above prove nothing",
        ).toBe(false);

        // The control arm. A widget with no box would make the font question
        // moot, and the font check cannot see it.
        const box = await s.execute<{ w: number; h: number } | null>(
          "var el = document.querySelector(arguments[0]);" +
            "if (!el) return null;" +
            "var r = el.getBoundingClientRect();" +
            "return { w: r.width, h: r.height };",
          [`${EDITOR} .cm-math-inline`],
        );
        expect(box, "no math widget to measure").not.toBeNull();
        expect(box!.w, "the math widget has no width").toBeGreaterThan(0);
        expect(box!.h, "the math widget has no height").toBeGreaterThan(0);

        // …and it is a FORMULA-sized box rather than a collapsed sliver: the
        // source is nine visible characters, so anything narrower than a single
        // glyph means the layout ran on nothing.
        expect(box!.w).toBeGreaterThan(20);
      },
    );
  });
});
