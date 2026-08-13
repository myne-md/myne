// @vitest-environment jsdom
//
// The web client's first-run flow (phase3-web-client task 85): account number →
// password → a vault.
//
// The tests here are about the two things this screen must NOT do, because both
// are properties that a reasonable-looking implementation gets wrong:
//
//   * It must not offer a server-URL field. Task 50 fixes the sync origin when
//     the container starts and generates a `connect-src` naming exactly it, so
//     any other address is CSP-blocked before a request leaves the page. A field
//     would be a lie of capability whose failure mode is an unexplained network
//     error — and the origin the join actually uses must come from the config,
//     not from anything the user typed.
//   * It must not distinguish "no such account" from "wrong password".
//     `account-number.md` §5 requires the non-distinguishing answer, and a
//     two-message version turns the pair into a two-step account enumeration for
//     anyone holding a guessed number.
//
// Plus the pending gate, which on this client is the NORMAL outcome rather than
// an edge case: task 92 leaves a browser only the password enrolment path, and
// per `server-protocol.md` §3.1 that path lands pending until an existing device
// approves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// The beta-terms gate (operations#15) stands in front of this screen. These
// specs are about what happens AFTER it, so they run with the terms already
// accepted; `betaTermsAlreadyAccepted` is flipped by the gate's own block at
// the bottom of the file, which is where the gate is actually exercised.
let betaTermsAlreadyAccepted = true;
const acceptBetaTermsMock = vi.fn(() => Promise.resolve());
vi.mock("../../src/platform/legal-consent", () => ({
  betaTermsAccepted: () => Promise.resolve(betaTermsAlreadyAccepted),
  acceptBetaTerms: () => acceptBetaTermsMock(),
}));

import { AccountBootstrap } from "../../src/screens/AccountBootstrap";
import {
  BETA_TERMS_DATA_LOSS,
  BETA_TERMS_WHAT_HAPPENS_NEXT,
  BETA_TERMS_WHAT_THIS_IS,
  BETA_TERMS_WHAT_WE_CAN_SEE,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE,
} from "../../src/lib/load-bearing-copy";

const DISPLAY_FORM = "MY-4K7P-9QRS-2TVW-XYZ0-1234";
const ENDPOINT = "https://sync.example.test";

