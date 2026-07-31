// @vitest-environment jsdom
//
// The out-of-band fingerprint gate on the endpoint screen (MYND-650 task 5).
//
// # What this is guarding
//
// With Tor routing on, the client's enrollment handshake — the one handshake
// that accepts ANY certificate, because there is no pin yet — travels through a
// Tor exit node. An exit terminates the circuit and can serve its own
// certificate to a client that has agreed to accept any, so the shipped TOFU
// bargain ("take the first connection on faith, eye-compare later") is not the
// same bargain over Tor. The backend therefore refuses to accept a pin in Tor
// mode until the user supplies the fingerprint they obtained out-of-band, and
// this screen is where they supply it.
//
// # Why the assertions are shaped this way
//
// Two properties matter and neither is visual:
//
// 1. The field is REVEALED by the refusal and its value is passed back on the
//    retry. A field that renders but never reaches the command is a gate that
//    looks like it works.
// 2. The mismatch path shows a message that does NOT contain the captured
//    fingerprint. The backend deliberately does not return it (`pin_confirm`'s
//    module doc: handing it back lets a user paste the attacker's value and
//    retry), and this screen must not invent an equivalent affordance.
// 3. Declining aborts (task 9). The refused attempt wrote nothing, so backing
//    out has to leave the screen unconfigured and say so — not leave a user
//    guessing whether a server they could not verify is now trusted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { EndpointConfig } from "../../src/components/sync/EndpointConfig";

/** The fingerprint an attacker's exit node served — never shown to the user. */
const CAPTURED = "b".repeat(64);
/** The one the operator published, obtained out-of-band. */
const EXPECTED = "a".repeat(64);

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Type a URL and press Connect. */
function connect(url = "https://sync.example") {
  fireEvent.change(screen.getByTestId("sync.endpoint-input"), {
    target: { value: url },
  });
  fireEvent.click(screen.getByTestId("sync.endpoint-connect"));
}

describe("the endpoint screen's out-of-band fingerprint gate", () => {
  it("stays hidden while the backend is happy — the clearnet flow is unchanged", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_get_endpoint")
        throw new Error("unconfigured");
      if (cmd === "plugin:sync|sync_set_endpoint") {
        return { fingerprint: CAPTURED, pin_source: "tofu" };
      }
      return undefined;
    });
    render(<EndpointConfig />);
    connect();

    await waitFor(() =>
      expect(screen.getByTestId("sync.cert-fingerprint")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.expected-fingerprint-input")).toBeNull();
  });

  it("reveals the field when the backend refuses, and sends what is typed", async () => {
    const calls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "plugin:sync|sync_get_endpoint")
          throw new Error("unconfigured");
        if (cmd === "plugin:sync|sync_set_endpoint") {
          calls.push(args ?? {});
          if (!args?.confirmedFingerprint)
            throw { kind: "PinConfirmationRequired" };
          return { fingerprint: EXPECTED, pin_source: "tofu" };
        }
        return undefined;
      },
    );
    render(<EndpointConfig />);
    connect();

    // The refusal reveals the field. Nothing was configured — the screen has no
    // fingerprint to show, because the backend returned none.
    const field = await screen.findByTestId("sync.expected-fingerprint-input");
    expect(screen.queryByTestId("sync.cert-fingerprint")).toBeNull();

    // The retry moves INTO the gate while it is open — one confirm, one
    // decline, no second identical button in the URL row.
    expect(screen.queryByTestId("sync.endpoint-connect")).toBeNull();

    fireEvent.change(field, { target: { value: EXPECTED } });
    fireEvent.click(screen.getByTestId("sync.fingerprint-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("sync.cert-fingerprint")).toBeTruthy(),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].confirmedFingerprint).toBeNull();
    expect(calls[1].confirmedFingerprint).toBe(EXPECTED);
    // Gate closed again; the ordinary Connect button is back.
    expect(screen.queryByTestId("sync.fingerprint-gate")).toBeNull();
    expect(screen.getByTestId("sync.endpoint-connect")).toBeTruthy();
  });

  it("declining aborts: nothing is sent, nothing is configured", async () => {
    let setCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_get_endpoint")
        throw new Error("unconfigured");
      if (cmd === "plugin:sync|sync_set_endpoint") {
        setCalls += 1;
        throw { kind: "PinConfirmationRequired" };
      }
      return undefined;
    });
    render(<EndpointConfig />);
    connect();

    const field = await screen.findByTestId("sync.expected-fingerprint-input");
    fireEvent.change(field, { target: { value: "ab:cd" } });
    fireEvent.click(screen.getByTestId("sync.fingerprint-decline"));

    // The gate is gone, no second attempt was made, and the screen says the
    // server was not configured rather than falling silent.
    expect(screen.queryByTestId("sync.fingerprint-gate")).toBeNull();
    expect(setCalls).toBe(1);
    expect(screen.getByTestId("sync.endpoint-msg").textContent).toContain(
      "Nothing was saved",
    );
    expect(screen.queryByTestId("sync.cert-fingerprint")).toBeNull();
  });

  it("never shows the captured fingerprint on the mismatch path", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_get_endpoint")
        throw new Error("unconfigured");
      if (cmd === "plugin:sync|sync_set_endpoint")
        throw { kind: "FingerprintMismatch" };
      return undefined;
    });
    render(<EndpointConfig />);
    connect();

    const msg = await screen.findByTestId("sync.endpoint-msg");
    // The whole point: a user who cannot find their real fingerprint must not
    // be handed the attacker's one to paste back.
    expect(document.body.textContent).not.toContain(CAPTURED);
    expect(msg.textContent).toBeTruthy();
    expect(screen.queryByTestId("sync.cert-fingerprint")).toBeNull();
    // …and the field is revealed, because a typo is the other explanation.
    expect(screen.getByTestId("sync.expected-fingerprint-input")).toBeTruthy();
  });
});
