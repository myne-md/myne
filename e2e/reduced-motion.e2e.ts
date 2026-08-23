// rm1 — the app honours `prefers-reduced-motion`, and honours the ONE exemption
// it documents. myne-md/myne#555, the `app.toasts` bullet:
//
//   > WebKitGTK derives `prefers-reduced-motion` from the GTK
//   > `gtk-enable-animations` setting and the harness owns `XDG_CONFIG_HOME`:
//   > write `gtk-3.0/settings.ini` before launch, then assert all three toasts
//   > are present with computed `transition-duration: 0`.
//
// # This closes a gap the tree had already recorded
//
// `tests/a11y/reduced-motion.test.tsx` says in its own header:
//
//   > The E2E variant that FORCES `prefers-reduced-motion` in the real WebView
//   > is gated on a harness capability gap: WebKitGTK has no WebDriver
//   > media-emulation hook and the suite is zero-hook, so forcing the media
//   > query is not yet wired.
//
// That is accurate about WebDriver and beside the point about the platform.
// WebKitGTK does not take the preference from a driver command; it takes it
// from GTK, and GTK takes it from `$XDG_CONFIG_HOME/gtk-3.0/settings.ini` — a
// file this harness already owns, because it points `XDG_CONFIG_HOME` at a
// per-scenario temp tree before launch. So the query is forced through the real
// OS-level path rather than through a hook, which keeps the suite's zero-hook
// rule intact. The Vitest guard pins the STYLESHEET; this pins the effect.
//
// # Why this could not be walked by hand, and why it matters
//
// Reduced motion is a vestibular-safety setting: for the people who turn it on,
// an animation they did not ask for is nausea, not a flourish. A tester walking
// the app with it enabled sees "nothing seems to move", which is exactly what a
// half-applied rule also looks like — the one surface that kept animating is
// the one they did not happen to open.
//
// So this drives the real OS-level preference (the harness owns
// `XDG_CONFIG_HOME`, and WebKitGTK reads `gtk-enable-animations` from it) and
// then sweeps EVERY element on screen, rather than checking the surfaces
// somebody thought of.
//
// # The exemption is the reason a sweep alone would be wrong
//
// `src/styles/tokens.css` zeroes every duration under the media query and then
// carves out one case, with its reasoning written out: motion that CARRIES
// STATE. A spinner frozen mid-arc does not read as "reduced motion", it reads
// as "hung" — the one moment a user most needs to know the app is alive is the
// one where the blanket rule would stop telling them. Opting in is explicit
// (`data-motion="essential"`, and `.myne-spinner`), so the default for any new
// animation stays suppressed.
//
// A sweep that demanded zero everywhere would therefore fail on correct code,
// and "fix" it by deleting a deliberate accessibility decision. Both halves are
// asserted here: everything is still, except the things that are supposed to
// move, and those are still moving.
//
// # What this does NOT cover, stated rather than implied
//
// The bullet names the three toasts specifically. This scenario asserts the
// rule over whatever is on screen plus a probe of the stylesheet itself; it
// does not stand a toast up. A toast that rendered with its own inline
// `transition` would escape the sweep by simply not being present when the
// sweep runs. Making the three toasts appear on demand is a separate scenario
// and is not claimed here.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import type { Session } from "./support/webdriver";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** An element the sweep judged to be still moving. */
type Mover = { what: string; transition: string; animation: string };

/**
 * Turn GTK animations off for the app this scenario launches.
 *
 * `seedConfig` hands over `<XDG_CONFIG_HOME>/md.myne.desktop`, which is one
 * level too deep — GTK reads `<XDG_CONFIG_HOME>/gtk-3.0/settings.ini`. Going up
 * a directory is deliberate and is why it is written out rather than hidden in
 * a helper: the parent IS `XDG_CONFIG_HOME`, and the harness sets it to a
 * per-scenario temp tree, so nothing here can reach a real profile.
 */
function disableGtkAnimations(appConfigDir: string): void {
  const xdgConfigHome = dirname(appConfigDir);
  const gtkDir = join(xdgConfigHome, "gtk-3.0");
  mkdirSync(gtkDir, { recursive: true });
  writeFileSync(join(gtkDir, "settings.ini"), "[Settings]\ngtk-enable-animations=0\n", "utf8");
}

/** Every element whose computed style still declares a non-instant duration,
 *  excluding the documented exemption. */
