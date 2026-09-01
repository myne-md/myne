// @vitest-environment jsdom
//
// The mobile scope surfaces (myne-md/myne#456 task 11).
//
// **What is under test is the GATE's content, not its look.** Under the chosen
// design this screen IS the bound: there is no cap on how far a run's scope may
// grow and no ceiling on how many times the model may ask, so what stops
// accumulation is that every widening is approved here with the running total
// visible while the user decides.
//
// The desktop dialog carries four facts and states in its own comment that none
// of them is decoration. Mobile renders a different LAYOUT of the same four
// (a bottom sheet, stacked actions), so the risk here is not a reworded fact,
// which the shared `agent.scope.*` keys rule out, but a MISSING one. That is
// exactly what a test can pin, so every fact below is asserted by presence.

import i18n from "@myne/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { clearAgent } from "@myne/agent-store";
import type { AgentRunView, GrantPreview } from "@myne/agent-protocol";

import { AiScopeSheet } from "../../src/app/flows/AiScopeSheet";

// The COMPLETE binding mock, from one place. See `helpers/agentRunMock.ts`.
import {
  agentApproveScope,
  agentCancel,
  agentPreviewGrant,
  agentRunModule,
  agentStart,
  resetAgentRunMock,
} from "../helpers/agentRunMock";

vi.mock("../../src/lib/agent-run", () => agentRunModule());

const prefs = { ai_provider: "openrouter" as string | null };
vi.mock("../../src/lib/use-prefs", () => ({
  usePrefs: () => ({ prefs }),
}));

const { AiChatFlow } = await import("../../src/app/flows/AiChatFlow");

const VIEW: AgentRunView = { runId: "run-1", scopeTotal: 4 };
const PREVIEW: GrantPreview = {
  noteCount: 12,
  excludedCount: 2,
  unknownCount: 0,
  newTotal: 16,
};

function sheet(overrides: Partial<Parameters<typeof AiScopeSheet>[0]> = {}) {
  const onApprove = vi.fn();
  const onDecline = vi.fn();
  render(
    <AiScopeSheet
      folder="Projects"
      noteCount={12}
      excludedCount={2}
      newTotal={16}
      reason="I need the older drafts to keep the wording consistent."
      arm="remote"
      providerName="OpenRouter"
      onApprove={onApprove}
      onDecline={onDecline}
      {...overrides}
    />,
  );
  return { onApprove, onDecline };
}

beforeEach(() => {
  resetAgentRunMock();
  agentPreviewGrant.mockResolvedValue(PREVIEW);
  prefs.ai_provider = "openrouter";
  clearAgent();
});
afterEach(cleanup);

