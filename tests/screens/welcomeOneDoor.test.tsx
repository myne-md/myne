// @vitest-environment jsdom

// The zero-vault entry screen has ONE create door (myne-md/myne#911 task 6).
//
// What this guards, stated as the failure: the screen used to draw a fork
// between "create an identity" and "create a local vault", and a user who took
// the second one ended up with a vault and no identity, could not be invited to
// anyone's vault, and never met the model Myne is built around. The fix is not a
// better label on the fork. It is that "create" now means one thing, on one
// button, and the two doors that remain create nothing.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const setLanguage = vi.fn().mockResolvedValue(true);
vi.mock("../../src/i18n", () => ({ setLanguage: (c: string) => setLanguage(c) }));

import { Welcome } from "../../src/screens/Welcome";

afterEach(() => cleanup());

function renderWelcome(overrides: Partial<Parameters<typeof Welcome>[0]> = {}) {
  const props = {
    onStart: vi.fn(),
    onRestoreBackup: vi.fn(),
    onInvited: vi.fn(),
    ...overrides,
  };
  render(<Welcome {...props} />);
  return props;
}

describe("Welcome first run", () => {
  it("offers ONE create door and no identity/local fork", () => {
    renderWelcome();
    expect(screen.getByTestId("welcome.create-cta")).toBeTruthy();
    // The fork's two buttons are the thing that went away, so both ids are
    // asserted absent rather than only the new one being present: a leftover
    // second door is exactly the regression.
    expect(screen.queryByTestId("welcome.identity-cta")).toBeNull();
    expect(screen.queryByTestId("welcome.local-cta")).toBeNull();
  });

  it("opens the first run from the create door", () => {
    const props = renderWelcome();
    fireEvent.click(screen.getByTestId("welcome.create-cta"));
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  it("keeps the doors that create nothing, and wires them", () => {
    const props = renderWelcome();
    fireEvent.click(screen.getByTestId("welcome.restore-cta"));
    fireEvent.click(screen.getByTestId("welcome.invited-cta"));
    expect(props.onRestoreBackup).toHaveBeenCalledTimes(1);
    expect(props.onInvited).toHaveBeenCalledTimes(1);
    // The account-number join door is gone (`decisions/sync/0767`): the invited
    // door is what replaced it, so both halves are asserted here.
    expect(screen.queryByTestId("welcome.join-cta")).toBeNull();
  });

  it("omits the restore door where the client cannot restore", () => {
    // Web answers `Unsupported` to the backup commands, so App omits the prop
    // rather than greying the row (`decisions.md` 2026-07-26).
    render(<Welcome onStart={vi.fn()} onInvited={vi.fn()} />);
    expect(screen.queryByTestId("welcome.restore-cta")).toBeNull();
  });

  // The invited door (myne-md/myne#911 follow-up). It creates an IDENTITY and no
  // vault, which is why it is a third door rather than a second create door: a
  // person invited to someone else's vault must not be pushed through vault
  // creation to reach their invitation.
  it("offers the invited door, and wires it", () => {
    const props = renderWelcome();
    fireEvent.click(screen.getByTestId("welcome.invited-cta"));
    expect(props.onInvited).toHaveBeenCalledTimes(1);
  });

  it("asks for no server address", () => {
    renderWelcome();
    // The first-run server step used to be reachable from here through the
    // identity dialog. Onboarding does not configure a server any more; its
    // endpoint control lives in Settings.
    expect(screen.queryByTestId("first-run-server.root")).toBeNull();
    expect(screen.queryByTestId("sync.endpoint-config")).toBeNull();
  });
});