/** Default wiring: the account number checks out and an endpoint is configured. */
function wire(over: Partial<Record<string, unknown>> = {}): void {
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === "plugin:vault-unlock|account_number_check") return true;
    if (cmd === "plugin:sync|sync_get_endpoint") {
      return "endpoint" in over ? over.endpoint : { endpoint_url: ENDPOINT };
    }
    if (cmd === "plugin:sync|sync_join_account") {
      if (over.joinThrows === true) throw new Error("refused");
      return (
        over.join ?? {
          device_id_hex: "aa".repeat(16),
          vault_id: "00000000-0000-7000-8000-ebebebebebeb",
          pending: false,
          fingerprint: null,
        }
      );
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

/** Get past the identity step and onto the password step. */
async function reachPasswordStep(): Promise<void> {
  fireEvent.change(screen.getByTestId("account-entry.input"), {
    target: { value: DISPLAY_FORM },
  });
  fireEvent.click(screen.getByTestId("account-entry.submit"));
  await screen.findByTestId("account-bootstrap.password");
}

async function submitPassword(value = "CanaryPass-9-animals!"): Promise<void> {
  fireEvent.change(screen.getByTestId("account-bootstrap.password"), {
    target: { value },
  });
  fireEvent.click(screen.getByTestId("account-bootstrap.submit"));
}

beforeEach(() => {
  invokeMock.mockReset();
  betaTermsAlreadyAccepted = true;
  acceptBetaTermsMock.mockClear();
});

afterEach(cleanup);

describe("web first-run bootstrap", () => {
  it("starts at the identity step and advances to a password only after it validates", async () => {
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    expect(screen.getByTestId("account-entry.input")).toBeTruthy();
    expect(screen.queryByTestId("account-bootstrap.password")).toBeNull();
    await reachPasswordStep();
    // The number is echoed rather than re-asked — the user has already read it
    // off another device once.
    expect(screen.getByTestId("account-bootstrap.account").textContent).toBe(DISPLAY_FORM);
  });

  it("offers NO server-URL field, and joins against the configured origin", async () => {
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    // Nothing on this screen invites a server address. Asserted as an absence of
    // ANY text input beside the password, because a URL field could be added
    // under any name and the property is "the deployment chose the origin".
    const inputs = Array.from(document.querySelectorAll("input")).filter(
      (i) => i.type !== "password" && i.getAttribute("data-testid") !== "account-bootstrap.password",
    );
    expect(inputs).toHaveLength(0);

    await submitPassword();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:sync|sync_join_account",
        expect.objectContaining({ serverUrl: ENDPOINT, accountNumber: DISPLAY_FORM }),
      ),
    );
  });

  it("reports a missing endpoint as a deployment fault, not a bad credential", async () => {
    // Telling someone their password is wrong when the client has no server
    // configured sends them to change a credential that is fine — and they can
    // change it as many times as they like without ever fixing it.
    wire({ endpoint: { endpoint_url: null } });
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    const banner = await screen.findByTestId("account-bootstrap.error");
    expect(banner.textContent).toMatch(/sync server/i);
    // And it never reached the wire.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugin:sync|sync_join_account",
      expect.anything(),
    );
  });

  it("gives one non-distinguishing message for every join failure, from the load-bearing constant", async () => {
    wire({ joinThrows: true });
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    const banner = await screen.findByTestId("account-bootstrap.error");
    // Full-literal equality, not a substring: the exact wording IS the privacy
    // property, so a paraphrase must fail here rather than pass on a keyword.
    // The default capability set has `phraseRecovery`, so this asserts the
    // ORIGINAL literal — the web substitution is asserted below.
    expect(banner.textContent).toBe(ENROLL_NON_DISTINGUISHING_BANNER);
    const text = banner.textContent ?? "";
    // And the words that would turn this into an enumeration oracle are absent
    // from the literal itself, which is what makes reusing it safe.
    expect(text).not.toMatch(/no such account|account not found|does not exist/i);
    expect(text).not.toMatch(/wrong password|incorrect password/i);
  });

  it("names no recovery phrase on a client that cannot accept one", async () => {
    // The sibling constant (`decisions.md` 2026-07-28). The original lists the
    // phrase as a possible cause; on this client the phrase paths are ABSENT
    // from the bundle, so naming it sends the user looking for a field that
    // cannot be made to exist. The non-distinguishing collapse is unchanged —
    // that is the difference between removing a cause the client cannot have and
    // removing one it can.
    vi.resetModules();
    vi.doMock("../../src/platform/capabilities", () => ({
      has: (cap: string) => cap !== "phraseRecovery",
    }));
    const { AccountBootstrap: WebBootstrap } = await import(
      "../../src/screens/AccountBootstrap"
    );
    wire({ joinThrows: true });
    render(<WebBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    const banner = await screen.findByTestId("account-bootstrap.error");
    expect(banner.textContent).toBe(ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE);
    expect(banner.textContent?.toLowerCase()).not.toContain("phrase");
    vi.doUnmock("../../src/platform/capabilities");
  });

  it("names the different-account case separately, because nothing retyped fixes it", async () => {
    // The one exception to the non-distinguishing rule above, and it leaks
    // nothing: it is a fact about THIS browser's own storage, visible to whoever
    // is sitting in front of it. Folding it into the generic banner would send
    // the user round a password-retry loop with no exit — the container has to
    // be erased first (task 72).
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      throw { kind: "AccountMismatch" };
    });
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    const banner = await screen.findByTestId("account-bootstrap.error");
    expect(banner.textContent).toMatch(/different account/i);
  });

  it("an approved join hands straight back to the boot probe", async () => {
    const onBootstrapped = vi.fn();
    wire();
    render(<AccountBootstrap onBootstrapped={onBootstrapped} />);
    await reachPasswordStep();
    await submitPassword();
    await waitFor(() => expect(onBootstrapped).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("account-bootstrap.pending-notice")).toBeNull();
  });

  // #269: the wait had no exit. Boot re-enters this stage on every reload, the
  // enrol-gate treats `pending` as "already enrolled" and hides the form, and
  // the Settings sync panel does not render one while pending — so a device
  // that enrolled against the WRONG account, or one whose approver is gone, had
  // no route back at all. Reloading returned here; there was nothing to press.
  it("offers a way out of the pending wait", async () => {
    const onBootstrapped = vi.fn();
    const calls: string[] = [];
    invokeMock.mockImplementation(async (cmd) => {
      calls.push(cmd as string);
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "bb".repeat(16),
          vault_id: "00000000-0000-7000-8000-ebebebebebeb",
          pending: true,
          fingerprint: null,
        };
      }
      if (cmd === "plugin:sync|sync_list_devices") return [];
      if (cmd === "plugin:sync|sync_reset_local") return null;
      if (cmd === "plugin:sync|sync_now") return null;
      if (cmd === "plugin:sync|sync_head_fingerprint") return null;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AccountBootstrap onBootstrapped={onBootstrapped} />);
    await reachPasswordStep();
    await submitPassword();
    await screen.findByTestId("account-bootstrap.pending-notice");

    fireEvent.click(screen.getByTestId("account-bootstrap.pending-reset"));

    // It UN-ENROLS rather than just re-rendering: leaving the enrolment in
    // place would send the next boot straight back to this screen.
    await waitFor(() =>
      expect(calls).toContain("plugin:sync|sync_reset_local"),
    );
    // …and lands back at the account-number entry, the actual beginning.
    await screen.findByTestId("account-entry.input");
    expect(onBootstrapped).not.toHaveBeenCalled();
  });

  it("a pending join explains the wait, names who can approve, and offers no manual continue", async () => {
    const onBootstrapped = vi.fn();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "bb".repeat(16),
          vault_id: "00000000-0000-7000-8000-ebebebebebeb",
          pending: true,
          fingerprint: null,
        };
      }
      if (cmd === "plugin:sync|sync_list_devices") {
        return [
          { device_id_hex: "cc".repeat(16), name: "Ömer's laptop", approved: true },
          { device_id_hex: "dd".repeat(16), name: "Old tablet", approved: false },
        ];
      }
      if (cmd === "plugin:sync|sync_now") return null;
      if (cmd === "plugin:sync|sync_head_fingerprint") return null;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AccountBootstrap onBootstrapped={onBootstrapped} />);
    await reachPasswordStep();
    await submitPassword();
    await screen.findByTestId("account-bootstrap.pending-notice");

    // Criterion 4: it continues automatically. A manual "Continue" would let a
    // user walk past the gate into a client that syncs nothing and cannot say
    // why.
    expect(screen.queryByTestId("account-bootstrap.pending-continue")).toBeNull();
    expect(onBootstrapped).not.toHaveBeenCalled();

    // And it says WHICH devices can approve, up front. A browser is typically
    // opened precisely when the user's other devices are not with them, so a
    // bare spinner is the worst version of this screen.
    const list = await screen.findByTestId("account-bootstrap.approvers");
    expect(list.textContent).toContain("Ömer's laptop");
    // Only APPROVED devices can approve — a pending sibling cannot.
    expect(list.textContent).not.toContain("Old tablet");
  });

  it("says plainly when nothing on the account can approve it", async () => {
    // The case a spinner waits out forever without explaining.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "bb".repeat(16),
          vault_id: "v",
          pending: true,
          fingerprint: null,
        };
      }
      if (cmd === "plugin:sync|sync_list_devices") return [];
      return null;
    });
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    await screen.findByTestId("account-bootstrap.no-approvers");
  });

  it("treats an unreadable roster as UNKNOWN, never as 'nobody can approve you'", async () => {
    // A still-pending device often cannot read the roster at all. Saying
    // "nobody can approve this" on the strength of a failed call would send the
    // user to give up on a gate that is working.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "bb".repeat(16),
          vault_id: "v",
          pending: true,
          fingerprint: null,
        };
      }
      if (cmd === "plugin:sync|sync_list_devices") throw new Error("401");
      return null;
    });
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    await screen.findByTestId("account-bootstrap.pending-notice");
    expect(screen.queryByTestId("account-bootstrap.no-approvers")).toBeNull();
    expect(screen.queryByTestId("account-bootstrap.approvers")).toBeNull();
  });

  it("surfaces the code-match screen once an approval lets a head be adopted", async () => {
    // The existing enrolment-approval step, not a parallel mechanism: the head
    // fingerprint IS the code both sides compare, and it only becomes available
    // once an authed cycle has adopted a head — which only happens after
    // approval.
    let fingerprint: string | null = null;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "bb".repeat(16),
          vault_id: "v",
          pending: true,
          fingerprint: null,
        };
      }
      if (cmd === "plugin:sync|sync_list_devices") return [];
      if (cmd === "plugin:sync|sync_now") {
        fingerprint = "MYNE 4K7P 9QRS"; // approval landed
        return null;
      }
      if (cmd === "plugin:sync|sync_head_fingerprint") return fingerprint;
      return null;
    });
    const onBootstrapped = vi.fn();
    render(<AccountBootstrap onBootstrapped={onBootstrapped} />);
    await reachPasswordStep();
    await submitPassword();
    const sas = await screen.findByTestId("account-bootstrap.sas", {}, { timeout: 4000 });
    expect(sas.textContent).toBe("MYNE 4K7P 9QRS");
    // Both outcomes are offered, and the mismatch is not a cosmetic dismissal:
    // it un-enrols, because a mismatch means the data this device adopted may
    // be forked.
    expect(screen.getByTestId("account-bootstrap.sas-mismatch")).toBeTruthy();
    fireEvent.click(screen.getByTestId("account-bootstrap.sas-match"));
    expect(onBootstrapped).toHaveBeenCalledTimes(1);
  });

  // ── the SAS-mismatch abort (test-audit #10/#65) ────────────────────────────
  //
  // The whole point of the SYNC-40 eye-compare is that a user who sees a
  // mismatch can get OUT. That branch had no test on either client — the case
  // above asserts the button EXISTS and then clicks the match side, which is
  // the shape of a property claimed in a comment and checked nowhere.
  //
  // Two things are pinned, and the second is the one that was actually broken.

  /** Drive the enrol flow to the code-match screen. */
  async function reachSasStep(resetLocal: () => Promise<unknown>): Promise<void> {
    let fingerprint: string | null = null;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:vault-unlock|account_number_check") return true;
      if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: ENDPOINT };
      if (cmd === "plugin:sync|sync_join_account") {
        return {
          device_id_hex: "bb".repeat(16),
          vault_id: "v",
          pending: true,
          fingerprint: null,
        };
      }
      if (cmd === "plugin:sync|sync_list_devices") return [];
      if (cmd === "plugin:sync|sync_now") {
        fingerprint = "MYNE 4K7P 9QRS";
        return null;
      }
      if (cmd === "plugin:sync|sync_head_fingerprint") return fingerprint;
      if (cmd === "plugin:sync|sync_reset_local") return resetLocal();
      return null;
    });
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    await submitPassword();
    await screen.findByTestId("account-bootstrap.sas", {}, { timeout: 4000 });
  }

  it("declining the fingerprint un-enrols the device and leaves the code screen", async () => {
    const resetLocal = vi.fn(async () => null);
    await reachSasStep(resetLocal);
    fireEvent.click(screen.getByTestId("account-bootstrap.sas-mismatch"));
    await waitFor(() => expect(resetLocal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("account-bootstrap.sas")).toBeNull());
  });

  it("a FAILED un-enrol keeps the code screen up and says the device is still enrolled", async () => {
    // The defect this covers: the handler used to `.catch(() => {})` and clear
    // the screen either way. A user who saw a mismatch — the single signal that
    // a hostile server or a forked head is in play — pressed abort and got the
    // same result whether the device was disconnected or not. Clearing the
    // screen IS the claim that it worked, so a failure must not clear it.
    const resetLocal = vi.fn(async () => {
      throw { kind: "Io" };
    });
    await reachSasStep(resetLocal);
    fireEvent.click(screen.getByTestId("account-bootstrap.sas-mismatch"));
    await waitFor(() => expect(resetLocal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("account-bootstrap.error")).toBeTruthy());
    expect(
      screen.getByTestId("account-bootstrap.sas"),
      "the code screen must stay up — clearing it would claim the abort worked",
    ).toBeTruthy();
  });

  it("lets the user go back and correct the account number", async () => {
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    await reachPasswordStep();
    fireEvent.click(screen.getByTestId("account-bootstrap.change-account"));
    expect(screen.getByTestId("account-entry.input")).toBeTruthy();
    expect(screen.queryByTestId("account-bootstrap.password")).toBeNull();
  });

  // ── surviving a refresh (MYND-635) ────────────────────────────────────────
  //
  // The reported failure: enrol, see the wait, refresh, get asked for the
  // password, land in an EMPTY vault with no way back to the wait.
  //
  // The state was `useState(false)` on this screen, so a reload erased it — and
  // boot, which routes on `vault.meta` existence, found the meta the join had
  // already written and offered unlock. The password worked (the meta is the
  // account's real one) and the vault opened empty, because a pending device
  // holds no token and can pull nothing.
  //
  // Boot now detects the pending device itself and mounts this screen ALREADY
  // in the wait. These tests are about that entry, not about the wait's
  // contents — which the cases above already pin.

  it("mounts straight into the wait when boot says this device is pending", async () => {
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} initiallyPending />);
    // No account number, no password: the credentials were entered before the
    // refresh, and asking again would imply the previous attempt did not happen.
    await screen.findByTestId("account-bootstrap.pending-notice");
    expect(screen.queryByTestId("account-entry.input")).toBeNull();
    expect(screen.queryByTestId("account-bootstrap.password")).toBeNull();
  });

  it("without that signal it still starts at the account number", async () => {
    // The pair that gives the test above its meaning. A screen that ALWAYS
    // mounted pending would satisfy it and break every first run.
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);
    expect(screen.getByTestId("account-entry.input")).toBeTruthy();
    expect(screen.queryByTestId("account-bootstrap.pending-notice")).toBeNull();
  });

  it("polls for approval from a resumed wait, not just a freshly-joined one", async () => {
    // The half that made the wait useless on web even before the refresh: this
    // poll calls `sync_now` then `sync_head_fingerprint`, and the latter was
    // never ported to the wasm router — so it threw into the catch that exists
    // for a pending device's legitimately-failing cycles, and the screen could
    // never advance even after a desktop approved it.
    //
    // Asserting the poll RUNS on a resumed mount is what pins the resumed path
    // to the same mechanism as the fresh one, rather than a second, quieter
    // implementation of waiting.
    const seen: string[] = [];
    invokeMock.mockImplementation(async (cmd) => {
      seen.push(cmd);
      if (cmd === "plugin:sync|sync_head_fingerprint") return null; // no head yet
      if (cmd === "plugin:sync|sync_list_devices") throw { kind: "NotEnrolled" };
      return null;
    });
    render(<AccountBootstrap onBootstrapped={() => {}} initiallyPending />);
    await screen.findByTestId("account-bootstrap.pending-notice");
    await waitFor(() => {
      expect(seen).toContain("plugin:sync|sync_now");
      expect(seen).toContain("plugin:sync|sync_head_fingerprint");
    });
  });
});