describe("AiScopeSheet", () => {
  it("carries all four facts, and the count is not the folder name", () => {
    sheet();

    // 1 + 2: the grant line, which is the one that says READ AND CHANGE and
    // carries the count. "Projects" is not a size.
    expect(screen.getByTestId("agentScope.grant")).toBeTruthy();
    // 3: the running total, which is what the accumulation hazard needs. A
    // reader deciding on this one grant cannot see the hazard without it.
    expect(screen.getByTestId("agentScope.total")).toBeTruthy();
    // 4: the egress line, on the remote arm.
    expect(screen.getByTestId("agentScope.egress")).toBeTruthy();
    // And the exclusion count, stated rather than silently dropped.
    expect(screen.getByTestId("agentScope.excluded")).toBeTruthy();
  });

  it("says the notes leave the device only when they do", () => {
    // Two arms, not desktop's three. No model on a phone SERVES AN AGENT RUN, so
    // there is no device-local arm to describe, and the `"local"` branch this used
    // to exercise was unreachable code carrying desktop wording ("a program
    // running on this COMPUTER") that would have been wrong the day it fired.
    // Removed from the type with it, so there is no third member left to test.
    sheet({ arm: "remote" });
    expect(screen.getByTestId("agentScope.egress")).toBeTruthy();
    cleanup();
    sheet({ arm: "none" });
    // No arm, no claim either way. A device-local sentence under a run with no
    // backend would be asserting something nobody checked.
    expect(screen.queryByTestId("agentScope.egress")).toBeNull();
  });

  it("still offers both answers when the preview failed", () => {
    // The recorded defect this branch exists for: gating the sheet on a
    // successful fetch hid the decline button too, and a run waiting for an
    // answer the user cannot give is worse than an approval asked without its
    // numbers.
    const { onApprove, onDecline } = sheet({
      noteCount: null,
      excludedCount: null,
      newTotal: null,
    });
    expect(screen.getByTestId("agentScope.countsUnavailable")).toBeTruthy();
    // A null is not rendered as a zero. Zero says "this grant adds nothing";
    // null says "we could not find out".
    expect(screen.queryByTestId("agentScope.grant")).toBeNull();
    expect(screen.queryByTestId("agentScope.total")).toBeNull();

    screen.getByTestId("agentScope.decline").click();
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("renders the model's reason as its claim", () => {
    sheet();
    const quote = screen.getByTestId("agentScope.reason");
    // A blockquote rather than a paragraph, because note content can steer this
    // text and this screen is the surface it would be steering.
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote.textContent).toContain("older drafts");
  });

  it("puts the button that widens nothing where the thumb lands", () => {
    sheet();
    const bar = screen.getByTestId("agentScope.approve").parentElement;
    const order = Array.from(bar?.children ?? []).map((c) => c.getAttribute("data-testid"));
    // Stacked, decline LAST. The bottom edge is the easiest reach on a phone,
    // so it holds the safe answer and the approval is the deliberate one.
    expect(order).toEqual(["agentScope.approve", "agentScope.decline"]);
    expect((bar as HTMLElement).style.flexDirection).toBe("column");
  });
});

describe("AiChatFlow scope", () => {
  it("states the scope and the egress before anything is sent", async () => {
    render(<AiChatFlow grant={{ kind: "folder", value: "Projects" }} />);

    await waitFor(() => expect(screen.getByTestId("ai.scope-excluded")).toBeTruthy());
    expect(screen.getByTestId("ai.scope-label")).toBeTruthy();
    // The load-bearing half on a phone: the egress fact is on the SAME screen
    // as the send control, before the first tool call. A run ships the note-id
    // and title roster of its approved scope before it has read anything, so
    // the claim is already true at the first round-trip.
    expect(screen.getByTestId("ai.scope-egress")).toBeTruthy();
    expect(screen.getByTestId("ai.composer-send")).toBeTruthy();
    // And nothing was sent to get any of it. The preview resolves a grant; it
    // does not start a run.
    expect(agentStart).not.toHaveBeenCalled();
  });

  it("does not claim egress when no provider is configured", async () => {
    prefs.ai_provider = null;
    render(<AiChatFlow grant={{ kind: "folder", value: "Projects" }} />);
    await waitFor(() => expect(screen.getByTestId("ai.scope-excluded")).toBeTruthy());
    expect(screen.queryByTestId("ai.scope-egress")).toBeNull();
  });

  it("says the count could not be checked rather than showing a zero", async () => {
    agentPreviewGrant.mockRejectedValue(new Error("no index"));
    render(<AiChatFlow grant={{ kind: "folder", value: "Projects" }} />);
    // The strip is there either way; what changes is what it says.
    expect(screen.getByTestId("ai.scope-strip")).toBeTruthy();
    // The RESOLVED sentence, not the key. This asserted the key while the
    // harness returned keys verbatim; the catalogs resolve now, so the key form
    // would never appear and the check would have to be deleted rather than
    // fixed. Resolving through `i18n.t` keeps it pinning WHICH sentence.
    await waitFor(() =>
      expect(screen.getByTestId("ai.scope-label").textContent).toContain(
        i18n.t("agent.composer.scopeCountUnavailable"),
      ),
    );
    // An exclusion line with no numbers behind it would be a claim nobody
    // checked, so it is absent rather than zero.
    expect(screen.queryByTestId("ai.scope-excluded")).toBeNull();
  });

  it("asks when the run needs more, and grants it", async () => {
    agentStart.mockImplementation(
      // `_lang` and `_hist` are the two required arguments myne-md/myne#618
      // and #617 added between the grant and the callbacks.
      (_t: string, _g: unknown, _lang: unknown, _hist: unknown, onOpen: (v: AgentRunView) => void) => {
        onOpen(VIEW);
        return Promise.resolve({
          view: VIEW,
          proposal: { edits: [], newNotes: [], summary: "" },
          end: { kind: "awaitingScope" as const, folder: "Drafts", reason: "older drafts" },
          iterations: 1,
          notesRead: 0,
          charsOffDevice: 900,
          excludedCount: 0,
        });
      },
    );
    agentApproveScope.mockResolvedValue({
      view: VIEW,
      proposal: { edits: [], newNotes: [], summary: "Done." },
      end: { kind: "finished" as const },
      iterations: 1,
      notesRead: 3,
      charsOffDevice: 2000,
      excludedCount: 0,
    });
    render(<AiChatFlow grant={{ kind: "folder", value: "Projects" }} />);
    fireEvent.change(screen.getByTestId("ai.composer-input"), {
      target: { value: "align the wording" },
    });
    fireEvent.click(screen.getByTestId("ai.composer-send"));

    await waitFor(() => expect(screen.getByTestId("agentScope.dialog")).toBeTruthy());
    // The expansion's numbers are fetched AGAINST THE RUN, so the total is the
    // run's new total rather than the folder's own size.
    await waitFor(() =>
      expect(agentPreviewGrant).toHaveBeenCalledWith(
        { kind: "folder", value: "Drafts" },
        "run-1",
      ),
    );

    fireEvent.click(screen.getByTestId("agentScope.approve"));
    await waitFor(() => expect(agentApproveScope).toHaveBeenCalled());
    expect(agentApproveScope).toHaveBeenCalledWith(
      "run-1",
      { kind: "folder", value: "Drafts" },
      // The approved leg reports its cost too, or the figures freeze exactly
      // when widening makes the run expensive.
      expect.any(Function),
    );
    await waitFor(() => expect(screen.queryByTestId("agentScope.dialog")).toBeNull());
  });

  it("ends the run when the expansion is declined", async () => {
    agentStart.mockImplementation(
      // `_lang` and `_hist` are the two required arguments myne-md/myne#618
      // and #617 added between the grant and the callbacks.
      (_t: string, _g: unknown, _lang: unknown, _hist: unknown, onOpen: (v: AgentRunView) => void) => {
        onOpen(VIEW);
        return Promise.resolve({
          view: VIEW,
          proposal: { edits: [], newNotes: [], summary: "" },
          end: { kind: "awaitingScope" as const, folder: "Drafts", reason: "older drafts" },
          iterations: 1,
          notesRead: 0,
          charsOffDevice: 900,
          excludedCount: 0,
        });
      },
    );
    agentCancel.mockResolvedValue(true);
    render(<AiChatFlow grant={{ kind: "folder", value: "Projects" }} />);
    fireEvent.change(screen.getByTestId("ai.composer-input"), {
      target: { value: "align the wording" },
    });
    fireEvent.click(screen.getByTestId("ai.composer-send"));
    await waitFor(() => expect(screen.getByTestId("agentScope.dialog")).toBeTruthy());

    fireEvent.click(screen.getByTestId("agentScope.decline"));
    // Declining ENDS the run rather than continuing it narrower. The model
    // asked because it could not finish inside what it had, so "carry on
    // without it" is a promise neither client can keep.
    expect(agentCancel).toHaveBeenCalledWith("run-1");
    expect(agentApproveScope).not.toHaveBeenCalled();
  });
});
