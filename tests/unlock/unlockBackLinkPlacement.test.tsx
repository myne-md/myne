// @vitest-environment jsdom
//
// Where the way OUT of the unlock screen sits (myne-md/myne#773).
//
// The screen was deboxed and the back control went with the rest of the chrome
// into the page's top-right, beside "create a vault". That is wrong and the
// reason generalises: a global action belongs in the top bar, and this is not
// one — it is the escape from the specific question the heading asks, so it
// belongs against that question. Reading order says the same thing. A user
// arriving at "Unlock your vault" should meet the way out BEFORE the demand,
// not after it, in a corner, in a different landmark.
//
// It has no test otherwise: moving it broke nothing, typechecked, and left the
// control perfectly clickable — which is exactly why it moved without anyone
// noticing until it was on screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {} }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));

import { Unlock } from "../../src/screens/Unlock";

const STATUS_CMD = "plugin:quick-unlock|quick_unlock_status";
const VAULT_LIST_CMD = "plugin:vault-unlock|vault_list";

/** Two vaults, so the back-to-picker control is offered at all. */
function renderWithTwoVaults() {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === STATUS_CMD) {
      return Promise.resolve({ configured: false, method: null, available: false });
    }
    if (cmd === VAULT_LIST_CMD) {
      return Promise.resolve([{ id: "a" }, { id: "b" }]);
    }
    return Promise.resolve(undefined);
  });
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onResumeRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
      onBack={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the way back sits with the question it answers", () => {
  it("sits in the top-left corner of the screen (#772)", async () => {
    // Moved on request: with the centred mark above the question, the corner
    // is empty, and the top-left is where a back control is looked for. It is
    // the header's start slot, never the end one beside global actions.
    const { container } = renderWithTwoVaults();
    const back = await screen.findByTestId("unlock.back-to-picker");
    const header = container.querySelector("header") as HTMLElement;
    expect(header.contains(back), "the back control is not in the top bar").toBe(true);
    expect(header.firstElementChild?.contains(back), "the back control is not at the start").toBe(
      true,
    );
  });

  it("is a labelled control, not a bare glyph", async () => {
    renderWithTwoVaults();
    // It carries its own words, unlike the icon-only chrome it briefly joined.
    // At this size an unlabelled arrow on a pre-unlock screen is a guess.
    const back = await screen.findByTestId("unlock.back-to-picker");
    expect(back.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // …and the arrow beside those words is an icon rather than a text glyph,
    // which `editor/src/host/lib/icons.ts` asks for by name: a character
    // inherits the text metrics and sits off the label's baseline at every size.
    expect(back.querySelector("svg"), "the arrow is a text character").not.toBeNull();
  });

  it("is withdrawn while an attempt is in flight", async () => {
    // Unchanged by the move, and worth keeping honest: leaving it during
    // `decrypting` offers to abandon an unlock mid-IPC.
    const { container } = renderWithTwoVaults();
    await screen.findByTestId("unlock.back-to-picker");
    const input = screen.getByTestId("unlock.password-input");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(input, { target: { value: "something" } });
    fireEvent.click(screen.getByTestId("unlock.submit"));
    await waitFor(() =>
      expect(screen.queryByTestId("unlock.back-to-picker")).toBeNull(),
    );
    void container;
  });

  it("keeps the title and its subtitle as one tight pair", async () => {
    renderWithTwoVaults();
    await screen.findByTestId("unlock.back-to-picker");
    // The heading's own pair is tighter than the section gap around it.
    const heading = screen.getByRole("heading", { level: 1 });
    const group = heading.parentElement as HTMLElement;
    expect(group.style.gap, "the title and its subtitle are a section apart").toBe(
      "var(--space-1)",
    );
    expect(group.querySelector("p"), "the subtitle is outside the group").not.toBeNull();
  });

  it("sits in the upper third, and gives that bias up rather than clipping", async () => {
    // Dead-centring five short rows leaves a large empty band above them.
    // The bias is two flexible spacers in a 1:2 ratio, NOT a `vh` padding —
    // which is the part worth pinning, because the two look identical on a
    // roomy window and differ completely on a cramped one. A padding takes
    // its height out of the content box, so an unlock carrying a suspicion
    // banner and an error would have a third less room and clip against
    // `max-height: 100%` on a surface that does not scroll. A `flex-basis: 0`
    // spacer takes only FREE space and collapses to nothing when there is
    // none.
    const { container } = renderWithTwoVaults();
    await screen.findByTestId("unlock.back-to-picker");
    const main = container.querySelector("main") as HTMLElement;
    const view = main.querySelector(".myne-auth-view") as HTMLElement;
    expect(view, "no content column").not.toBeNull();

    // The spacers BRACKET the column. Located by position around it rather
    // than by counting `main`'s children: the brand field is a sibling too,
    // and a count would have to be edited every time the region grows a
    // decoration, which is a test that tracks the DOM instead of the rule.
    const kids = Array.from(main.children) as HTMLElement[];
    const at = kids.indexOf(view);
    expect(at, "the column is not in the main region").toBeGreaterThan(0);
    const above = kids[at - 1]!;
    const below = kids[at + 1];
    expect(below, "nothing below the column to balance it").toBeTruthy();
    // The ratio, and its direction: more room below than above is what puts
    // the block high. Equal spacers would just be centring again.
    const growAbove = Number(above.style.flexGrow);
    const growBelow = Number(below!.style.flexGrow);
    expect(growAbove, "the spacer above does not grow").toBeGreaterThan(0);
    expect(growBelow, `${growBelow} below vs ${growAbove} above`).toBeGreaterThan(
      growAbove,
    );
    // Basis zero, which is what makes the bias a preference rather than a
    // reservation. `flex: 1` shorthand sets `flex-basis: 0%`.
    expect(above.style.flexBasis).toBe("0%");
    expect(below!.style.flexBasis).toBe("0%");
    // And no `vh` reservation crept back in beside them.
    expect(main.style.paddingBlockEnd ?? "").not.toMatch(/vh/);
    expect(main.style.padding ?? "").not.toMatch(/vh/);
    // The spacers are decoration; a screen reader must not meet two blank
    // groups on either side of the form.
    expect(above.getAttribute("aria-hidden")).toBe("true");
    expect(below!.getAttribute("aria-hidden")).toBe("true");
  });

  it("carries NO brand field: privacy is the default, not the topic", () => {
    // The `01` field went behind these screens for one commit
    // (`docs/decisions/ui/0625`) and was withdrawn the same day by `0626`. A
    // vault-unlock screen is the one moment the user is being asked for a
    // credential, and a field of ones and zeroes behind a password box is
    // "encryption as theme" arriving as texture instead of as a padlock —
    // which `PRODUCT.md`'s anti-references refuse by name.
    const { container } = renderWithTwoVaults();
    const main = container.querySelector("main") as HTMLElement;
    expect(main.querySelector("canvas"), "the brand field is back").toBeNull();
    // And the region does not still carry the clipping it needed for one.
    expect(main.style.overflow).not.toBe("hidden");
    const css = readFileSync(
      resolve(process.cwd(), "client-core/src/components.css"),
      "utf8",
    );
    expect(css, "the field's rules outlived the field").not.toContain(
      ".myne-auth__field",
    );
    expect(css, "the scrim outlived the field").not.toContain(".myne-auth-view::before");
  });

  it("offers the alternatives one per line, with destruction below a rule", async () => {
    // Two sentences side by side read as one run of link text with no seam, so
    // each alternative takes its own line. Deleting the vault is not a way to
    // open it, so it is not among them.
    renderWithTwoVaults();
    const recovery = await screen.findByTestId("unlock.recovery-link");
    const row = screen.getByTestId("unlock.alt-row");
    expect(row.contains(recovery), "the alternatives are not grouped").toBe(true);
    expect(row.style.display).toBe("flex");
    expect(row.style.flexDirection).toBe("column");
    // And each reads as a link on hover: the class carries the underline.
    expect(recovery.className).toContain("myne-text-link");

    const del = screen.getByTestId("unlock.delete-link");
    expect(row.contains(del), "destruction is offered as an alternative").toBe(false);
    // Below a rule, which is the whole device: it separates without shouting.
    const zone = del.parentElement as HTMLElement;
    expect(zone.style.borderTop, "nothing separates the destructive act").toContain(
      "var(--line-1)",
    );
    // And paired with a glyph. `PRODUCT.md`: colour is never the sole channel,
    // and this was a red word with nothing beside it.
    expect(del.querySelector("svg"), "the danger is colour alone").not.toBeNull();
  });
});