// ── The beta-terms gate (operations#15) ──────────────────────────────────────
//
// This is the web client's only door onto sync — sync is not optional here
// (decisions.md 2026-07-26) — so the terms are the first thing a new user sees,
// and there is no route past them.
describe("web first-run bootstrap — beta terms gate", () => {
  it("shows the terms before anything else when they have not been accepted", async () => {
    betaTermsAlreadyAccepted = false;
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);

    expect(await screen.findByTestId("bootstrap.beta-terms")).toBeTruthy();
    // Not merely "the terms are above the account field" — the field is not
    // rendered at all, so there is no route to it that skips the text.
    expect(screen.queryByTestId("account-entry.input")).toBeNull();
  });

  it("renders every clause verbatim from the load-bearing constants", async () => {
    betaTermsAlreadyAccepted = false;
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);

    // The terms are a dialog now; the gate is what stands in the entry form's
    // place until they are accepted. Opening it is the only way to the clauses,
    // and the clauses are the only way to the accepting button.
    fireEvent.click(await screen.findByTestId("bootstrap.beta-terms.open"));

    // Full-literal equality: a translation that softened any of these would be
    // a good translation and a false statement.
    expect((await screen.findByTestId("sync.beta-terms.what-this-is")).textContent).toBe(
      BETA_TERMS_WHAT_THIS_IS,
    );
    expect(screen.getByTestId("sync.beta-terms.data-loss").textContent).toBe(BETA_TERMS_DATA_LOSS);
    expect(screen.getByTestId("sync.beta-terms.what-happens-next").textContent).toBe(
      BETA_TERMS_WHAT_HAPPENS_NEXT,
    );
    expect(screen.getByTestId("sync.beta-terms.what-we-can-see").textContent).toBe(
      BETA_TERMS_WHAT_WE_CAN_SEE,
    );
  });

  it("records the acceptance and then lets the account step through", async () => {
    betaTermsAlreadyAccepted = false;
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);

    fireEvent.click(await screen.findByTestId("bootstrap.beta-terms.open"));
    fireEvent.click(await screen.findByTestId("sync.beta-terms.accept"));

    expect(acceptBetaTermsMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("account-entry.input")).toBeTruthy();
  });

  it("dismissing the dialog returns to the gate, not to the account field", async () => {
    // The property the dialog could have cost: a dismissable surface in front
    // of a LIVE form would be a route past the gate. The form is not rendered
    // at all, so cancelling reveals nothing and records nothing.
    betaTermsAlreadyAccepted = false;
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);

    fireEvent.click(await screen.findByTestId("bootstrap.beta-terms.open"));
    fireEvent.click(await screen.findByTestId("sync.beta-terms.cancel"));

    expect(acceptBetaTermsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("account-entry.input")).toBeNull();
    expect(screen.getByTestId("bootstrap.beta-terms.open")).toBeTruthy();
  });

  it("does not show the terms again once accepted", async () => {
    wire();
    render(<AccountBootstrap onBootstrapped={() => {}} />);

    expect(await screen.findByTestId("account-entry.input")).toBeTruthy();
    expect(screen.queryByTestId("bootstrap.beta-terms")).toBeNull();
  });
});
