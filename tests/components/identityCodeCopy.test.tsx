// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getToasts, resetToasts } from "../../src/components/toast/toastStore";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

const writeTextMock = vi.hoisted(() => vi.fn());
const unlockPersonMock = vi.hoisted(() => vi.fn());
const personListInvitesMock = vi.hoisted(() => vi.fn());
const personAcceptInviteMock = vi.hoisted(() => vi.fn());
const inspectInviteCodeMock = vi.hoisted(() => vi.fn());
const startB2bMigrationMock = vi.hoisted(() => vi.fn());

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
    unlockPerson: unlockPersonMock,
    lockPerson: vi.fn().mockResolvedValue(undefined),
    inviting: false,
    lastInvite: null,
    invite: vi.fn().mockResolvedValue(null),
    vaultInvites: [],
    vaultInvitesFailed: false,
    removing: false,
    remove: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../src/lib/personAccount", () => ({
  personListInvites: personListInvitesMock,
  personAcceptInvite: personAcceptInviteMock,
}));

vi.mock("../../src/lib/invite", () => ({
  inspectInviteCode: inspectInviteCodeMock,
  startB2bMigration: startB2bMigrationMock,
}));

import { MemberRosterPanel } from "../../src/components/sync/MemberRosterPanel";
import { PHRASE_CELL_COUNT } from "../../src/components/sync/EnrollPhraseCredential";
import { IdentityHome } from "../../src/screens/IdentityHome";

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
  for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
    fireEvent.change(
      screen.getByTestId(
        index === 0 ? "member-roster.phrase-input" : `member-roster.phrase-cell-${index + 1}`,
      ),
      { target: { value: index === 0 ? "abandon" : "about" } },
    );
  }
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
       await act(async () => {

        fireEvent.click(screen.getByTestId("member-roster.person-unlock-button"));
      });
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
          personIdHex={"99".repeat(16)}
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
  unlockPersonMock.mockReset().mockResolvedValue({
    fingerprint_hex: "00".repeat(32),
    person_id_hex: "11".repeat(16),
    identity_code: OWNER_CODE,
  });
  personListInvitesMock.mockReset().mockResolvedValue([]);
  personAcceptInviteMock.mockReset().mockResolvedValue(undefined);
  inspectInviteCodeMock.mockReset();
  startB2bMigrationMock.mockReset();
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
            personIdHex={"99".repeat(16)}
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
    inspectInviteCodeMock.mockResolvedValue({ fingerprint_hex: "bb".repeat(32) });
    const onAccepted = vi.fn();
    render(
      <IdentityHome
        personIdHex={"99".repeat(16)}
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
    fireEvent.click(screen.getByTestId("identity-home.accept-inspect"));
    await screen.findByTestId("identity-home.accept-sas");
    fireEvent.click(screen.getByTestId("identity-home.accept-confirm"));
    fillIdentityPhrase();
    expect((screen.getByTestId("identity-home.accept-submit") as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("identity-home.accept-submit"));

    await waitFor(() =>
      expect(personAcceptInviteMock).toHaveBeenCalledWith(
        "invite-1",
        OWNER_CODE,
        expectedIdentityPhrase(),
      ),
    );
    expect(onAccepted).toHaveBeenCalledOnce();
  });
});
