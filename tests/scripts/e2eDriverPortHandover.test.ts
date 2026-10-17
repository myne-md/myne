// A scenario may not launch onto a WebDriver port somebody else is still
// holding, and a teardown may not return while it is still holding one.
//
// **This is the mechanism behind the suite's longest-standing quarantine.**
// Every scenario in a vitest worker starts its own `tauri-driver` on the SAME
// port (per worker, keyed on `VITEST_POOL_ID`), and `waitForDriver` can only ask
// whether SOMETHING is answering there — it cannot tell the driver it just
// spawned from the previous scenario's driver still dying. `teardown` sent
// SIGTERM, slept 200 ms, sent SIGKILL and returned without waiting for the
// process to actually go.
//
// When the old driver was still listening, `newSession` went to IT, and that
// driver spawns the app with ITS environment: an `XDG_DATA_HOME` pointing at the
// `dataHome` the same teardown had just deleted. The app found no `vaults/`
// directory, took the legitimate fresh-install path, and rendered WELCOME. The
// scenario then spent its whole budget waiting for an unlock screen on a vault
// it had correctly seeded, in a directory the app was never looking at.
//
// That is `sd1`, `gp1`, `gp2` and `nav1`, quarantined for months as runner
// contention. The CI diagnostic that finally named it read
// `testids: ["welcome.root", …]` against a seeded vault, and it also explains
// every property that diagnosis could not: more timeout never helped, it got
// worse at the tail of a run, and it reproduced on an idle machine now and then.
//
// The first test drives the REAL probe against a port nothing is bound to,
// because "a free port is recognised immediately" is the half that must hold
// against a live socket or the suite pays a timeout per scenario. The other two
// seed the probe: standing up a server here would need `node:http`, and a new
// file under this tree is held to ZERO type errors while `@types/node` is not a
// dependency of this repo.

import { describe, expect, it } from "vitest";

import { freeDriverPorts, waitForDriverGone } from "../../e2e/support/session";

/** A probe that resolves (something is answering) until `alive` is flipped. */
function seededProbe(state: { alive: boolean }): () => Promise<unknown> {
  return async () => {
    if (!state.alive) throw new Error("connection refused");
    return { ready: true };
  };
}

describe("waitForDriverGone", () => {
  it("reports the port free when nothing is listening, through the real probe", async () => {
    // Port 1 on loopback refuses the connection, which is what "mine to take"
    // looks like from here. Uses the shipped `driverStatus` rather than a seed,
    // so the default path is the one under test.
    const started = Date.now();
    expect(await waitForDriverGone("http://127.0.0.1:1", 3_000)).toBe(true);
    expect(
      Date.now() - started,
      "a free port must be answered immediately, not after the budget",
    ).toBeLessThan(2_000);
  });

  it("refuses to report free while a driver is still answering", async () => {
    // The defect in its live form: the previous scenario's driver has not gone
    // yet. Returning true here is precisely what handed a scenario somebody
    // else's data directory.
    const state = { alive: true };
    expect(await waitForDriverGone("http://127.0.0.1:1", 600, seededProbe(state))).toBe(false);
  });

  it("reports free as soon as the driver stops answering", async () => {
    // The teardown case: it must not burn the whole budget once the port is
    // actually released, or every scenario pays the timeout on every launch.
    const state = { alive: true };
    const pending = waitForDriverGone("http://127.0.0.1:1", 10_000, seededProbe(state));
    setTimeout(() => {
      state.alive = false;
    }, 300);
    const started = Date.now();
    expect(await pending).toBe(true);
    expect(
      Date.now() - started,
      "must return shortly after the listener closes, not at the deadline",
    ).toBeLessThan(5_000);
  });
});

describe("freeDriverPorts", () => {
  /** A probe that answers (port busy) for the listed ports and refuses for the rest. */
  function busy(ports: number[]): (url: string) => Promise<unknown> {
    return async (url: string) => {
      const port = Number(new URL(url).port);
      if (ports.includes(port)) return { ready: true };
      throw new Error("connection refused");
    };
  }

  it("keeps the configured pair when nothing is holding it", async () => {
    const got = await freeDriverPorts(4444, 4445, busy([]));
    expect(got).toEqual({ driverPort: 4444, nativePort: 4445, movedFrom: undefined });
  });

  it("moves to the next stride when the configured port is still answering", async () => {
    // The measured case, from a full local run:
    // `a WebDriver is still answering on http://127.0.0.1:4544 after 10000 ms`.
    // The teardown had already waited its own ten seconds, so something held the
    // port more than twenty seconds after being SIGKILLed. Waiting longer is not
    // the answer; not needing that number is.
    const got = await freeDriverPorts(4544, 4545, busy([4544]), 200);
    expect(got.driverPort).toBe(5544);
    expect(got.nativePort, "the native port must move with its driver").toBe(5545);
    expect(got.movedFrom, "a move is reported, never absorbed silently").toBe(4544);
  });

  it("moves when only the NATIVE port is held by a stray WebKitWebDriver", async () => {
    // Measured: a leftover `WebKitWebDriver` on 4445 with 4444 free. A
    // `tauri-driver` handed an occupied `--native-port` does not fail loudly,
    // it leaves the app on that other WebKit session and the scenario hangs to
    // its own budget (agent-hub ah1, 180 s). Driver and native move together.
    const got = await freeDriverPorts(4444, 4445, busy([4445]), 200);
    expect(got.driverPort).toBe(5444);
    expect(got.nativePort).toBe(5445);
  });

  it("keeps stepping past several held ports", async () => {
    const got = await freeDriverPorts(4444, 4445, busy([4444, 5444]), 200);
    expect(got.driverPort).toBe(6444);
    expect(got.nativePort).toBe(6445);
  });

  it("fails by name when every candidate is held", async () => {
    await expect(
      freeDriverPorts(4444, 4445, busy([4444, 5444, 6444, 7444]), 200),
    ).rejects.toThrow(/every candidate WebDriver port from 4444/);
  });
});
