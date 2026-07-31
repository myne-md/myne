// @vitest-environment jsdom
//
// The shared out-of-band fingerprint gate (MYND-650 task 9).
//
// # What this guards
//
// The gate is the human half of the only defence against a Tor exit node
// MitM'ing the one enrollment handshake that accepts any certificate. Three
// properties keep it honest, and all three are the kind a well-meaning
// "improvement" removes without noticing:
//
// 1. **No captured fingerprint reaches this component.** Its whole contract is
//    that the expected value is an INPUT — showing the captured one first would
//    anchor the user on the attacker's proposal, and offering it after a
//    mismatch would let them paste it back. The component has no prop for it;
//    these tests assert the rendered DOM carries only what the user typed.
// 2. **Confirm is inert until the input is a fingerprint.** A half-pasted value
//    would otherwise come back as `FingerprintMismatch` — the message that says
//    something is between this device and the server — spending that alarm on a
//    typo.
// 3. **The copy states the residual a user is likeliest to get wrong** (a
//    fingerprint fetched over the same circuit proves nothing) and the way out
//    for someone who has none, and claims nothing beyond what the compare does.
//    Pinned against the real English catalog, like the Network panel's bounds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  FingerprintConfirm,
  groupFingerprint,
  readFingerprintInput,
} from "../../src/components/sync/FingerprintConfirm";

/** What the operator published — the only fingerprint this screen ever holds. */
const EXPECTED = "a1b2c3d4".repeat(8);
/** What a hostile exit node served. Nothing here may ever render it. */
const CAPTURED = "f".repeat(64);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderGate(overrides: Partial<Parameters<typeof FingerprintConfirm>[0]> = {}) {
  const props = {
    value: "",
    onChange: vi.fn(),
    onConfirm: vi.fn(),
    onDecline: vi.fn(),
    confirmLabel: "Connect",
    testIdPrefix: "sync",
    ...overrides,
  };
  render(<FingerprintConfirm {...props} />);
  return props;
}

describe("reading a typed fingerprint", () => {
  // Mirrors `pin_confirm::normalize_fingerprint`. The two must agree on what
  // counts as complete, or this side green-lights a value the backend refuses.
  it("accepts the formats operators actually paste", () => {
    const colons = EXPECTED.match(/../g)!.join(":").toUpperCase();
    expect(readFingerprintInput(colons).hex).toBe(EXPECTED);
    expect(readFingerprintInput(colons).complete).toBe(true);
    expect(readFingerprintInput(`sha256:${EXPECTED}`).complete).toBe(true);
    expect(readFingerprintInput(`  ${EXPECTED}  `).complete).toBe(true);
  });

  it("counts progress and refuses anything that is not hex", () => {
    expect(readFingerprintInput(EXPECTED.slice(0, 40)).hex).toHaveLength(40);
    expect(readFingerprintInput(EXPECTED.slice(0, 40)).complete).toBe(false);
    const junk = readFingerprintInput(`${EXPECTED.slice(0, 63)}z`);
    expect(junk.hasJunk).toBe(true);
    expect(junk.complete).toBe(false);
    // 64 hex characters plus junk is still not a fingerprint.
    expect(readFingerprintInput(`${EXPECTED} (from the wiki)`).complete).toBe(false);
  });

  it("groups for the eye-compare without dropping anything", () => {
    const groups = groupFingerprint(EXPECTED);
    expect(groups).toHaveLength(16);
    expect(groups.join("")).toBe(EXPECTED);
  });
});

describe("the fingerprint gate", () => {
  it("holds Confirm until the value is a whole fingerprint", () => {
    const { onConfirm } = renderGate({ value: EXPECTED.slice(0, 40) });
    const confirm = screen.getByTestId("sync.fingerprint-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    cleanup();
    const ready = renderGate({ value: EXPECTED });
    const live = screen.getByTestId("sync.fingerprint-confirm");
    expect((live as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(live);
    expect(ready.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("stays inert while the host is busy, even with a complete fingerprint", () => {
    renderGate({ value: EXPECTED, confirmDisabled: true });
    expect(
      (screen.getByTestId("sync.fingerprint-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("declines without needing anything typed", () => {
    const { onDecline } = renderGate();
    fireEvent.click(screen.getByTestId("sync.fingerprint-decline"));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("echoes only what was typed — never a captured value", () => {
    renderGate({ value: `sha256:${EXPECTED.toUpperCase()}` });
    const echo = screen.getByTestId("sync.fingerprint-echo");
    expect(echo.getAttribute("data-complete")).toBe("true");
    // Grouped for reading, so the rendered text is not the bare string.
    expect(echo.textContent?.replace(/\s+/g, "")).toContain(EXPECTED);
    expect(document.body.textContent).not.toContain(CAPTURED);
  });

  it("tells a partial paste how far it got, and a bad one what is wrong", () => {
    renderGate({ value: EXPECTED.slice(0, 40) });
    expect(screen.getByTestId("sync.fingerprint-echo-note").textContent).toContain(
      "40 of 64",
    );
    cleanup();
    renderGate({ value: "not-a-fingerprint" });
    expect(screen.getByTestId("sync.fingerprint-echo-note").textContent).toContain(
      "64 characters",
    );
  });

  it("shows no echo before anything is typed", () => {
    renderGate({ value: "   " });
    expect(screen.queryByTestId("sync.fingerprint-echo")).toBeNull();
  });

  it("discloses where to get the fingerprint, including the circuit caveat", () => {
    renderGate();
    expect(screen.queryByTestId("sync.fingerprint-help")).toBeNull();
    fireEvent.click(screen.getByTestId("sync.fingerprint-help-toggle"));
    const help = screen.getByTestId("sync.fingerprint-help");
    expect(help.children).toHaveLength(4);
    const text = help.textContent ?? "";
    // The residual that makes the whole exercise pointless if missed.
    expect(text).toContain("same circuit");
    // The honest way out for someone who cannot get the fingerprint at all,
    // with its cost named rather than implied.
    expect(text).toContain("Settings → Network");
    expect(text).toContain("IP address");
  });

  it("claims nothing the compare does not deliver", () => {
    renderGate({ value: EXPECTED });
    fireEvent.click(screen.getByTestId("sync.fingerprint-help-toggle"));
    const rendered = (document.body.textContent ?? "").toLowerCase();
    for (const word of ["anonymous", "untraceable", "secure", "safe", "guarantee"]) {
      expect(rendered).not.toContain(word);
    }
  });

  it("carries the prefix each enrollment door was promised", () => {
    renderGate({ testIdPrefix: "join" });
    expect(screen.getByTestId("join.expected-fingerprint-input")).toBeTruthy();
    expect(screen.getByTestId("join.fingerprint-gate")).toBeTruthy();
  });
});
