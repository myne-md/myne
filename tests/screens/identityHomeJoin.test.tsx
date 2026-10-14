// @vitest-environment jsdom

// The member's SECOND device joining a vault it already belongs to
// (myne-md/myne#852 task 7).
//
// The failure this guards is not a crash. A second device has no out-of-band owner
// code, so the whole trust chain is the owner pin its own per-`(person, vault)`
// profile carries (`decisions/protocol/0675`); the two ways to lose it are (a)
// offering an owner-code field on this form, which would let whatever is pasted into
// it become the trust anchor, and (b) routing the join through the ACCEPT's error
// mapper, which tells the user to paste a code this screen deliberately does not ask
// for. Both are invisible to a compiler: the field renders fine and the sentence
// reads fine. So the assertions below are about what the form does NOT collect, and
// each one is paired with a positive assertion that the form is really open, since
// `queryByTestId(...) === null` is otherwise satisfied by a form that never rendered.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const personListInvites = vi.hoisted(() => vi.fn());
const personAcceptInvite = vi.hoisted(() => vi.fn());
const personJoinVault = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const inspectInviteCode = vi.hoisted(() => vi.fn());
const listRoster = vi.hoisted(() => vi.fn());
const setMyMemberName = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// `PasswordCreateForm`'s own submit gate includes zxcvbn, stubbed to a ready, passing
// score so the unit under test is the join gate rather than an async dynamic import.
vi.mock("../../src/components/PasswordInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/components/PasswordInput")>();
  return { ...real, usePasswordStrength: () => ({ ready: true, result: { score: 4 } }) };
});

vi.mock("../../src/lib/personAccount", () => ({
  personListInvites,
  personAcceptInvite,
  personJoinVault,
}));

vi.mock("../../src/lib/invite", () => ({
  inspectInviteCode,
  personLock,
  listRoster,
}));

vi.mock("../../src/lib/memberNames", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/memberNames")>();
  return { ...real, setMyMemberName };
});

vi.mock("../../src/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../src/platform/clipboardManager", () => ({ writeText: vi.fn() }));
vi.mock("../../src/components/toast/toastStore", () => ({ toast: vi.fn() }));

import { IdentityHome, acceptErrorKey, joinErrorKey } from "../../src/screens/IdentityHome";
import { PHRASE_CELL_COUNT } from "../../src/components/sync/EnrollPhraseCredential";

const CLAIMED = {
  invite_id_hex: "invite-claimed",
  vault_account_hash_hex: "ab".repeat(32),
  claimed: true,
};
const UNCLAIMED = {
  invite_id_hex: "invite-open",
  vault_account_hash_hex: "cd".repeat(32),
  claimed: false,
};
const PASSWORD = "correct horse battery staple";

function renderHome(onAccepted: () => void = () => {}) {
  return render(
    <IdentityHome
      personIdHex="person"
      identityCode="code"
      onCreateVault={() => {}}
      onAccepted={onAccepted}
      onForgotten={() => {}}
    />,
  );
}

/** Fill the join grid end to end with distinguishable words, so the assertion on the
 *  command's argument can tell a scrambled order from a correct one. */
function fillJoinPhrase(): void {
  for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
    fireEvent.change(
      screen.getByTestId(
        index === 0
          ? "identity-home.join-phrase"
          : `identity-home.join-phrase-cell-${index + 1}`,
      ),
      { target: { value: `word${index + 1}` } },
    );
  }
}

async function openJoinForm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("identity-home.join-open"));
  await screen.findByTestId("identity-home.join-form");
}

beforeEach(() => {
  personListInvites.mockReset().mockResolvedValue([]);
  personAcceptInvite.mockReset().mockResolvedValue({});
  personJoinVault.mockReset().mockResolvedValue({});
  personLock.mockReset().mockResolvedValue(undefined);
  inspectInviteCode.mockReset();
  listRoster.mockReset();
  setMyMemberName.mockReset().mockResolvedValue({});
});

afterEach(cleanup);

