// @vitest-environment jsdom
//
// Component tests for the scope-expansion gate's FOURTH fact
// (`src/notes/agent/components/AgentProgress.tsx`, myne-md/myne#529): whether
// approving sends more note text off the device.
//
// **This shipped inert, and the shape is the one this repo keeps finding.** The
// fact was rendered by `ScopeExpansionDialog` behind an `arm` prop, that prop
// had a `"none"` default, and its single call site passed nothing. So the line
// rendered on neither arm, the prop's own doc comment explained why the
// component could not resolve the fact itself (a premise that was wrong: the
// resolver it named is one function away), and nothing failed. `tsc` is happy
// with an unpassed optional prop, and so is every guard in `scripts/`.
//
// So these tests are keyed on the RENDERED line and on which arm it claims,
// never on the prop. `ag5` asserts the same thing against the real binary and
// runs only where the desktop E2E lane does; this runs in `pnpm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const aiCapabilityReport = vi.fn();
vi.mock("../../src/lib/ai-capability", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/lib/ai-capability")
  >("../../src/lib/ai-capability");
  return { ...actual, aiCapabilityReport: () => aiCapabilityReport() };
});

// The preview is the host's arithmetic and has its own coverage; here it only
// has to resolve so the dialog gets past its `preview !== null` gate.
vi.mock("../../src/lib/agent-run", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/agent-run")>(
      "../../src/lib/agent-run",
    );
  return {
    ...actual,
    agentPreviewGrant: () =>
      Promise.resolve({ noteCount: 2, excludedCount: 0, newTotal: 5 }),
  };
});

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { ai_provider: "openrouter" } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.provider !== undefined ? `${key}:${String(opts.provider)}` : key,
  }),
}));

import { AgentProgress } from "../../src/notes/agent/components/AgentProgress";
import {
  beginRun,
  clearAgentForLock,
  settleStep,
} from "../../src/notes/agent/agentStore";

function awaitingScope() {
  beginRun();
  settleStep({
    view: {
      runId: "run-1",
      scopeTotal: 3,
      userGrants: 1,
      modelGrants: 0,
      cancelled: false,
    },
    proposal: { edits: [], newNotes: [], summary: "" },
    end: { kind: "awaitingScope", folder: "Projects", reason: "it says so" },
    iterations: 1,
    notesRead: 1,
    charsOffDevice: null,
    excludedCount: 0,
  });
}

const REPORT = {
  compiled: true,
  backendId: "x",
  backendClass: "in_process_local",
  generation: { available: true, cause: null },
  embedding: { available: true, cause: null },
  transcription: { available: true, cause: null },
  autoTag: { available: true, cause: null },
};

beforeEach(() => {
  aiCapabilityReport.mockReset();
});

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("the expansion gate's egress line", () => {
  it("is rendered on the local arm, and says the notes stay here", async () => {
    aiCapabilityReport.mockResolvedValue(REPORT);
    awaitingScope();
    render(<AgentProgress />);
    const line = await screen.findByTestId("agentScope.egress");
    expect(line.textContent).toBe("agent.scope.egressLocal");
  });

  it("is rendered on the remote arm, and NAMES the provider", async () => {
    // The other direction, so a component that hardcoded the local line would
    // fail here. The provider name is the part that makes the claim actionable.
    aiCapabilityReport.mockResolvedValue({ ...REPORT, backendClass: "remote" });
    awaitingScope();
    render(<AgentProgress />);
    const line = await screen.findByTestId("agentScope.egress");
    expect(line.textContent).toBe("agent.scope.egressRemote:OpenRouter");
  });

  it("claims nothing when the build carries no AI", async () => {
    // `answeredByOf` reads an unknown class as `in-process`, so without an
    // explicit check this case would have rendered "they do not leave the
    // device" from a report that answered nothing.
    aiCapabilityReport.mockResolvedValue({
      compiled: false,
      backendId: null,
      backendClass: null,
      generation: { available: false, cause: null },
      embedding: { available: false, cause: null },
      transcription: { available: false, cause: null },
      autoTag: { available: false, cause: null },
    });
    awaitingScope();
    render(<AgentProgress />);
    // The dialog still appears; only the egress claim is withheld.
    await screen.findByTestId("agentScope.dialog");
    await waitFor(() =>
      expect(screen.queryByTestId("agentScope.egress")).toBeNull(),
    );
  });
});
