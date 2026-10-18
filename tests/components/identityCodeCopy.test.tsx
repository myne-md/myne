// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getToasts, resetToasts } from "../../src/components/toast/toastStore";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

const writeTextMock = vi.hoisted(() => vi.fn());
const personListInvitesMock = vi.hoisted(() => vi.fn());
const personAcceptInviteMock = vi.hoisted(() => vi.fn());
const startB2bMigrationMock = vi.hoisted(() => vi.fn());
const listRosterMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: writeTextMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { label: "Test vault" } }),
}));

vi.mock("../../src/hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

vi.mock("../../src/hooks/useRoster", () => ({
  useRoster: () => ({
    members: [],
    authority: "owner",
    groupKeyEpoch: null,
    loading: false,
    error: null,
    reload: vi.fn(),
    lockPerson: vi.fn().mockResolvedValue(undefined),
    inviting: false,
    lastInvite: null,
    invite: vi.fn().mockResolvedValue(null),
    vaultInvites: [],
    vaultInvitesFailed: false,
    // Shared, so the invite box is reachable without the migration confirmation
    // (myne-md/myne#783).
    shared: true,
    removing: false,
    remove: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../src/components/PasswordInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/components/PasswordInput")>();
  return { ...real, usePasswordStrength: () => ({ ready: true, result: { score: 4 } }) };
});

vi.mock("../../src/lib/personAccount", () => ({
  personListInvites: personListInvitesMock,
  personAcceptInvite: personAcceptInviteMock,
}));

vi.mock("../../src/lib/invite", () => ({
  startB2bMigration: startB2bMigrationMock,
  listRoster: listRosterMock,
}));

vi.mock("../../src/lib/memberNames", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/memberNames")>();
  return { ...real, setMyMemberName: vi.fn() };
});

import { MemberRosterPanel } from "../../src/components/sync/MemberRosterPanel";
import { PHRASE_CELL_COUNT } from "../../src/components/PhraseEntryGrid";
import { IdentityHome } from "../../src/screens/IdentityHome";

/** Comfortably over the project floor and zxcvbn-clean (the hook is stubbed). */
const ACCEPT_PASSWORD = "correct horse battery staple";

const OWNER_CODE = `MYNE-PERSON-1:${"11".repeat(16)}:${"22".repeat(32)}:${"33".repeat(32)}:${"44".repeat(48)}`;
const IDENTITY_CODE = `MYNE-PERSON-1:${"55".repeat(16)}:${"66".repeat(32)}:${"77".repeat(32)}:${"88".repeat(48)}`;

function fillIdentityPhrase(): void {
  for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
    fireEvent.change(
      screen.getByTestId(
        index === 0
          ? "identity-home.accept-phrase"
          : `identity-home.accept-phrase-cell-${index + 1}`,
      ),
      { target: { value: `word${index + 1}` } },
    );
  }
}

function expectedIdentityPhrase(): string {
  return Array.from({ length: PHRASE_CELL_COUNT }, (_, index) => `word${index + 1}`).join(" ");
}

function fillPhrase(): void {
  // Identity code copy is asserted once the identity is unlocked. The roster no
  // longer owns a phrase grid (myne-md/myne#831); the fixture seeds the shared
  // store the panel reads.
  setPersonIdentityState({ ready: true, ownerCode: OWNER_CODE });
}

const surfaces = [
  {
    name: "member roster owner code",
    code: OWNER_CODE,
    codeTestId: "member-roster.owner-code",
    copyTestId: "member-roster.copy-owner-code",
    feedbackTestId: "member-roster.copy-feedback",
    render: () => render(<MemberRosterPanel />),

    prepare: async () => {
      fillPhrase();
      await screen.findByTestId("member-roster.person-ready");
    },
  },
  {
    name: "identity home code",
    code: IDENTITY_CODE,
    codeTestId: "identity-home.identity-code",
    copyTestId: "identity-home.copy-code",
    feedbackTestId: "identity-home.copy-feedback",
    render: () =>

      render(
        <IdentityHome
          identityCode={IDENTITY_CODE}
          onCreateVault={() => {}}
          onAccepted={() => {}}
          onForgotten={() => {}}
        />,
      ),
    prepare: async () => {},
  },
] as const;

beforeEach(() => {
  writeTextMock.mockReset().mockResolvedValue(undefined);
  personListInvitesMock.mockReset().mockResolvedValue([]);
  personAcceptInviteMock.mockReset().mockResolvedValue(undefined);
  startB2bMigrationMock.mockReset();
  // The post-accept name gate (myne-md/myne#851 task 8) sits between the accept
  // and `onAccepted`, which several tests here assert. This file is about the
  // phrase and the identity code, so the caller is already named and the gate
  // resolves on its own; the gate itself is covered by `memberNameGate.test.tsx`
  // and by `identityHomeAccept.test.tsx`.
  listRosterMock.mockReset().mockResolvedValue({
    members: [
      {
        fingerprint_hex: "aa".repeat(32),
        is_self: true,
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
    ],
    authority: "member",
    group_key_epoch: 3,
  });
  resetPersonIdentityState();
  resetToasts();
});

afterEach(() => {
  cleanup();
  resetPersonIdentityState();
  resetToasts();
});

describe.each(surfaces)("$name", (surface) => {
  it("renders the exact code and supports full keyboard or pointer selection", async () => {
    surface.render();
    await surface.prepare();

    const code = screen.getByTestId(surface.codeTestId) as HTMLInputElement;
    expect(code.value).toBe(surface.code);
    expect(code.readOnly).toBe(true);
    expect(code.style.userSelect).toBe("all");
    code.focus();
    expect(document.activeElement).toBe(code);
    code.setSelectionRange(0, code.value.length);
    expect(code.selectionStart).toBe(0);
    expect(code.selectionEnd).toBe(code.value.length);
  });

  it("copies the displayed bytes and reports success", async () => {
    surface.render();
    await surface.prepare();

    await act(async () => {
      fireEvent.click(screen.getByTestId(surface.copyTestId));
    });

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(surface.code));
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].variant).toBe("info");
    expect(getToasts()[0].message).toBe("personIdentityCode.copied");
    expect(screen.getByTestId(surface.feedbackTestId).textContent).toBe("personIdentityCode.copied");
  });

  it("reports a clipboard failure instead of presenting it as success", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    surface.render();
    await surface.prepare();

    await act(async () => {
      fireEvent.click(screen.getByTestId(surface.copyTestId));
    });

    await waitFor(() => expect(getToasts()).toHaveLength(1));
    expect(getToasts()[0].variant).toBe("error");
    expect(getToasts()[0].message).toBe("personIdentityCode.copyFailed");
    expect(screen.getByTestId(surface.feedbackTestId).textContent).toBe("personIdentityCode.copyFailed");
  });
});