describe("IdentityHome second-device join", () => {
  it("lists a CLAIMED invite, which the accept list hides", async () => {
    personListInvites.mockResolvedValue([CLAIMED]);
    renderHome();

    // The row exists and offers the join, and the "no invitations" empty state, which
    // is the only thing a claimed-only list used to render, is gone.
    expect(await screen.findByTestId("identity-home.claimed-row")).toBeTruthy();
    expect(screen.getByTestId("identity-home.join-open")).toBeTruthy();
    expect(screen.queryByTestId("identity-home.empty-invites")).toBeNull();
    // …and a claimed row is NOT offered as an accept.
    expect(screen.queryByTestId("identity-home.accept-open")).toBeNull();
  });

  it("keeps the two lists apart when both kinds of invite are present", async () => {
    personListInvites.mockResolvedValue([UNCLAIMED, CLAIMED]);
    renderHome();

    await screen.findByTestId("identity-home.accept-open");
    // One row each, and neither affordance appears twice.
    expect(screen.getAllByTestId("identity-home.invite-row")).toHaveLength(1);
    expect(screen.getAllByTestId("identity-home.claimed-row")).toHaveLength(1);
    expect(screen.getAllByTestId("identity-home.accept-open")).toHaveLength(1);
    expect(screen.getAllByTestId("identity-home.join-open")).toHaveLength(1);
  });

  it("asks for the recovery phrase and a device password, and for no owner code", async () => {
    personListInvites.mockResolvedValue([CLAIMED]);
    renderHome();
    await openJoinForm();

    // Positive half first: the form really is on screen with its own phrase grid.
    expect(screen.getByTestId("identity-home.join-phrase-grid")).toBeTruthy();
    expect(screen.getByTestId("identity-home.join.password-input")).toBeTruthy();
    expect(screen.getByTestId("identity-home.join-password-note")).toBeTruthy();

    // The negative half. No owner-code field and no fingerprint step: the owner this
    // device verifies against comes from its own pinned profile record, and a field
    // here would let a pasted value replace that anchor.
    expect(screen.queryByTestId("identity-home.accept-owner-code")).toBeNull();
    expect(screen.queryByTestId("identity-home.accept-inspect")).toBeNull();
    expect(screen.queryByTestId("identity-home.accept-owner-fingerprint")).toBeNull();
    expect(inspectInviteCode).not.toHaveBeenCalled();

    // …and structurally, so a field arriving under a DIFFERENT testid convention is
    // caught too: this form collects no free text at all. The accept form's one
    // textarea IS the out-of-band owner code, so a textarea here is that field renamed.
    const form = screen.getByTestId("identity-home.join-form");
    expect(form.querySelectorAll("textarea")).toHaveLength(0);
    expect(
      Array.from(form.querySelectorAll("[data-testid]")).filter((el) =>
        (el.getAttribute("data-testid") ?? "").includes("owner"),
      ),
    ).toHaveLength(0);
  });

  it("passes the invite, the account hash, the phrase and the password to the command", async () => {
    personListInvites.mockResolvedValue([CLAIMED]);
    renderHome();
    await openJoinForm();
    fillJoinPhrase();
    fireEvent.change(screen.getByTestId("identity-home.join.password-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.join.confirm-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByTestId("identity-home.join.submit"));

    await waitFor(() =>
      expect(personJoinVault).toHaveBeenCalledWith(
        "invite-claimed",
        "ab".repeat(32),
        Array.from({ length: PHRASE_CELL_COUNT }, (_, index) => `word${index + 1}`).join(" "),
        PASSWORD,
      ),
    );
    // Four arguments, in that order: a fifth (an owner code) is exactly the shape this
    // path must not grow.
    expect(personJoinVault.mock.calls[0]).toHaveLength(4);
  });

  it("cannot join without a password meeting the floor", async () => {
    personListInvites.mockResolvedValue([CLAIMED]);
    renderHome();
    await openJoinForm();
    fillJoinPhrase();

    const submit = () => screen.getByTestId("identity-home.join.submit") as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("identity-home.join.password-input"), {
      target: { value: PASSWORD },
    });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("identity-home.join.confirm-input"), {
      target: { value: `${PASSWORD}x` },
    });
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(personJoinVault).not.toHaveBeenCalled();
  });

  // A join installs a vault this identity is ALREADY a member of, so there is nothing
  // to name. The accept owes the name gate because the accept is what creates a
  // member; a name step here would let a second device re-name a person its first
  // device had already named.
  it("reaches the editor straight away, writing no name", async () => {
    const onAccepted = vi.fn();
    personListInvites.mockResolvedValue([CLAIMED]);
    renderHome(onAccepted);
    await openJoinForm();
    fillJoinPhrase();
    fireEvent.change(screen.getByTestId("identity-home.join.password-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.join.confirm-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByTestId("identity-home.join.submit"));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("name-gate.input")).toBeNull();
    expect(setMyMemberName).not.toHaveBeenCalled();
  });

  it("reports a refusal without losing the form", async () => {
    personListInvites.mockResolvedValue([CLAIMED]);
    personJoinVault.mockRejectedValue({ kind: "BadRequest" });
    renderHome();
    await openJoinForm();
    fillJoinPhrase();
    fireEvent.change(screen.getByTestId("identity-home.join.password-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.join.confirm-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByTestId("identity-home.join.submit"));

    const banner = await screen.findByTestId("identity-home.join-error");
    expect(banner.textContent).toBe("identityHome.joinErrorBadRequest");
    // The row survives the failure, so the user can retry without re-opening the form.
    expect(screen.getByTestId("identity-home.join-form")).toBeTruthy();
  });
});

describe("identity join error mapping", () => {
  it("maps each SyncDeviceError kind to its own message", () => {
    expect(joinErrorKey({ kind: "VaultAlreadyHeld" })).toBe("identityHome.joinErrorAlreadyHeld");
    expect(joinErrorKey({ kind: "BadRequest" })).toBe("identityHome.joinErrorBadRequest");
    expect(joinErrorKey({ kind: "NotEnrolled" })).toBe("identityHome.joinErrorNotEnrolled");
    expect(joinErrorKey({ kind: "NotConfigured" })).toBe("identityHome.joinErrorNotConfigured");
    expect(joinErrorKey({ kind: "Unauthenticated" })).toBe(
      "identityHome.joinErrorUnauthenticated",
    );
    expect(joinErrorKey({ kind: "Transport" })).toBe("identityHome.joinErrorTransport");
  });

  it("falls back to the generic message for anything unexpected", () => {
    expect(joinErrorKey(new Error("boom"))).toBe("identityHome.joinError");
    expect(joinErrorKey(undefined)).toBe("identityHome.joinError");
    expect(joinErrorKey({ kind: "DeviceNotFound" })).toBe("identityHome.joinError");
  });

  // The two paths share an enum and must NOT share an answer: the accept's
  // `BadRequest` means "the pasted code did not verify", and rendering that sentence
  // on the join screen sends the user looking for a field that is not there.
  it("is not the accept mapping", () => {
    expect(joinErrorKey({ kind: "BadRequest" })).not.toBe(acceptErrorKey({ kind: "BadRequest" }));
    expect(joinErrorKey({ kind: "Transport" })).not.toBe(acceptErrorKey({ kind: "Transport" }));
  });
});

// Both mappers are reached as `t(mapper(error))`, and that is exactly what
// `scripts/check-i18n.mjs` cannot see: it walks STATIC `t("…")` keys, so a typo in any
// arm of either switch renders the raw key in the shipped app while every guard in the
// repository stays green. `t` is stubbed to echo its keys in this file too, so the
// assertions above cannot catch it either, for the reason `mobile/AGENTS.md` records
// one client over: a double that returns its input can never fail a "did the product
// show the right thing" assertion. So the catalog is read here, and compared BOTH
// ways: every key an arm can return must resolve, and every `identityHome.*Error*` key
// in the catalog must be reachable from an arm (an orphan key means a wired typo).
describe("identity invite error keys resolve in the catalog", () => {
  const catalog = JSON.parse(
    readFileSync(join(process.cwd(), "locales/en/common.json"), "utf8"),
  ) as { identityHome: Record<string, unknown> };

  /** Every kind either union declares that a mapper arm names. A kind absent here
   *  falls to the generic arm, which is the contract for both mappers, so this list
   *  does not have to be exhaustive over the Rust enum: it has to cover every arm. */
  const KINDS = [
    "NotConfigured",
    "NotEnrolled",
    "MigrationRequired",
    "GroupRosterInviteUnavailable",
    "Unauthenticated",
    "DeviceNotFound",
    "Transport",
    "TlsFailure",
    "BadRequest",
    "AccountMismatch",
    "FingerprintMismatch",
    "KdfTooLargeForHost",
    "VaultAlreadyHeld",
    "Internal",
  ];

  const leaf = (key: string): unknown => {
    const path = key.split(".").slice(1);
    let node: unknown = catalog.identityHome;
    for (const part of path) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  };

  it("resolves every key either mapper can return, and echoes none of them", () => {
    const keys = [
      ...KINDS.map((kind) => joinErrorKey({ kind })),
      ...KINDS.map((kind) => acceptErrorKey({ kind })),
    ];
    expect(keys.filter((key) => typeof leaf(key) !== "string" || leaf(key) === "")).toEqual([]);
    // A value equal to its own key is the shape a placeholder takes, and it renders the
    // dotted path at the user.
    expect(keys.filter((key) => leaf(key) === key.split(".").pop())).toEqual([]);
  });

  it("leaves no error key in the catalog unreachable from an arm", () => {
    const reachable = new Set([
      ...KINDS.map((kind) => joinErrorKey({ kind })),
      ...KINDS.map((kind) => acceptErrorKey({ kind })),
    ]);
    const declared = Object.keys(catalog.identityHome).filter((name) =>
      /^(joinError|acceptError)/.test(name),
    );
    expect(declared.filter((name) => !reachable.has(`identityHome.${name}`))).toEqual([]);
  });
});
