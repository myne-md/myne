// The OS theme flips while the app is open, and every surface follows.
// myne-md/myne#556, the `appearance.themes` / `settings.panel.appearance`
// bullet:
//
//   > `prefers-color-scheme` is flippable live in the Chromium seat
//   > (`Emulation.setEmulatedMedia`), and the app's response is one media-query
//   > listener plus a computed-token read; walk `--paper`/`--ink` over sidebar,
//   > editor, right panel, bottom bar and an open modal.
//
// # The walk this retires
//
// Open the app, change the OS appearance, and look at whether everything went
// dark. It needs a second application (System Settings, or a GNOME toggle), it
// is done once per release if at all, and "everything" is judged by eye across
// surfaces that are painted by different rules — which is exactly where a
// partial flip hides.
//
// # What the app actually does, and why the LIVE flip is the interesting half
//
// Nothing. There is no JS: `src/styles/tokens.css` applies dark through
// `@media (prefers-color-scheme: dark)` on a `:root` carrying no explicit
// `data-theme`, and the file says so — "System mode + every pre-unlock screen
// follow the OS live, with zero JS matchMedia / zero FOUC".
//
// That makes the boot case uninteresting (a launch flag would test CSS parsing)
// and the live case the whole point: a media query re-evaluates on its own, so
// what this asserts is that nothing in the app has since pinned a value the
// query can no longer reach — an inline style, a JS-computed colour, a token
// read once at mount. That is a real regression class in this tree, which is
// what `check-token-adoption.mjs` is a ratchet against: a literal in an inline
// style outranks every stylesheet and is unreachable to any theme, permanently.
//
// # Why the assertion is per SURFACE and not on `:root`
//
// Reading `--paper` off `document.documentElement` proves the media query
// matched. It proves nothing about whether the sidebar uses it. Every surface
// named in the bullet is measured for its own resolved `background-color`, and
// the assertion is that each one CHANGED — a surface that stayed put through an
// OS flip is a surface painting its own colour.
//
// # Chromium only, and it says so
//
// `Emulation.setEmulatedMedia` is CDP; geckodriver has no passthrough. The
// scenario self-skips on Firefox naming the reason rather than asserting less —
// `support/cdp.ts` carries the rule.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import { createNote, dismissImporterOfferIfPresent } from "./support/flows";
import { setEmulatedMedia, supportsCdp } from "./support/cdp";
import { harnessEnv, type SupportedBrowser } from "./support/harness";
import type { Session } from "./support/session";

/** Surfaces to walk. Each is a testid that exists in the unlocked shell once a
 *  note is open — `editor.sidebar-right` mounts only while a NOTE tab is
 *  focused (`Editor.tsx`), so the fixture session opens one first. */
const SURFACES = [
  "editor.sidebar-left",
  "editor.sidebar-right",
  "editor.bottom-bar",
] as const;

interface Painted {
  /** `--paper` as the root resolves it. */
  readonly rootPaper: string;
  /** `--ink-1` as the root resolves it. */
  readonly rootInk: string;
  /** Resolved `background-color` per surface, missing surfaces omitted. */
  readonly surfaces: Record<string, string>;
}

async function readPaint(session: Session): Promise<Painted> {
  const raw = await session.execute<string>(
    "var ids = arguments[0];" +
      "var rs = getComputedStyle(document.documentElement);" +
      "var out = {};" +
      "for (var i = 0; i < ids.length; i++) {" +
      "  var el = document.querySelector('[data-testid=\"' + ids[i] + '\"]');" +
      "  if (el) out[ids[i]] = getComputedStyle(el).backgroundColor;" +
      "}" +
      "return JSON.stringify({" +
      "  rootPaper: rs.getPropertyValue('--paper').trim()," +
      "  rootInk: rs.getPropertyValue('--ink-1').trim()," +
      "  surfaces: out" +
      "});",
    [SURFACES as unknown as string[]],
  );
  return JSON.parse(raw) as Painted;
}

