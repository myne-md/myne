// @vitest-environment jsdom
//
// The deboxed pre-unlock page (myne-md/myne#773).
//
// Two of the three claims here are about what the shell must NOT do, and that
// is deliberate. It is mounted by every pre-unlock screen, where `src/AGENTS.md`
// forbids anything on screen deriving from vault content — so a shell that
// grew a data dependency would be the easiest place in the tree to break that
// rule without anybody noticing, because it would look like layout.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AuthShell } from "../../src/screens/AuthShell";

afterEach(cleanup);

describe("the page carries the chrome, and the middle carries the task", () => {
  it("puts the wordmark in a header and the actions beside it", () => {
    const { container } = render(
      <AuthShell actions={<button type="button">act</button>}>
        <p>body</p>
      </AuthShell>,
    );
    const header = container.querySelector("header") as HTMLElement;
    expect(header, "no header — the app's name has nowhere to sit").not.toBeNull();
    expect(header.textContent).toContain("Myne");
    expect(header.textContent).toContain("act");
    // The task is in `main`, not in the header — a landmark distinction, and
    // the thing that makes "skip to content" mean anything on this screen.
    const main = container.querySelector("main") as HTMLElement;
    expect(main.textContent).toBe("body");
  });

  it("omits the actions row entirely when there are none", () => {
    // Rather than rendering an empty flex box: the loading and failed states
    // pass no actions, and an empty row there would still take its gap.
    const { container } = render(
      <AuthShell>
        <p>body</p>
      </AuthShell>,
    );
    const header = container.querySelector("header") as HTMLElement;
    expect(header.children).toHaveLength(1);
  });

  it("bounds the centre column so the content inside it can scroll", () => {
    // The vault list is the only scroller on the picker, and it cannot be one
    // if the column above it grows to fit instead. `min-height: auto` on a flex
    // item refuses to shrink below its content, so both halves are needed.
    const { container } = render(
      <AuthShell>
        <p>body</p>
      </AuthShell>,
    );
    const view = container.querySelector(".myne-auth-view") as HTMLElement;
    expect(view.style.maxHeight).toBe("100%");
    expect(view.style.minHeight).toBe("0px");
  });
});

describe("the entrance moves the way the user is moving", () => {
  it("defaults to forward and honours back", () => {
    // The two screens are separate stages, so moving between them unmounts one
    // and mounts the other — which is why this is an ENTER animation and not a
    // cross-fade. Direction cannot be inferred from that: only the caller knows
    // whether the user chose a vault or pressed back, and a shell that guessed
    // from mount order would get the back link wrong every time.
    const { container: fwd } = render(
      <AuthShell>
        <p>a</p>
      </AuthShell>,
    );
    expect(
      (fwd.querySelector(".myne-auth-view") as HTMLElement).dataset.enter,
    ).toBe("forward");
    cleanup();
    const { container: back } = render(
      <AuthShell enter="back">
        <p>a</p>
      </AuthShell>,
    );
    expect(
      (back.querySelector(".myne-auth-view") as HTMLElement).dataset.enter,
    ).toBe("back");
  });

  it("has a keyframe behind each direction, by the name the rule names", () => {
    // The attribute is inert without the rule, and jsdom applies no external
    // stylesheet — so a rename in `components.css` would leave every assertion
    // above green with nothing animating.
    //
    // It reads the animation NAME out of the rule and looks THAT up, rather
    // than asserting both halves against a literal. The literal version passed
    // an injection that renamed the keyframe to `…-backwards`, because
    // `toContain` is a substring match and the old name is a prefix of the new
    // one. Following the reference is the only form of this test that breaks
    // when the reference breaks.
    const sheet = readFileSync(
      resolve(process.cwd(), "client-core/src/components.css"),
      "utf8",
    );
    for (const dir of ["forward", "back"]) {
      const rule = new RegExp(
        `\\.myne-auth-view\\[data-enter="${dir}"\\]\\s*\\{([^}]*)\\}`,
      ).exec(sheet);
      expect(rule, `no rule for the ${dir} direction`).not.toBeNull();
      const name = /animation:\s*([A-Za-z0-9_-]+)/.exec(rule![1]!)?.[1];
      expect(name, `the ${dir} rule animates nothing`).toBeTruthy();
      expect(
        new RegExp(`@keyframes\\s+${name}\\s*\\{`).test(sheet),
        `the ${dir} rule names keyframes "${name}", which nothing defines`,
      ).toBe(true);
    }
  });
});

describe("it stays a shell", () => {
  it("makes no host call and reads no prefs", () => {
    // Pre-unlock: nothing on screen may derive from vault content. A source
    // assertion because that is where the rule can actually be broken — a
    // render test would pass on a shell that invoked something the fixture
    // happened to stub.
    const src: string = readFileSync(
      resolve(process.cwd(), "src/screens/AuthShell.tsx"),
      "utf8",
    );
    for (const forbidden of ["invoke(", "@tauri-apps/", "usePrefs", "prefsRead"]) {
      expect(src, `the shell reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });
});
