// Flow-logic: the first-run vault-creation onboarding (E2E-gap #5, the primary
// path every new user takes). Headless Chromium + mock IPC — NOT end-to-end (no
// real Argon2id, no on-disk vault). What IS flow-testable: the full
// Welcome → briefing → name → password → recovery kit → type-back (which commits)
// → auto-unlock → editor chain drives the real begin/commit/unlock IPC wrappers.
//
// The shape changed in myne-md/myne#468: a vault-NAME step opens the flow, the
// phrase and account-number steps merged into one recovery kit, and the
// type-back's own button is the commit. The account step's "I have saved my
// account number" checkbox is gone rather than moved — `protocol.md` §7.1.3 says
// a bare checkbox is not evidence, and the type-back already is.
//
// The mock `begin` returns 24× the same word so the RANDOM 4-word type-back
// challenge is satisfiable by typing that word everywhere (the flow picks four
// random positions we can't predict).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { createIdentityToHome, startVaultFromIdentityHome, IDENTITY_SETUP_RESULT } from "../helpers";

const PHRASE_WORD = "ribbon";

async function ackBriefing(page: Page): Promise<void> {
  // Three acknowledgement rows must all be checked before Continue enables. They
  // are found by `data-ack-id` — the shared statement ids — rather than by their
  // text: the copy comes from the same catalogue keys the desktop briefing uses
  // now, so an English fragment would break on the first translation.
  for (const id of ["no-store", "phrase-backup", "no-email"]) {
    await page.locator(`[data-ack-id="${id}"]`).first().click();
  }
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe("mobile create-vault onboarding", () => {
  test("Welcome → … → commit → auto-unlock → editor", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personSetupResult: IDENTITY_SETUP_RESULT,
    });
    await page.goto("/");

    // Welcome (fresh install, no vaults). The phone's first run is ONE door
    // (myne-md/myne#911 task 12): the identity is created first, and the vault
    // follows from the identity home. This spec is about the vault half, so the
    // identity ceremony is the helper's job.
    await createIdentityToHome(page);
    await startVaultFromIdentityHome(page);

    // The safety briefing (first-run only, and unnumbered for that reason).
    await ackBriefing(page);

    // Step 1 — name the vault. Named rather than skipped: the value is written as
    // the vault's label after the auto-unlock, and it heads the recovery kit.
    await page.getByTestId("create-vault.name-input").fill("Flow Kasa");
    await page.getByTestId("create-vault.name-continue").click();

    // Step 2 — password + confirm (two masked inputs, no testids).
    const pwInputs = page.locator('input[type="password"]');
    await expect(pwInputs).toHaveCount(2);
    await pwInputs.nth(0).fill("correct horse battery staple");
    await pwInputs.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    // Encrypting overlay auto-advances (mock `begin` resolves instantly) to the
    // recovery kit. Step 3 — BOTH secrets in one sheet, which is the merge: the
    // account number has no step of its own to arrive on later.
    await expect(page.getByTestId("create-vault.kit-sheet")).toBeVisible();
    await expect(page.getByTestId("create-vault.kit-meta")).toHaveText("Flow Kasa");
    await page.getByRole("button", { name: /Show words/ }).click();

    // Save writes the KIT — both secrets, from the shared `recoveryKitText` the
    // desktop uses — not the phrase the step this replaced wrote. A save path
    // still writing only the phrase reports the same success sentence, so the
    // contents are read off the IPC. Shape only, never printed.
    await page.getByTestId("create-vault.kit-save").click();
    const saved = await page.evaluate(async () => {
      const w = window as unknown as { __secretSaves?: { path: string; contents: string }[] };
      for (let i = 0; i < 50 && (w.__secretSaves ?? []).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 40));
      }
      return w.__secretSaves ?? [];
    });
    expect(saved.length, "nothing was written").toBe(1);
    expect(saved[0].path.endsWith("myne-recovery-kit.txt")).toBe(true);
    const lines = saved[0].contents.split("\n").map((l: string) => l.trim());
    expect(
      lines.some((l: string) => l.split(/\s+/).length === 24),
      "no 24-word line in the saved kit",
    ).toBe(true);
    expect(
      lines.some((l: string) => /^MY(-[0-9A-Z]{4}){4}-[0-9A-Z]$/.test(l)),
      "no account number in the saved kit",
    ).toBe(true);
    expect(saved[0].contents.includes("Flow Kasa"), "the kit does not name its vault").toBe(
      true,
    );

    await page.getByRole("button", { name: "I've written them down" }).click();

    // Step 4 — type-back, and its own button COMMITS. There is no fifth step and
    // no acknowledgement checkbox between the two.
    const wordCells = page.locator("input");
    await expect(wordCells).toHaveCount(4);
    for (let i = 0; i < 4; i++) await wordCells.nth(i).fill(PHRASE_WORD);
    await expect(
      page.getByText("I have saved my account number"),
      "the acknowledgement checkbox came back",
    ).toHaveCount(0);
    await page.getByTestId("create-vault.commit").click();

    // Ready → open the new vault → editor.
    await page.getByRole("button", { name: "Open vault" }).click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    // The name becomes the vault's LABEL, and it has to happen after the unlock:
    // `prefs|vault_set_label` writes under the active vault's `prefs_key`, so it
    // is unlock-gated and there is no slot to write into during creation. Every
    // way this breaks is quiet — writing at commit time rejects with
    // `SlotNotUnlocked` on a flow that has already succeeded, and an empty label
    // is a legitimate value meaning "no name". So the user names their vault,
    // lands in the editor, and finds it called "Vault 2".
    expect(
      await page.evaluate(
        () => (window as unknown as { __vaultLabelWrites?: (string | null)[] }).__vaultLabelWrites ?? [],
      ),
    ).toEqual(["Flow Kasa"]);
  });

  test("a vault left unnamed writes no label at all", async ({ page }) => {
    // Blank is a legitimate answer on the name step, and the right result is the
    // picker's neutral fallback rather than a written `null`: the two look
    // identical to a user and one of them costs a prefs write on every unnamed
    // vault. An assertion on an ABSENCE, so the walk to the editor is the control
    // that proves the flow ran at all.
    await installMockIpc(page, {
      freshDevice: true,
      personSetupResult: IDENTITY_SETUP_RESULT,
    });
    await page.goto("/");
    await createIdentityToHome(page);
    await startVaultFromIdentityHome(page);
    await ackBriefing(page);

    // Straight past the name step without typing, which is the point.
    await page.getByTestId("create-vault.name-continue").click();

    const pwInputs = page.locator('input[type="password"]');
    await expect(pwInputs).toHaveCount(2);
    await pwInputs.nth(0).fill("correct horse battery staple");
    await pwInputs.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: /Show words/ }).click();
    await page.getByRole("button", { name: "I've written them down" }).click();
    const wordCells = page.locator("input");
    await expect(wordCells).toHaveCount(4);
    for (let i = 0; i < 4; i++) await wordCells.nth(i).fill(PHRASE_WORD);
    await page.getByTestId("create-vault.commit").click();
    await page.getByRole("button", { name: "Open vault" }).click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    expect(
      await page.evaluate(
        () => (window as unknown as { __vaultLabelWrites?: (string | null)[] }).__vaultLabelWrites ?? [],
      ),
    ).toEqual([]);
  });

  test("the briefing's Why? disclosure animates open and closed", async ({ page }) => {
    // The mobile half of myne-md/myne#868; the desktop half is
    // `tests/create/briefing-step.test.tsx`. Both pin the same four things: the
    // body is absent at rest, the entrance mounts COLLAPSED and flips on the next
    // frame, the exit keeps the node until the motion has settled, and the curve
    // follows the direction.
    //
    // The click runs INSIDE `page.evaluate` and the read waits only on
    // MICROTASKS. React commits a discrete event in a microtask, and the flip to
    // `1fr` is a `requestAnimationFrame` callback, which cannot run until the
    // current task's microtasks have drained. So the read lands after the commit
    // and before the frame, which is what makes these states deterministic
    // instead of a race against the 240ms deferral.
    await installMockIpc(page, {
      freshDevice: true,
      personSetupResult: IDENTITY_SETUP_RESULT,
    });
    await page.goto("/");
    await createIdentityToHome(page);
    await startVaultFromIdentityHome(page);

    const why = page.getByTestId("create-vault.briefing-why").first();
    const body = page.getByTestId("create-vault.briefing-why-text");
    await expect(body).toHaveCount(0);
    await expect(why).toHaveAttribute("aria-expanded", "false");

    const opened = await page.evaluate(async () => {
      const btn = document.querySelector(
        '[data-testid="create-vault.briefing-why"]',
      ) as HTMLButtonElement;
      btn.click();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const text = document.querySelector(
        '[data-testid="create-vault.briefing-why-text"]',
      );
      const grid = text?.parentElement?.parentElement as HTMLElement | null;
      const svg = btn.querySelector("svg") as SVGElement | null;
      return {
        present: text !== null,
        expanded: btn.getAttribute("aria-expanded"),
        opacity: grid?.style.opacity ?? null,
        transition: grid?.style.transition ?? null,
        chevron: svg?.style.transform ?? null,
        chevronTransition: svg?.style.transition ?? null,
      };
    });
    // Mounted by the click and still at the COLLAPSED value: the flip to `1fr`
    // is on the next frame, which is what gives the transition a painted value
    // to start from. The chevron turns over in place rather than swapping glyphs;
    // it follows `whyOpen`, which is already true in this commit.
    expect(opened).toMatchObject({ present: true, expanded: "true", opacity: "0" });
    // The curve is read off the SAME commit as the value that changes, so at
    // this instant it is still the closing one: it becomes the entrance curve
    // only when the flip lands, which is asserted below.
    expect(opened.transition).toContain("var(--ease-standard)");
    expect(opened.chevron).toBe("rotate(180deg)");
    expect(opened.chevronTransition).toContain("var(--ease-out)");

    // It reaches its resting state and stays there, on the ENTRANCE curve: the
    // curve is read off the same commit as the value that changes, so it is the
    // closing one until the flip lands.
    await expect(body).toHaveCount(1);
    await expect(body).toBeVisible();
    // The grid's opacity is written on the requestAnimationFrame after the
    // commit. In a loaded browser the visible node can therefore still be at
    // `0` for one frame after `toBeVisible()`, so poll the value instead of
    // reading it in the same turn and turning a frame of scheduling into a red.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const text = document.querySelector(
            '[data-testid="create-vault.briefing-why-text"]',
          );
          const grid = text?.parentElement?.parentElement as HTMLElement | null;
          return grid?.style.opacity ?? null;
        }),
      )
      .toBe("1");
    const settled = await page.evaluate(() => {
      const text = document.querySelector(
        '[data-testid="create-vault.briefing-why-text"]',
      );
      const grid = text?.parentElement?.parentElement as HTMLElement | null;
      return {
        opacity: grid?.style.opacity ?? null,
        transition: grid?.style.transition ?? null,
      };
    });
    expect(settled).toMatchObject({ opacity: "1" });
    expect(settled.transition).toContain("var(--ease-out)");

    const closed = await page.evaluate(async () => {
      const btn = document.querySelector(
        '[data-testid="create-vault.briefing-why"]',
      ) as HTMLButtonElement;
      btn.click();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const text = document.querySelector(
        '[data-testid="create-vault.briefing-why-text"]',
      );
      const grid = text?.parentElement?.parentElement as HTMLElement | null;
      return {
        present: text !== null,
        expanded: btn.getAttribute("aria-expanded"),
        opacity: grid?.style.opacity ?? null,
        transition: grid?.style.transition ?? null,
      };
    });
    // The node is STILL MOUNTED, transparent, on the closing curve: the collapse
    // plays out and only then does the body leave.
    expect(closed).toMatchObject({ present: true, expanded: "false", opacity: "0" });
    expect(closed.transition).toContain("var(--ease-standard)");

    // And it does leave, which is the DOM contract both tiers pin.
    await expect(body).toHaveCount(0);
  });

  test("the Why? disclosure resolves instantly under reduced motion", async ({ page }) => {
    // The mobile twin of the reduced-motion case in
    // `tests/create/briefing-step.test.tsx`. On the phone this arm carries more
    // than it does on desktop: the global `prefers-reduced-motion` rule zeroes
    // the TRANSITION, but the unmount deferral is a timer, so without the skip
    // a reduced-motion user would still hold a collapsed body for 240ms.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installMockIpc(page, {
      freshDevice: true,
      personSetupResult: IDENTITY_SETUP_RESULT,
    });
    await page.goto("/");
    await createIdentityToHome(page);
    await startVaultFromIdentityHome(page);

    const body = page.getByTestId("create-vault.briefing-why-text");
    await expect(body).toHaveCount(0);

    const opened = await page.evaluate(async () => {
      const btn = document.querySelector(
        '[data-testid="create-vault.briefing-why"]',
      ) as HTMLButtonElement;
      btn.click();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const text = document.querySelector(
        '[data-testid="create-vault.briefing-why-text"]',
      );
      const grid = text?.parentElement?.parentElement as HTMLElement | null;
      return { present: text !== null, opacity: grid?.style.opacity ?? null };
    });
    // Visible in the commit the click produced: there is no hidden frame to flip
    // from, which is the assertion the animated path cannot make.
    expect(opened).toMatchObject({ present: true, opacity: "1" });

    const closed = await page.evaluate(async () => {
      const btn = document.querySelector(
        '[data-testid="create-vault.briefing-why"]',
      ) as HTMLButtonElement;
      btn.click();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      return document.querySelector('[data-testid="create-vault.briefing-why-text"]') !== null;
    });
    // Gone in the same commit: the deferral is SKIPPED rather than shortened.
    expect(closed).toBe(false);
  });
});
