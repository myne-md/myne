// @vitest-environment jsdom
//
// Component tests for `src/components/sync/SyncUsageBlock.tsx` (MYND-570).
//
// The load-bearing distinction under test is `0 = unlimited`: the server's own
// convention for both `QuotaCeilingBytes` and `MYNE_MAX_DEVICES_PER_ACCOUNT`
// (`myne-server` `accountStatusView`). `0` must never be treated as a ceiling of
// zero — a client that did would draw a full meter against nothing, which is
// exactly the self-hosted / no-ceiling case that has to render neutral: usage
// figures, no meter, no limit language, no upsell.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SyncUsageBlock } from "../../src/components/sync/SyncUsageBlock";
import type { AccountStatus } from "../../src/hooks/useAccountStatus";

const GIB = 1024 * 1024 * 1024;

function status(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    stored_bytes: 3 * GIB,
    quota_bytes: 10 * GIB,
    device_count: 2,
    max_devices: 5,
    frozen: false,
    ...over,
  };
}

afterEach(cleanup);

describe("SyncUsageBlock", () => {
  it("renders figures and a meter when a ceiling is set", () => {
    render(<SyncUsageBlock showStorage status={status()} />);

    expect(screen.getByTestId("sync.usage")).toBeTruthy();
    expect(screen.getByTestId("sync.usage-storage").textContent).toContain("3 GiB");
    expect(screen.getByTestId("sync.usage-storage").textContent).toContain("10 GiB");
    expect(screen.getByTestId("sync.usage-devices").textContent).toContain("2");
    expect(screen.getByTestId("sync.usage-devices").textContent).toContain("5");

    const meter = screen.getByTestId("sync.usage-meter");
    expect(meter.getAttribute("aria-valuenow")).toBe(String(3 * GIB));
    expect(meter.getAttribute("aria-valuemax")).toBe(String(10 * GIB));
  });

  it("renders NO meter when the storage ceiling is unlimited (0)", () => {
    // The self-hosted / free-beta state: usage is real, the ceiling is absent.
    render(<SyncUsageBlock showStorage status={status({ quota_bytes: 0 })} />);

    expect(screen.queryByTestId("sync.usage-meter")).toBeNull();
    // The figure is still shown — only the "of <total>" comparison disappears.
    expect(screen.getByTestId("sync.usage-storage").textContent).toContain("3 GiB");
    expect(screen.getByTestId("sync.usage-storage").textContent).not.toContain("0 B");
  });

  it("shows a bare device count when the device cap is unlimited (0)", () => {
    render(<SyncUsageBlock showStorage status={status({ max_devices: 0 })} />);

    const devices = screen.getByTestId("sync.usage-devices").textContent ?? "";
    expect(devices).toContain("2");
    // No cap rendered — "0" must not appear as a limit.
    expect(devices).not.toContain("0");
  });

  it("omits the frozen badge by default and renders it when frozen", () => {
    const { unmount } = render(<SyncUsageBlock showStorage status={status()} />);
    expect(screen.queryByTestId("sync.usage-frozen")).toBeNull();
    unmount();

    render(<SyncUsageBlock showStorage status={status({ frozen: true })} />);
    expect(screen.getByTestId("sync.usage-frozen")).toBeTruthy();
  });

  it("renders ONE account figure, with no meter, when the status is a person total", () => {
    // myne-md/myne#911 task 11: a person account's stored bytes are a SUM over
    // its owned vaults, and the ceiling beside them is reported rather than
    // enforced (server-protocol §7.1). So this arm shows the total and what it
    // spans, and NO meter: a meter would claim an enforcement the server does not
    // perform, and the denominator would be a ceiling no single vault is judged
    // against.
    render(
      <SyncUsageBlock
        showStorage
        status={status({ stored_bytes: 5 * GIB, person: true, vault_count: 2 })}
      />,
    );

    const storage = screen.getByTestId("sync.usage-storage").textContent ?? "";
    expect(storage).toContain("5 GiB");
    // Not the per-vault "of <total>" shape, even with a ceiling set.
    expect(storage).not.toContain("10 GiB");
    expect(screen.queryByTestId("sync.usage-meter")).toBeNull();
    expect(screen.getByTestId("sync.usage-vault-count").textContent).toContain("2");
  });

  it("still renders a per-vault figure and meter when the status is not a person total", () => {
    // The same component, one bit different: a vault session keeps today's
    // rendering, which is what makes the person arm additive rather than a
    // replacement.
    render(
      <SyncUsageBlock
        showStorage
        status={status({ stored_bytes: 3 * GIB, person: false, vault_count: 0 })}
      />,
    );

    expect(screen.getByTestId("sync.usage-storage").textContent).toContain("10 GiB");
    expect(screen.getByTestId("sync.usage-meter")).toBeTruthy();
    expect(screen.queryByTestId("sync.usage-vault-count")).toBeNull();
  });

  it("clamps the meter when usage exceeds the ceiling", () => {
    // An over-quota account must not render a >100% bar.
    render(
      <SyncUsageBlock
        showStorage
        status={status({ stored_bytes: 12 * GIB, quota_bytes: 10 * GIB })}
      />,
    );
    const fill = screen.getByTestId("sync.usage-meter").firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });
});