async function movers(s: Session): Promise<Mover[]> {
  return (
    (await s.execute<Mover[]>(
      "var out = [];" +
        "var exempt = '.myne-spinner, [data-motion=\"essential\"]';" +
        "var all = document.querySelectorAll('*');" +
        "for (var i = 0; i < all.length; i++) {" +
        "  var el = all[i];" +
        "  if (el.matches(exempt) || el.closest(exempt)) continue;" +
        "  var cs = getComputedStyle(el);" +
        // Durations come back as comma-separated lists ("0s, 0s"); any entry
        // above zero counts.
        "  var moving = function (list) {" +
        "    return (list || '').split(',').some(function (v) {" +
        "      var n = parseFloat(v);" +
        "      if (isNaN(n)) return false;" +
        "      return v.indexOf('ms') > -1 ? n > 0 : n > 0;" +
        "    });" +
        "  };" +
        "  if (!moving(cs.transitionDuration) && !moving(cs.animationDuration)) continue;" +
        "  var id = el.getAttribute('data-testid');" +
        "  out.push({" +
        "    what: el.tagName.toLowerCase() + (id ? '[' + id + ']' : '') +" +
        "          (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')," +
        "    transition: cs.transitionDuration," +
        "    animation: cs.animationDuration" +
        "  });" +
        "}" +
        "return out;",
    )) ?? []
  );
}

describeE2E("rm1 reduced motion stills everything but the spinner (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("applies the media query from the GTK setting and keeps the one exemption", async () => {
    let seeded: SeededVault;
    await scenario(
      "rm1-reduced-motion",
      {
        seed: (dir) => void (seeded = seedVault(dir, {})),
        seedConfig: disableGtkAnimations,
      },
      async (app) => {
        const s = app.session;

        // FIRST: did the lever even connect? Everything below is meaningless if
        // the WebView never saw the preference, and a sweep that found nothing
        // moving would then be reporting a pass for the wrong reason — the
        // strongest possible false green.
        const reduced = await s.execute<boolean>(
          "return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;",
        );
        expect(
          reduced,
          "the WebView does not report `prefers-reduced-motion: reduce` even though " +
            "`gtk-enable-animations=0` was written to this scenario's own " +
            "XDG_CONFIG_HOME before launch. That is a harness finding, not an app " +
            "one: nothing below can distinguish a correct app from a broken one " +
            "until the preference actually reaches the page.",
        ).toBe(true);

        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The sweep, over the editor shell.
        const editorMovers = await movers(s);
        expect(
          editorMovers,
          `these elements still animate under reduced motion:\n` +
            editorMovers
              .map((m) => `  ${m.what} — transition ${m.transition}, animation ${m.animation}`)
              .join("\n") +
            `\nThe rule in src/styles/tokens.css zeroes both for everything that has ` +
            `not explicitly opted out with data-motion="essential". For the people ` +
            `who turn this preference on, an animation they did not ask for is ` +
            `vestibular symptoms, not a flourish.`,
        ).toEqual([]);

        // …and again over a surface with its own entry animation. Settings
        // carries `animation: settings-modal-in …` inline on the modal card, so
        // it is the case where a stylesheet rule has to beat an inline style.
        await openSettings(s, "appearance");
        await s.byTestId("settings.modal");
        const settingsMovers = await movers(s);
        expect(
          settingsMovers,
          `these elements still animate under reduced motion with Settings open:\n` +
            settingsMovers
              .map((m) => `  ${m.what} — transition ${m.transition}, animation ${m.animation}`)
              .join("\n") +
            `\nThe Settings card sets its entry animation as an INLINE style, which ` +
            `outranks a plain stylesheet rule — the reduced-motion block wins only ` +
            `because it carries !important. That is the case this half exists for.`,
        ).toEqual([]);

        // THE COUNTER-ASSERTION. Without it, deleting the exemption — or
        // deleting the spinner's animation outright — would make every
        // assertion above pass more easily, and the "fix" for a failure here
        // would be to remove a deliberate accessibility decision.
        //
        // Probed rather than waited for: the spinner is on screen only while
        // something is in flight, and a scenario that had to catch it mid-unlock
        // would be timing-dependent for no gain. What is being asserted is the
        // STYLESHEET's answer, which is where the exemption lives.
        const spinner = await s.execute<{ animation: string; present: boolean }>(
          "var el = document.createElement('div');" +
            "el.className = 'myne-spinner';" +
            "document.body.appendChild(el);" +
            "var cs = getComputedStyle(el);" +
            "var out = { animation: cs.animationDuration, present: true };" +
            "el.remove();" +
            "return out;",
        );
        expect(
          spinner?.animation,
          `under reduced motion the spinner's animation-duration is ` +
            `"${spinner?.animation}". It is supposed to be 1.6s — slowed, not stopped. ` +
            `tokens.css states why in full: motion that carries state is exempt, ` +
            `because a spinner frozen mid-arc reads as "hung" rather than as "calm", ` +
            `and the moment a user most needs to know the app is alive is not the ` +
            `moment to stop telling them.`,
        ).toBe("1.6s");
      },
    );
  });
});
