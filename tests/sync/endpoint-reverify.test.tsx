// @vitest-environment jsdom
//
// The re-verify door on the endpoint screen (myne#756).
//
// # The dead end this exists to close
//
// When a self-hosted server renews its certificate, `sync_set_endpoint` refuses
// to adopt the new leaf (`CertificateChanged`, myne#581) and the device panel
// tells the user to "re-enter the server URL under Sync server above to
// re-trust it". That instruction could not be followed. `EndpointConfig`
// renders a DISABLED "Connected" button whenever the typed URL equals the
// connected one — which is precisely what re-entering the same URL produces —
// so the fingerprint gate that refusal raises was unreachable for the only
// endpoint it was ever written about.
//
// The escape users actually found was to perturb the URL into a different
// string (a trailing slash). That worked, and it was worse than the path it
// replaced: `replaces_a_trusted_pin` compared URL STRINGS, so a perturbed URL
// slipped the guard entirely and the new certificate was pinned with no
// fingerprint compare at all. `core/src/plugins/sync/config.rs::same_endpoint`
// is the other half of this fix and is tested on the Rust side.
//
// # What is asserted, and why each one can fail on its own
//
// 1. The resting state really is the blocked one — Connect is present AND
//    disabled — so test 2 is proving a door out of a room that is locked. An
//    assertion that the re-verify button exists says nothing without this.
// 2. Pressing it opens the gate and the typed fingerprint reaches
//    `sync_set_endpoint` **together with the URL the user never edited**. A
//    gate that opens but sends a different URL would re-pin a different server;
//    a gate that opens and sends no fingerprint is the silent adoption again.
// 3. It is offered only where the user has something to compare. A hosted
//    static pin is pre-vetted at build time and a browser's trust store exposes
//    no leaf fingerprint, so offering the door there would ask for a value that
//    cannot decide anything.
// 4. Declining closes the gate without invoking the command, so a user who
//    cannot find their fingerprint is left exactly where they started.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { EndpointConfig } from "../../src/components/sync/EndpointConfig";

/** The endpoint this device is already connected to — never edited in any test here. */
const URL = "https://sync.example";
/** The fingerprint the server presented on the last successful connect. */
const OLD_PIN = "a".repeat(64);
/** The one the operator reads off the renewed certificate, out-of-band. */
const NEW_PIN = "b".repeat(64);

type PinSource = "tofu" | "static" | "platform_trust_store" | null;

/**
 * Mount with a stored endpoint, as a device that connected once already.
 *
 * Returns the recorded `sync_set_endpoint` argument objects, so a test can
 * assert what the command was actually told rather than that it was called.
 */
function mountConnected(pinSource: PinSource, pin: string | null = OLD_PIN) {
  const calls: Array<Record<string, unknown>> = [];
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "plugin:sync|sync_get_endpoint") {
      return { endpoint_url: URL, cert_pin_hex: pin, pin_source: pinSource };
    }
    if (cmd === "plugin:sync|sync_set_endpoint") {
      calls.push(args ?? {});
      return { fingerprint: NEW_PIN, pin_source: "tofu" };
    }
    return undefined;
  });
  render(<EndpointConfig />);
  return calls;
}

/**
 * Block until the stored config has landed.
 *
 * Every assertion here is about the state AFTER `sync_get_endpoint` resolves,
 * and the screen renders a complete, plausible form before that — with Connect
 * ENABLED, because `connectedUrl` is still null. So `findByTestId` on anything
 * that exists in both states resolves against the pre-load render and the test
 * passes without ever reaching the state it names. The three "not offered"
 * cases below are exactly that shape: they would have reported a missing
 * re-verify button on a screen that had not yet been told there was a pin.
 *
 * The input's value is the one marker present in all four cases — a loopback
 * endpoint renders no fingerprint and no pin-source line to wait on.
 */
async function loaded() {
  await waitFor(() =>
    expect((screen.getByTestId("sync.endpoint-input") as HTMLInputElement).value).toBe(URL),
  );
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("re-verifying the certificate of an endpoint already connected", () => {
  it("offers the door while Connect itself rests disabled", async () => {
    mountConnected("tofu");

    await loaded();
    // The locked room: Connect is rendered, and it is inert.
    const connect = screen.getByTestId("sync.endpoint-connect");
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    // The door out of it.
    expect(screen.getByTestId("sync.endpoint-reverify")).toBeTruthy();
    // Still shut until asked.
    expect(screen.queryByTestId("sync.fingerprint-gate")).toBeNull();
  });

  it("sends the pasted fingerprint with the URL the user never edited", async () => {
    const calls = mountConnected("tofu");

    fireEvent.click(await screen.findByTestId("sync.endpoint-reverify"));
    fireEvent.change(screen.getByTestId("sync.expected-fingerprint-input"), {
      target: { value: NEW_PIN },
    });
    fireEvent.click(screen.getByTestId("sync.fingerprint-confirm"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      endpointUrl: URL,
      confirmedFingerprint: NEW_PIN,
    });
  });

  it("accepts a fingerprint pasted in openssl's own format", async () => {
    // `openssl x509 -noout -fingerprint -sha256` prints
    // `sha256 Fingerprint=AB:CD:…`, which is what an operator following the
    // gate's own help text has on their clipboard. `FingerprintConfirm`
    // normalizes it; the backend normalizes again and is the decider.
    const calls = mountConnected("tofu");
    const pasted = `sha256 Fingerprint=${NEW_PIN.toUpperCase().match(/../g)!.join(":")}`;

    fireEvent.click(await screen.findByTestId("sync.endpoint-reverify"));
    fireEvent.change(screen.getByTestId("sync.expected-fingerprint-input"), {
      target: { value: pasted },
    });
    fireEvent.click(screen.getByTestId("sync.fingerprint-confirm"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].endpointUrl).toBe(URL);
    expect(calls[0].confirmedFingerprint).toBe(pasted);
  });

  it.each([
    ["a hosted static pin", "static" as const, OLD_PIN],
    ["a browser's trust store", "platform_trust_store" as const, null],
    ["a loopback endpoint with no TLS", null, null],
  ])("is not offered for %s — there is nothing for the user to compare", async (_label, src, pin) => {
    mountConnected(src, pin);

    await loaded();
    expect(screen.queryByTestId("sync.endpoint-reverify")).toBeNull();
    // ...and the screen really is in the resting connected state, so the
    // absence above is a decision about the pin source rather than a screen
    // that has not finished loading.
    expect((screen.getByTestId("sync.endpoint-connect") as HTMLButtonElement).disabled).toBe(true);
  });

  it("declining closes the gate and invokes nothing", async () => {
    const calls = mountConnected("tofu");

    fireEvent.click(await screen.findByTestId("sync.endpoint-reverify"));
    fireEvent.change(screen.getByTestId("sync.expected-fingerprint-input"), {
      target: { value: NEW_PIN },
    });
    fireEvent.click(screen.getByTestId("sync.fingerprint-decline"));

    await waitFor(() => expect(screen.queryByTestId("sync.fingerprint-gate")).toBeNull());
    expect(calls).toHaveLength(0);
    // Back to the resting state, with the door still available.
    expect(screen.getByTestId("sync.endpoint-reverify")).toBeTruthy();
  });
});