describe("identity-code textareas are themed", () => {
  // #767. Both fields are the two ends of ONE handshake — the owner pastes the
  // invitee's code in the roster, the invitee pastes the owner's code on their
  // identity home — and both shipped unstyled, so the WebView painted its
  // default white field with black text on a dark panel. Asserted over BOTH in
  // one table so the pair cannot drift: fixing one and forgetting the other
  // still leaves a user staring at a white box.
  //
  // The property is "carries the theme's own surface and ink", not a list of
  // declarations: `background`/`color` are what a UA default overrides, and
  // they are the two that go blank the moment the style prop is dropped.
  const fields = [
    {
      name: "member roster invite box",
      testId: "member-roster.invite-code",
      open: async () => {
        // The invite control is owner-only AND needs an unlocked identity, so
        // the state is set BEFORE the render rather than driving 24 cells and
        // a backend round trip to reach the same place.
        setPersonIdentityState({ ready: true, ownerCode: OWNER_CODE });
        render(<MemberRosterPanel />);
        await act(async () => {
          fireEvent.click(screen.getByTestId("member-roster.invite-button"));
        });
      },
    },
    {
      name: "identity home accept box",
      testId: "identity-home.accept-owner-code",
      open: async () => {
        personListInvitesMock.mockResolvedValue([
          { invite_id_hex: "invite-1", vault_account_hash_hex: "aa".repeat(16), claimed: false },
        ]);
        render(
          <IdentityHome
            identityCode={IDENTITY_CODE}
            onCreateVault={() => {}}
            onAccepted={() => {}}
            onForgotten={() => {}}
          />,
        );
        await screen.findByTestId("identity-home.invite-row");
        fireEvent.click(screen.getByTestId("identity-home.accept-open"));
      },
    },
  ] as const;

  for (const field of fields) {
    it(`paints the ${field.name} from tokens, not the UA default`, async () => {
      await field.open();

      const box = screen.getByTestId(field.testId) as HTMLTextAreaElement;
      expect(box.style.background).toBe("var(--paper-2)");
      expect(box.style.color).toBe("var(--fg-1)");
      expect(box.style.borderRadius).toBe("var(--radius-1)");
      expect(box.style.resize).toBe("vertical");
    });
  }
});

describe("IdentityHome invite phrase", () => {
  it("requires all 24 cells and sends the joined phrase", async () => {
    personListInvitesMock.mockResolvedValue([
      {
        invite_id_hex: "invite-1",
        vault_account_hash_hex: "aa".repeat(16),
        claimed: false,
      },
    ]);
    const onAccepted = vi.fn();
    render(
      <IdentityHome
        identityCode={IDENTITY_CODE}
        onCreateVault={() => {}}
        onAccepted={onAccepted}
        onForgotten={() => {}}
      />,
    );

    await screen.findByTestId("identity-home.invite-row");
    fireEvent.click(screen.getByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    // Two steps now (myne-md/myne#871): the owner's code releases the owner step,
    // the 24 cells release the phrase step.
    fireEvent.click(screen.getByTestId("identity-home.accept-continue"));
    await screen.findByTestId("identity-home.accept-phrase-grid");
    fillIdentityPhrase();
    fireEvent.click(screen.getByTestId("identity-home.accept-continue"));
    await screen.findByTestId("identity-home.accept.password-input");
    // The accept form now carries a REQUIRED device-local password (myne-md/myne#851
    // task 7), and its own submit is the accept button: the phrase alone no longer
    // enables it.
    expect(
      (screen.getByTestId("identity-home.accept.submit") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("identity-home.accept.password-input"), {
      target: { value: ACCEPT_PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.accept.confirm-input"), {
      target: { value: ACCEPT_PASSWORD },
    });
    expect(
      (screen.getByTestId("identity-home.accept.submit") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("identity-home.accept.submit"));

    await waitFor(() =>
      expect(personAcceptInviteMock).toHaveBeenCalledWith(
        "invite-1",
        OWNER_CODE,
        expectedIdentityPhrase(),
        ACCEPT_PASSWORD,
      ),
    );
    expect(onAccepted).toHaveBeenCalledOnce();
  });
});
