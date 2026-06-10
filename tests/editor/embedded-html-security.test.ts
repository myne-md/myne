// @vitest-environment jsdom
//
// Embedded-HTML editor-integration security (MYND-209, task 4). Proves the
// rendered editor DOM never contains an executing or fetching node, whatever the
// note content. Two layers: (a) off-allowlist tags (script/img/iframe) are never
// matched by the render decoration → stay literal text; (b) a crafted attribute
// or nested script inside an ALLOWLISTED element is stripped by DOMPurify.

import { afterEach, describe, expect, it } from "vitest";
import DOMPurify from "dompurify";
import { setPurifier } from "../../src/editor/decorations/embedded-html";
import { type Mounted, mount, query, teardown } from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

function withPurifier(doc: string): Mounted {
  const mounted = mount(doc, 0); // cursor at start, off the constructs
  mounted.view.dispatch({
    effects: setPurifier.of(
      DOMPurify as unknown as Parameters<typeof setPurifier.of>[0],
    ),
  });
  mounted.view.requestMeasure();
  return mounted;
}

describe("the rendered editor never produces a dangerous node", () => {
  it("never renders a <script> element (off-allowlist → literal text)", () => {
    m = withPurifier("<script>alert(1)</script>\n");
    expect(query(m, "script")).toBeNull();
  });

  it("strips a nested <script> inside an allowlisted <p>", () => {
    m = withPurifier("<p>safe<script>evil()</script></p>\n");
    expect(query(m, "script")).toBeNull();
    expect(query(m, ".cm-embedded-html-block p")).not.toBeNull();
  });

  it("never renders an <img> (off-allowlist → no resource load)", () => {
    m = withPurifier('<img src="https://evil/x.png" onerror="alert(1)">\n');
    expect(query(m, "img")).toBeNull();
  });

  it("never renders an <iframe>", () => {
    m = withPurifier('<iframe src="https://evil"></iframe>\n');
    expect(query(m, "iframe")).toBeNull();
  });

  it("renders <kbd onclick> without the handler", () => {
    m = withPurifier('<kbd onclick="evil()">K</kbd>\n');
    const el = query(m, ".cm-embedded-html");
    expect(el).not.toBeNull();
    expect(el!.querySelector("kbd")?.getAttribute("onclick")).toBeNull();
  });

  it("strips a remote href on a non-allowlisted <a> inside a <p>", () => {
    m = withPurifier('<p><a href="javascript:evil()">x</a></p>\n');
    expect(query(m, "a")).toBeNull(); // <a> off-allowlist → unwrapped to text
  });
});
