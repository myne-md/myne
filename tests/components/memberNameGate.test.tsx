// @vitest-environment jsdom
//
// The post-accept name gate (myne-md/myne#851 task 8, stories 5 to 7). Two things
// it must not get wrong, and both are asserted here rather than in a flow test:
// a member whose row already carries a VERIFIED name is not asked again (the gate
// is idempotent, so re-entering onboarding is not a nag), and quitting at the gate
// writes NOTHING (story 7: an interrupted onboarding is not a lockout, and it is not
// a half-written name either).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listRoster = vi.hoisted(() => vi.fn());
const setMyMemberName = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/invite", () => ({ listRoster }));

vi.mock("../../src/lib/memberNames", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/memberNames")>();
  return { ...real, setMyMemberName };
});

const { MemberNameGate } = await import("../../src/components/sync/MemberNameGate");

afterEach(() => {
  cleanup();
  listRoster.mockReset();
  setMyMemberName.mockReset();
});

export interface RowShape {
  fingerprint_hex: string;
  is_self: boolean;
  display_name: string;
  name_state: "verified" | "unverified" | "absent";
  role: "owner" | "member";
}

/** The caller's row, plus one other member, so `is_self` is the thing that selects. */
function rosterWithSelf(over: Partial<RowShape> = {}) {
  return {
    members: [
      {
        fingerprint_hex: "11".repeat(32),
        is_self: false,
        display_name: "Ada",
        name_state: "verified",
        role: "member",
        version: 0,
        previous_fingerprint_hex: null,
        joined_at: 0,
        member_ed_pk_hex: "bb".repeat(32),
        member_kem_ek_hex: "cc".repeat(32),
        member_mldsa_vk_hex: "dd".repeat(48),
        continuity: null,
      },
      {
        fingerprint_hex: "aa".repeat(32),
        is_self: true,
        display_name: "",
        name_state: "absent",
        role: "member",
        version: 0,
        previous_fingerprint_hex: null,
        joined_at: 0,
        member_ed_pk_hex: "ee".repeat(32),
        member_kem_ek_hex: "ff".repeat(32),
        member_mldsa_vk_hex: "00".repeat(48),
        continuity: null,
        ...over,
      },
    ],
    authority: "member",
    group_key_epoch: 3,
  };
}

const field = () => screen.getByTestId("name-gate.input") as HTMLInputElement;
const submit = () => screen.getByTestId("name-gate.save") as HTMLButtonElement;

describe("MemberNameGate", () => {
  it("asks the caller whose row has no name, and offers no way past it", async () => {
    listRoster.mockResolvedValue(rosterWithSelf({ name_state: "absent" }));
    const onDone = vi.fn();
    render(<MemberNameGate onDone={onDone} />);

    await waitFor(() => expect(listRoster).toHaveBeenCalled());
    expect(await screen.findByTestId("name-gate.input")).toBeDefined();
    // The step is required during onboarding: there is no skip control, and the
    // only way it resolves is a written name.
    expect(screen.queryByTestId("name-gate.skip")).toBeNull();
    expect(submit().disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("asks again when the caller's record failed verification", async () => {
    listRoster.mockResolvedValue(rosterWithSelf({ name_state: "unverified" }));
    render(<MemberNameGate onDone={vi.fn()} />);
    expect(await screen.findByTestId("name-gate.input")).toBeDefined();
  });

  it("does not ask a caller whose name already verified", async () => {
    listRoster.mockResolvedValue(
      rosterWithSelf({ display_name: "Ada", name_state: "verified" }),
    );
    const onDone = vi.fn();
    render(<MemberNameGate onDone={onDone} />);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByTestId("name-gate.input")).toBeNull();
    expect(setMyMemberName).not.toHaveBeenCalled();
  });

  it("writes the trimmed name and only then lets the caller through", async () => {
    listRoster.mockResolvedValue(rosterWithSelf({ name_state: "absent" }));
    setMyMemberName.mockResolvedValue({});
    const onDone = vi.fn();
    render(<MemberNameGate onDone={onDone} />);

    fireEvent.change(await screen.findByTestId("name-gate.input"), {
      target: { value: "  Ada  " },
    });
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());

    await waitFor(() => expect(setMyMemberName).toHaveBeenCalledWith("Ada"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("renders a writer refusal inline and stays put", async () => {
    listRoster.mockResolvedValue(rosterWithSelf({ name_state: "absent" }));
    setMyMemberName.mockRejectedValue({ kind: "NameTooLong", detail: { max: 64 } });
    const onDone = vi.fn();
    render(<MemberNameGate onDone={onDone} />);

    fireEvent.change(await screen.findByTestId("name-gate.input"), {
      target: { value: "Ada" },
    });
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());

    expect((await screen.findByTestId("name-gate.error")).textContent).toBe(
      "sync.memberRoster.nameErrorTooLong",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(field().value).toBe("Ada");
  });

  // Story 7: quitting here is not a lockout. The gate must write nothing at all if
  // the user walks away, so the vault it left behind is exactly the accepted one.
  it("writes nothing when it is abandoned", async () => {
    listRoster.mockResolvedValue(rosterWithSelf({ name_state: "absent" }));
    render(<MemberNameGate onDone={vi.fn()} />);
    await screen.findByTestId("name-gate.input");
    cleanup();
    expect(setMyMemberName).not.toHaveBeenCalled();
  });

  it("survives an unreadable roster by asking, not by guessing", async () => {
    listRoster.mockRejectedValue(new Error("relay down"));
    render(<MemberNameGate onDone={vi.fn()} />);
    expect(await screen.findByTestId("name-gate.input")).toBeDefined();
  });
});