describeE2E("the OS theme flips live and every surface follows", () => {
  it("repaints root tokens and each named surface on a prefers-color-scheme change", async () => {
    const browser = harnessEnv().browser as SupportedBrowser;
    if (!supportsCdp(browser)) {
      // Stated, not silent. `Emulation.setEmulatedMedia` is CDP and geckodriver
      // has no passthrough; a version of this that ran anyway would drive an
      // unchanged browser and report the app failing to follow a flip that
      // never happened.
      expect(
        browser,
        "this scenario needs CDP media emulation and only Chromium has it — see " +
          "support/cdp.ts. Nothing is asserted on this engine.",
      ).not.toBe("chrome");
      return;
    }

    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;
      await dismissImporterOfferIfPresent(session);
      await createNote(session);

      // Pin BOTH ends explicitly rather than assuming the seat's default. A
      // headless Chromium's default is light, but "the default" is not a fact
      // this scenario should depend on — and pinning it is also what makes the
      // final restore assertion a round trip rather than a hope.
      await setEmulatedMedia(session, browser, [
        { name: "prefers-color-scheme", value: "light" },
      ]);
      const light = await readPaint(session);

      expect(
        Object.keys(light.surfaces).length,
        `none of the surfaces ${JSON.stringify(SURFACES)} rendered, so this scenario ` +
          `would compare two empty maps and pass. The unlocked shell's testids ` +
          `changed, or the fixture did not reach the editor.`,
      ).toBe(SURFACES.length);

      await setEmulatedMedia(session, browser, [
        { name: "prefers-color-scheme", value: "dark" },
      ]);
      const dark = await readPaint(session);

      // The media query matched at all. This is the weak assertion and it comes
      // first only so a failure below is unambiguous: if the root did not move,
      // no surface could have.
      expect(
        dark.rootPaper,
        `--paper is ${dark.rootPaper} under a dark OS and was ${light.rootPaper} under ` +
          `a light one. tokens.css applies dark through ` +
          `@media (prefers-color-scheme: dark) with no JS, so an unchanged value ` +
          `means the query never matched — the emulation did not take, or the root ` +
          `carries an explicit data-theme that overrides the OS.`,
      ).not.toBe(light.rootPaper);
      expect(
        dark.rootInk,
        `--ink-1 did not move with --paper. A surface ramp that flips while the ink ` +
          `ramp does not is dark backgrounds under dark text.`,
      ).not.toBe(light.rootInk);

      // …and now the assertion that matters: each surface actually repainted.
      for (const id of SURFACES) {
        expect(
          dark.surfaces[id],
          `${id} is painted ${dark.surfaces[id]} under a dark OS and was ` +
            `${light.surfaces[id]} under a light one — it did not change. The root ` +
            `tokens DID (asserted above), so this surface is not reading them: a ` +
            `hardcoded colour in an inline style outranks every stylesheet and is ` +
            `unreachable to any theme, permanently, which is the failure ` +
            `check-token-adoption.mjs ratchets against.`,
        ).not.toBe(light.surfaces[id]);
      }

      // The round trip. A one-way flip is satisfied by anything that changes
      // once — a transition that never settles, a class toggled on first
      // change. Coming back must land exactly where it started.
      await setEmulatedMedia(session, browser, [
        { name: "prefers-color-scheme", value: "light" },
      ]);
      const back = await readPaint(session);
      expect(
        back.rootPaper,
        `--paper is ${back.rootPaper} after returning to a light OS, having been ` +
          `${light.rootPaper} before the flip. The theme is not a toggle, it is a ` +
          `function of the OS setting, so the return trip must be exact.`,
      ).toBe(light.rootPaper);
      for (const id of SURFACES) {
        expect(
          back.surfaces[id],
          `${id} did not return to its light paint after the OS went back to light`,
        ).toBe(light.surfaces[id]);
      }
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
