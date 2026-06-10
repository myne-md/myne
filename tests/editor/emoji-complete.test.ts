// Emoji `:` autocomplete source (MYND-156, task 5). Inserts the unicode glyph
// directly for a matching shortcode; quiet for a lone `:` or no match.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { emojiCompletionSource } from "../../src/editor/emoji-complete";

async function complete(doc: string, pos: number) {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, pos, false);
  return emojiCompletionSource(ctx);
}

describe("emoji completion source", () => {
  it("offers :rocket: and applies the glyph for ':roc'", async () => {
    const res = await complete(":roc", 4);
    expect(res).not.toBeNull();
    const opt = res!.options.find((o) => o.label === ":rocket:");
    expect(opt).toBeDefined();
    expect(opt!.apply).toBe("🚀");
    expect(res!.from).toBe(0);
    expect(res!.to).toBe(4);
  });

  it("is quiet for a lone ':' (non-explicit, < 2 chars)", async () => {
    expect(await complete(":", 1)).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    expect(await complete(":zzqqxx", 7)).toBeNull();
  });
});
