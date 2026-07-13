import { describe, expect, it } from "vitest";
import { extractMatchSnippet } from "../../src/notes/searchNotes";

describe("extractMatchSnippet", () => {
  it("returns the matched span with surrounding context", () => {
    const body = "Image wrapped in a link: ![Clickable image](funny-reaction-gif.gif)";
    const snip = extractMatchSnippet(body, "funn", 20);
    expect(snip).not.toBeNull();
    expect(snip!.match).toBe("funn");
    // The context reveals it matched inside an image reference.
    expect(snip!.before).toContain("Clickable image");
    expect(snip!.after).toContain("y-reaction-gif");
  });

  it("is case-insensitive on the match", () => {
    const snip = extractMatchSnippet("The FUNNY thing", "funny");
    expect(snip).not.toBeNull();
    expect(snip!.match).toBe("FUNNY"); // preserves the body's original casing
  });

  it("collapses whitespace/newlines into a one-line snippet", () => {
    const body = "alpha\n\n  beta   TARGET   gamma\ndelta";
    const snip = extractMatchSnippet(body, "target", 40);
    expect(snip!.before.includes("\n")).toBe(false);
    expect(snip!.after.includes("\n")).toBe(false);
    expect(snip!.before).toContain("beta");
    expect(snip!.after).toContain("gamma");
  });

  it("adds an ellipsis only where the body is truncated", () => {
    const snip = extractMatchSnippet("xxxxxxxxxxxxxxxxxxxx MATCH yyyyyyyyyyyyyyyyyyyy", "match", 5);
    expect(snip!.before.startsWith("…")).toBe(true);
    expect(snip!.after.endsWith("…")).toBe(true);
  });

  it("no ellipsis when the match sits at the very start", () => {
    const snip = extractMatchSnippet("MATCH then more text", "match", 40);
    expect(snip!.before.startsWith("…")).toBe(false);
  });

  it("returns null when the query does not occur literally (stem-only)", () => {
    expect(extractMatchSnippet("running quickly", "run", 20)).not.toBeNull(); // literal prefix
    expect(extractMatchSnippet("swimming", "swam", 20)).toBeNull(); // stem-only, no literal
  });

  it("returns null for an empty query", () => {
    expect(extractMatchSnippet("some text", "   ", 20)).toBeNull();
  });

  it("strips the attachment embed id, showing the readable filename alias", () => {
    const body =
      "see this: ![[att:e7ee5be253f09ea0e3f5937c14da9f445|funny-reaction-gif-3266770713.gif]] done";
    const snip = extractMatchSnippet(body, "funn", 40);
    expect(snip).not.toBeNull();
    expect(snip!.match).toBe("funn");
    // No raw hex id, no ![[ ]] brackets, no att: scheme in the snippet.
    const whole = snip!.before + snip!.match + snip!.after;
    expect(whole).not.toContain("e7ee5be253");
    expect(whole).not.toContain("![[");
    expect(whole).not.toContain("att:");
    expect(whole).toContain("funny-reaction-gif-3266770713.gif");
  });

  it("reduces a plain wikilink to its alias / target", () => {
    expect(extractMatchSnippet("go [[My Note|the alias here]] now", "alias", 40)!.before).not.toContain(
      "[[",
    );
    const t = extractMatchSnippet("ref [[Target Note]] end", "target", 40);
    expect(t!.match).toBe("Target");
    expect((t!.before + t!.match + t!.after)).not.toContain("[[");
  });
});
