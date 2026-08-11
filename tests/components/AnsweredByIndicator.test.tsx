// @vitest-environment jsdom
//
// The "answered by" indicator (ai-remote-providers myne#415 task 15, SYNC-13).
//
// The properties worth asserting are the ones a reviewer cannot see by reading
// the JSX, because they are about what the component must NOT be:
//
//   - it renders for local answers too (an indicator that appears only for
//     remote ones is a warning badge, and a warning badge people see every day
//     is a badge they stop seeing);
//   - it is quiet — no colour alarm, no dismissal, no interaction;
//   - a remote answer NAMES the provider, because "remote" alone tells the
//     user nothing they can act on.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo the key plus its interpolations, so a test can tell which arm ran
    // AND whether the name reached the string.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(",")}` : key,
  }),
}));

import {
  AnsweredByIndicator,
  type AnsweredBy,
} from "../../src/components/AnsweredByIndicator";
import { answeredByFromResponse, answeredByOf } from "../../src/lib/ai-capability";

afterEach(() => cleanup());

const STATES: AnsweredBy[] = [
  { kind: "in-process" },
  { kind: "local-runtime", name: "Ollama" },
  { kind: "remote", provider: "OpenRouter" },
];

describe("AnsweredByIndicator", () => {
  it("renders in EVERY state, including the local ones", () => {
    for (const state of STATES) {
      const { unmount } = render(<AnsweredByIndicator answeredBy={state} />);
      const el = screen.getByTestId("ai.answered-by");
      expect(el.getAttribute("data-answered-by")).toBe(state.kind);
      expect(el.textContent).toBeTruthy();
      unmount();
    }
  });

  it("names the provider on a remote answer", () => {
    render(<AnsweredByIndicator answeredBy={{ kind: "remote", provider: "OpenRouter" }} />);
    expect(screen.getByTestId("ai.answered-by").textContent).toContain("OpenRouter");
  });

  it("names the program on a local-runtime answer", () => {
    render(<AnsweredByIndicator answeredBy={{ kind: "local-runtime", name: "Ollama" }} />);
    expect(screen.getByTestId("ai.answered-by").textContent).toContain("Ollama");
  });

  it("is quiet: no interaction, no dismissal, no colour alarm", () => {
    for (const state of STATES) {
      const { unmount, container } = render(<AnsweredByIndicator answeredBy={state} />);
      const el = screen.getByTestId("ai.answered-by");
      // Not a control: nothing to click, nothing to dismiss.
      expect(container.querySelector("button")).toBeNull();
      expect(el.getAttribute("role")).toBeNull();
      expect(el.getAttribute("onclick")).toBeNull();
      // Not an alarm: the muted ink token, never danger/warning.
      const style = el.getAttribute("style") ?? "";
      expect(style).toContain("var(--fg-3)");
      expect(style).not.toContain("--danger");
      expect(style).not.toContain("--warning");
      expect(style).not.toContain("--accent");
      unmount();
    }
  });

  it("uses a stable kind attribute rather than translated prose", () => {
    // So #191's convergence work — and any test — can assert which state
    // rendered without matching a string that changes per locale. Closed
    // vocabulary, never a runtime-derived value (SYNC-7 testid discipline).
    render(<AnsweredByIndicator answeredBy={{ kind: "remote", provider: "X" }} />);
    expect(screen.getByTestId("ai.answered-by").getAttribute("data-answered-by")).toBe(
      "remote",
    );
  });

  it("takes a testId override so a second surface can mount it", () => {
    render(
      <AnsweredByIndicator answeredBy={{ kind: "in-process" }} testId="chat.answered-by" />,
    );
    expect(screen.getByTestId("chat.answered-by")).toBeTruthy();
  });
});

describe("answeredByOf — the datum, derived from the existing seam", () => {
  it("maps each backend class to its own arm", () => {
    expect(answeredByOf({ backendClass: "in_process_local" })).toEqual({
      kind: "in-process",
    });
    expect(answeredByOf({ backendClass: "loopback_local" }, "Ollama")).toEqual({
      kind: "local-runtime",
      name: "Ollama",
    });
    expect(answeredByOf({ backendClass: "remote" }, "OpenRouter")).toEqual({
      kind: "remote",
      provider: "OpenRouter",
    });
  });

  it("under-states rather than throwing on a class this build does not know", () => {
    // A newer host may report a class this build has never heard of. Crashing
    // a chat turn over the provenance caption would be worse than a caption
    // that says less than it could.
    expect(answeredByOf({ backendClass: "something-new" })).toEqual({
      kind: "in-process",
    });
    expect(answeredByOf({ backendClass: null })).toEqual({ kind: "in-process" });
  });
});

describe("answeredByFromResponse — the attribution the RESPONSE reported (#440)", () => {
  // The indicator used to be built from a capability report fetched AFTER the
  // answer arrived, i.e. from the CURRENT selection — so a backend switch
  // mid-session relabelled turns a different backend had produced. And the name
  // came from the remote provider's wire value, which a loopback answer does not
  // have, so a local-runtime answer rendered "Answered by " with nothing after
  // it. Both are properties of where a note's text went, which is a trust
  // surface rather than a caption.
  it("names the loopback runtime instead of rendering an empty string", () => {
    expect(answeredByFromResponse({ class: "loopback_local", name: "ollama" })).toEqual({
      kind: "local-runtime",
      name: "ollama",
    });
  });

  it("maps a remote provider's wire name to its proper noun", () => {
    expect(answeredByFromResponse({ class: "remote", name: "openrouter" })).toEqual({
      kind: "remote",
      provider: "OpenRouter",
    });
  });

  it("needs no name for the in-process arm — that is Myne itself", () => {
    expect(answeredByFromResponse({ class: "in_process_local", name: null })).toEqual({
      kind: "in-process",
    });
  });
});
