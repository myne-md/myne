// Inline tag-suggestion band (on-device-tag-suggestion MYND-651 task 10).
//
// The one scenario that drives the WHOLE auto-tag chain against the real
// binary — every other layer is unit-covered alone and none of them can see the
// others: the `auto_tag_enabled` pref (task 2), the host-side two-switch gate
// (task 4), the idle-debounce trigger (task 5), the frontmatter writer (task 6)
// and the CM6 block widget (task 7). What only this lane can prove is that
// flipping two switches in Settings makes chips appear over a note the user is
// reading, and that clicking one writes a tag into that note's frontmatter.
//
//   tsb1 — enable Developer mode → AI → auto-tag → the band appears on the open
//          note carrying the StubEngine's three tags → accept one (frontmatter
//          `tags:` gains it) → dismiss another → the band reflects both, and the
//          raw source in source mode carries the accepted tag.
//
// Runs against the **`local-inference-stub` build variant** (gated on
// `MYNE_E2E_AI=1`, see `docs/dev/e2e.md`): the StubEngine's `infer_tags` answers
// the fixed `"stub-tag, meeting, notes"`, which is what makes a suggestion set
// assertable at all. The production tag model is a bundled GGUF whose weights
// are an LFS blob, and its output would not be deterministic even with them.
//
// Timing note: the trigger's real 1.5 s debounce is waited OUT, not shortened.
// `e2e/CLAUDE.md`'s zero-test-hooks rule leaves no way to reach `debounceMs`
// from here that is not a production test hook, and none is needed — every wait
// below is a `waitUntil` poll on a settled condition, so the interval costs
// wall-clock, not determinism.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  enableAi,
  setAutoTagEnabled,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** Only run against the `local-inference-stub` build (which sets
 *  `MYNE_E2E_AI=1`) — the deterministic StubEngine is the whole basis of the
 *  assertions below. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** The StubEngine's fixed `infer_tags` reply, as the pipeline parses it. */
const STUB_TAGS = ["stub-tag", "meeting", "notes"];

/** Everything the band is currently showing, read in ONE page-side evaluation.
 *  Per-element handle reads would race the band's own re-render — an accept
 *  rebuilds the whole widget, and a handle minted a poll earlier goes stale
 *  mid-assertion. One `execute` is atomic against that. */
interface BandState {
  present: boolean;
  count: string | null;
  chips: { tag: string; isNew: string | null }[];
}

async function bandState(s: Session): Promise<BandState> {
  return JSON.parse(
    await s.execute<string>(
      'var b = document.querySelector(\'[data-testid="editor.tag-suggestion-band"]\');' +
        "if (!b) return JSON.stringify({ present: false, count: null, chips: [] });" +
        'var cs = b.querySelectorAll(\'[data-testid="editor.tag-suggestion-chip"]\');' +
        "var chips = [];" +
        "for (var i = 0; i < cs.length; i++) {" +
        "  chips.push({ tag: cs[i].getAttribute('data-tag-accept')," +
        "               isNew: cs[i].getAttribute('data-is-new') });" +
        "}" +
        "return JSON.stringify({ present: true," +
        "  count: b.getAttribute('data-suggestion-count'), chips: chips });",
    ),
  ) as BandState;
}

/** Poll until the band offers exactly `want` (as a set), and return that state. */
async function waitForBandTags(s: Session, want: string[], label: string): Promise<BandState> {
  return s.waitUntil(
    async () => {
      const st = await bandState(s);
      const have = st.chips.map((c) => c.tag);
      return have.length === want.length && want.every((t) => have.includes(t)) ? st : null;
    },
    // Generous: one full debounce interval plus a stub inference, and a pass may
    // legitimately re-run after the accept changes the note.
    { label, timeoutMs: 30_000 },
  );
}

aiDescribe("tsb1 auto-tag band: suggest → accept into frontmatter → dismiss (MYND-651)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("suggests tags inline, writes an accepted one into frontmatter, and drops a dismissed one", async () => {
    let password = "";
    await scenario(
      "tsb1-tag-suggestion-band",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A note with a body — the pass windows the body into its prompt, and
        // the rename gives the note a frontmatter block with no `tags:` key yet
        // (the accept path's "append the key at the block's end" shape).
        await createNote(s, "tsb1standup");
        await typeIntoEditor(s, "We agreed the release date in the standup.", {
          landedText: "release date",
        });
        await waitForSaved(s);

        // Auto-tag is off out of the box and stays off until BOTH switches are
        // on — with only `ai_enabled` the host refuses and no band ever appears.
        await s.waitForGone(testIdSelector("editor.tag-suggestion-band"));
        await enableAi(s);
        await s.waitForGone(testIdSelector("editor.tag-suggestion-band"));
        await setAutoTagEnabled(s, true);

        // ── 1. The band appears under the frontmatter with the stub's tags ──
        await s.waitForElement(testIdSelector("editor.tag-suggestion-band"), {
          timeoutMs: 30_000,
        });
        const shown = await waitForBandTags(
          s,
          STUB_TAGS,
          "the band offers the stub's three tags",
        );
        expect(shown.count).toBe("3");
        // Every tag is new to a fresh vault, so every chip renders as such.
        expect(shown.chips.map((c) => c.isNew)).toEqual(["true", "true", "true"]);

        // ── 2. Accepting a chip writes the tag into the note ──
        await (
          await s.waitForElement(
            testIdSelector("editor.tag-suggestion-chip", { "data-tag-accept": "meeting" }),
          )
        ).click();
        await waitForSaved(s);
        // The accepted tag is not offered again — it is now the note's own, and
        // the accept path is idempotent under the tag-identity fold.
        await waitForBandTags(s, ["stub-tag", "notes"], "the accepted tag leaves the band");

        // ── 3. Dismissing a chip drops just that one ──
        await (
          await s.waitForElement(
            testIdSelector("editor.tag-suggestion-dismiss", { "data-tag-dismiss": "notes" }),
          )
        ).click();
        await waitForBandTags(s, ["stub-tag"], "the dismissed tag leaves the band");

        // ── 4. The accepted tag really is in the frontmatter ──
        // Live preview replaces the frontmatter block with the Properties
        // widget, so the raw YAML is only readable in source mode — which also
        // shows the band is source-mode-inert (the whole decoration stack is).
        await (await s.byTestId("editor.view-mode-cta")).click(); // live → reading
        await (await s.byTestId("editor.view-mode-cta")).click(); // reading → source
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.view-mode-cta")).attribute("data-view-mode")) ===
            "source"
              ? true
              : null,
          { label: "the tab reaches source mode" },
        );
        await s.waitForGone(testIdSelector("editor.tag-suggestion-band"));

        const source = await editorText(s);
        expect(source).toContain("tags:");
        expect(source).toContain("meeting");
        // Neither the dismissed tag nor the untouched one was written.
        expect(source).not.toContain("notes:");
        expect(source).not.toContain("stub-tag");
      },
    );
  });
});
