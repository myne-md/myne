// TS desktop template engine — hand-mirror of protocol/src/template.rs.
// These cases mirror the Rust unit tests so the two implementations stay
// behaviorally identical (the Rust↔TS drift the module header warns about).

import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  SUPPORTED_TOKENS,
  type RenderContext,
} from "../../src/dialect/templateEngine";

// Fixed context near a UTC day boundary (01:00 local in a positive offset) so
// the "host injects the local day, no off-by-one to UTC" property is visible.
const CTX: RenderContext = {
  title: "My Note",
  date: "2026-06-07",
  time: "01:00",
  datetime: "2026-06-07 01:00",
  weekday: "Sunday",
  // A WEEK-long period around that instant (myne#177), deliberately not equal
  // to `date`: a fixture whose period bounds equalled today would let a token
  // wired to the wrong context field pass.
  periodStart: "2026-06-01",
  periodEnd: "2026-06-07",
};

describe("renderTemplate — identity + determinism", () => {
  it("renders a no-token template byte-identical", () => {
    const t = "# Heading\n\nA paragraph with { single } braces and a } stray.";
    expect(renderTemplate(t, CTX)).toBe(t);
  });
  it("renders an empty template empty", () => {
    expect(renderTemplate("", CTX)).toBe("");
  });
  it("is deterministic across calls", () => {
    const t = "{{date}} {{title}} {{weekday}}";
    expect(renderTemplate(t, CTX)).toBe(renderTemplate(t, CTX));
  });
});

describe("renderTemplate — {{title}}", () => {
  it("substitutes at every occurrence", () => {
    expect(renderTemplate("{{title}} / {{title}}", CTX)).toBe("My Note / My Note");
  });
  it("renders an empty title as empty", () => {
    expect(renderTemplate("[{{title}}]", { ...CTX, title: "" })).toBe("[]");
  });
  it("substitutes markdown-ish title verbatim, no re-scan of injected tokens", () => {
    expect(
      renderTemplate("{{title}}", { ...CTX, title: "**bold** {{date}} <x>" }),
    ).toBe("**bold** {{date}} <x>");
  });
});

describe("renderTemplate — unknown-literal + lowercase-only + escape", () => {
  it("passes unknown tokens through verbatim", () => {
    expect(renderTemplate("{{foo}} and {{author}}", CTX)).toBe(
      "{{foo}} and {{author}}",
    );
  });
  it("does not match uppercase token names", () => {
    expect(renderTemplate("{{Date}} {{DATE}}", CTX)).toBe("{{Date}} {{DATE}}");
  });
  it("leaves a literal {{example}} intact (escape via literal)", () => {
    expect(renderTemplate("{{example}}", CTX)).toBe("{{example}}");
  });
  it("leaves a format-arg-shaped token literal (no mini-language)", () => {
    expect(renderTemplate("{{title:foo}}", CTX)).toBe("{{title:foo}}");
  });
  it("passes stray/unbalanced braces through without error", () => {
    expect(renderTemplate("{{", CTX)).toBe("{{");
    expect(renderTemplate("}}", CTX)).toBe("}}");
    expect(renderTemplate("{{ }}", CTX)).toBe("{{ }}");
    expect(renderTemplate("a {{ b", CTX)).toBe("a {{ b");
    expect(renderTemplate("{{ {{date}}", CTX)).toBe("{{ 2026-06-07");
  });
});

describe("renderTemplate — local-time tokens", () => {
  it("renders date / time / datetime from injected local fields", () => {
    expect(renderTemplate("{{date}}", CTX)).toBe("2026-06-07");
    expect(renderTemplate("{{time}}", CTX)).toBe("01:00");
    expect(renderTemplate("{{datetime}}", CTX)).toBe("2026-06-07 01:00");
  });
  it("keeps the injected local day near a UTC boundary (no off-by-one)", () => {
    expect(renderTemplate("{{date}} {{time}}", CTX)).toBe("2026-06-07 01:00");
  });
});

describe("renderTemplate — {{weekday}}", () => {
  it("renders the injected weekday verbatim", () => {
    expect(renderTemplate("{{weekday}}", CTX)).toBe("Sunday");
  });
  it("substitutes a non-English weekday unchanged (no locale logic)", () => {
    expect(renderTemplate("{{weekday}}", { ...CTX, weekday: "Pazar" })).toBe(
      "Pazar",
    );
  });
});

describe("SUPPORTED_TOKENS — single-source registry", () => {
  it("is exactly the registered names, in order", () => {
    // The ORDER is pinned as well as the set: it is the `{{` autocomplete
    // menu's order, and the published note-template vectors carry a
    // `token_registry` case pinning the same list. The two period tokens land
    // at the END (myne#177) so the five v1 names keep their positions.
    expect([...SUPPORTED_TOKENS]).toEqual([
      "date",
      "time",
      "title",
      "datetime",
      "weekday",
      "period_start",
      "period_end",
    ]);
  });

  it("leaves a format-arg shape on the new tokens literal too", () => {
    // The anti-plugin commitment applies to the tokens added later as much as
    // to the v1 five: `period_start:x` is not a registry key, so the whole
    // placeholder passes through, which is also the escape mechanism.
    expect(renderTemplate("{{period_start:x}} {{period_start}}", CTX)).toBe(
      "{{period_start:x}} 2026-06-01",
    );
  });

  it("keeps {{date}} meaning today even when a period is supplied", () => {
    // The same template file can be a weekly template AND something a user
    // instantiates by hand; a token whose meaning depended on the call site
    // would make one file say two things (myne#177).
    expect(renderTemplate("{{date}}|{{period_start}}|{{period_end}}", CTX)).toBe(
      "2026-06-07|2026-06-01|2026-06-07",
    );
  });
  it("every advertised token actually substitutes (no drift from render)", () => {
    for (const name of SUPPORTED_TOKENS) {
      const templ = `{{${name}}}`;
      expect(renderTemplate(templ, CTX)).not.toBe(templ);
    }
  });
});

describe("renderTemplate — coverage hardening", () => {
  it("substitutes a repeated token at every occurrence (multiline)", () => {
    expect(renderTemplate("{{date}}\nmid\n{{date}} and {{date}}", CTX)).toBe(
      "2026-06-07\nmid\n2026-06-07 and 2026-06-07",
    );
  });
  it("substitutes only known tokens in a mixed template", () => {
    expect(renderTemplate("{{date}} {{project}} {{title}}", CTX)).toBe(
      "2026-06-07 {{project}} My Note",
    );
  });
  it("matches the exact all-five-tokens string", () => {
    const t = "# {{title}} — {{weekday}} {{date}} {{time}} ({{datetime}})";
    expect(renderTemplate(t, CTX)).toBe(
      "# My Note — Sunday 2026-06-07 01:00 (2026-06-07 01:00)",
    );
  });
  it("emits only literal text (no markers/HTML/active content)", () => {
    const out = renderTemplate(
      "{{title}} {{date}} {{time}} {{datetime}} {{weekday}}",
      CTX,
    );
    expect(out).toBe("My Note 2026-06-07 01:00 2026-06-07 01:00 Sunday");
    expect(out.includes("{{")).toBe(false);
  });
});
