// @vitest-environment jsdom
//
// Emoji shortcode rendering (MYND-156, task 3). A mapped `:word:` becomes the
// glyph off-cursor (revealed on-cursor); an unmapped shortcode stays literal;
// byte-stable. The conformance harness stubs the lazy loader to never resolve,
// so this test dispatches the map directly for determinism.

import { afterEach, describe, expect, it } from "vitest";
import { EMOJI } from "../../src/dialect/emoji-shortcodes";
import { setEmojiMap } from "../../src/editor/decorations/emoji";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

function withMap(doc: string, pos?: number): Mounted {
  const mounted = mount(doc, pos);
  mounted.view.dispatch({ effects: setEmojiMap.of(EMOJI) });
  mounted.view.requestMeasure();
  return mounted;
}

describe("emoji shortcodes", () => {
  it("renders a mapped shortcode as its glyph, hiding the :word: source", () => {
    m = withMap("ship it :rocket: now\n");
    const glyph = query(m, ".cm-emoji");
    expect(glyph).not.toBeNull();
    expect(glyph!.textContent).toBe("🚀");
    expect(renderedText(m)).not.toContain(":rocket:");
  });

  it("leaves an unmapped shortcode literal", () => {
    m = withMap("x :asdfqwer: y\n");
    expect(query(m, ".cm-emoji")).toBeNull();
    expect(renderedText(m)).toContain(":asdfqwer:");
  });

  it("reveals the raw :rocket: source on-cursor", () => {
    m = withMap("a :rocket: b\n");
    focusAt(m, "a :ro".length); // inside :rocket:
    expect(renderedText(m)).toContain(":rocket:");
  });

  it("round-trips emoji shortcodes byte-identical", () => {
    const doc = ":smile: :rocket: :lock: :memo: :sparkles:\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
