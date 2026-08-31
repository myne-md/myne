// @vitest-environment jsdom
//
// Reminder settings, platform honesty and the permission flow
// (MYND-618 tasks 7, 11, 12, 13).
//
// The disclosure sentences are asserted by **full-literal equality**, not by
// substring or by key. That is the load-bearing-copy discipline the export
// sentences already follow: their exact wording is a privacy statement, so a
// translation or a reword is a change to what Myne promises.

import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  REMINDER_IN_APP_ONLY_SENTENCE,
  REMINDER_LINUX_LIMITATION_SENTENCE,
  REMINDER_OS_DISCLOSURE_SENTENCE,
  REMINDER_SHOW_TEXT_SENTENCE,
} from "../../src/lib/load-bearing-copy";
import {
  detectReminderPlatform,
  reminderTier,
  showsInAppOnlyLimitation,
} from "../../src/lib/reminderPlatform";
import {
  requestReminderPermission,
  shouldRequestPermission,
  type ReminderPermissionApi,
} from "../../src/lib/reminderPermission";
import {
  horizonThrough,
  ReminderSettings,
} from "../../src/components/settings/ReminderSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

function render(node: React.ReactNode): { host: HTMLElement; cleanup: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const q = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`);

describe("the disclosure is load-bearing copy", () => {
  it("renders the sentence that is TRUE of this build, verbatim", () => {
    // While reminders are in-app only, nothing leaves the encrypted vault —
    // there is no OS registration to store times in. So the limitation is what
    // the user reads, and the disclosure of a cost this build does not impose
    // must NOT appear: disclosing a leak that does not exist is its own kind of
    // dishonesty, and it would also imply closed-app delivery that is not there.
    const { host, cleanup } = render(
      <ReminderSettings enabled onEnabledChange={() => {}} />,
    );
    expect(q(host, "settings.reminders.in-app-only")?.textContent).toBe(
      REMINDER_IN_APP_ONLY_SENTENCE,
    );
    expect(q(host, "settings.reminders.disclosure")).toBeNull();
    cleanup();
  });

  it("states the limitation without naming a platform", () => {
    // The Linux-specific sentence was right when Linux was the exception. Every
    // platform is in-app only in this build, and "On Linux…" on a Mac is false
    // in a way the user would notice.
    expect(REMINDER_IN_APP_ONLY_SENTENCE).toBe("Reminders appear only while Myne is open.");
    expect(REMINDER_IN_APP_ONLY_SENTENCE).not.toMatch(/linux|macos|windows/i);
    expect(REMINDER_LINUX_LIMITATION_SENTENCE).toContain("On Linux");
  });

  it("does not claim control over what the lock screen previews", () => {
    // The platform's preview settings are the user's, not ours; implying
    // otherwise would be a promise Myne cannot keep.
    expect(REMINDER_OS_DISCLOSURE_SENTENCE.toLowerCase()).not.toContain("lock screen");
    expect(REMINDER_OS_DISCLOSURE_SENTENCE.toLowerCase()).not.toContain("preview");
  });

  it("says what leaves the vault, and that the text does not", () => {
    expect(REMINDER_OS_DISCLOSURE_SENTENCE).toContain("outside the encrypted vault");
    expect(REMINDER_OS_DISCLOSURE_SENTENCE).toContain("not your task text");
  });

  it("does not render the task-text opt-in, which has no preference behind it", () => {
    // `vault.prefs` never gained a `reminder_show_text` field, so the toggle
    // could not persist. A switch that forgets is worse than an absent one; the
    // reviewed wording is kept for the tier that will carry it.
    const { host, cleanup } = render(
      <ReminderSettings enabled onEnabledChange={() => {}} />,
    );
    expect(q(host, "settings.reminders-text-toggle")).toBeNull();
    expect(q(host, "settings.reminders.text-disclosure")).toBeNull();
    cleanup();
  });

  it("no sentence alarms", () => {
    for (const s of [
      REMINDER_OS_DISCLOSURE_SENTENCE,
      REMINDER_SHOW_TEXT_SENTENCE,
      REMINDER_IN_APP_ONLY_SENTENCE,
    ]) {
      expect(s).not.toMatch(/warning|danger|⚠|risk|insecure/i);
    }
  });
});

describe("the switch", () => {
  it("keeps the limitation visible when reminders are off", () => {
    // It explains what the switch does, so it stays either way.
    const { host, cleanup } = render(
      <ReminderSettings enabled={false} onEnabledChange={() => {}} />,
    );
    expect(q(host, "settings.reminders.in-app-only")).not.toBeNull();
    cleanup();
  });

  it("creates no new settings panel — it is a block, not a rail entry", () => {
    const { host, cleanup } = render(
      <ReminderSettings enabled onEnabledChange={() => {}} />,
    );
    expect(host.querySelectorAll("[role='tablist']")).toHaveLength(0);
    cleanup();
  });
});

describe("the horizon line (task 13)", () => {
  it("states a DATE, not a day count", () => {
    // "through 3 August" is checkable against a calendar; "7 days" makes the
    // reader do the arithmetic and get it wrong.
    expect(horizonThrough(7, "2026-07-28")).toBe("2026-08-03");
  });

  it("honours an explicit horizon", () => {
    expect(horizonThrough(3, "2026-07-28")).toBe("2026-07-30");
  });

  it("falls back to the built-in horizon when unset", () => {
    expect(horizonThrough(null, "2026-07-28")).toBe(horizonThrough(7, "2026-07-28"));
  });

  it("is not rendered by the switch row, which owns no horizon at all", () => {
    // The line moved to `ReminderHorizonSettings` in myne#508, beside the
    // control that moves it. Its tier gate and its rendering are covered in
    // `reminderHorizonPicker.test.tsx`; what this pins is that the switch row
    // did not keep a second copy.
    const { host, cleanup } = render(<ReminderSettings enabled onEnabledChange={() => {}} />);
    expect(q(host, "settings.reminders.horizon")).toBeNull();
    cleanup();
  });
});

describe("platform honesty (task 7)", () => {
  it("claims in-app only on EVERY platform, because no adapter registers with an OS", () => {
    // This is a statement about what the build can deliver, not about what macOS
    // and Windows can do. Writing the OS-registration adapter is gated behind the
    // delivery measurement in `features/task-notifications-desktop/tasks.md`
    // (🔴, a live `[NEEDS DECISION]`, never run for our artifacts), so reporting
    // `pre-registered` here would put "arrives even when Myne is closed" in the
    // settings copy on the strength of an assumption.
    //
    // When the adapter lands, this test changes in the same commit — that is the
    // point of pinning it rather than leaving the tier implicit.
    for (const platform of ["macos", "windows", "linux", "unknown"] as const) {
      expect(reminderTier(platform)).toBe("in-app-only");
      expect(showsInAppOnlyLimitation(platform)).toBe(true);
    }
  });

  it("treats an UNKNOWN platform as in-app only", () => {
    // Claiming a delivery guarantee for a platform we could not identify is
    // exactly the promise this module exists to avoid making.
    expect(reminderTier("unknown")).toBe("in-app-only");
  });

  it("the limitation sentence states the limit and nothing more", () => {
    expect(REMINDER_LINUX_LIMITATION_SENTENCE).toBe(
      "On Linux, reminders appear only while Myne is open.",
    );
    expect(REMINDER_LINUX_LIMITATION_SENTENCE).not.toMatch(/unsupported|broken|cannot/i);
  });

  it("detects a platform without throwing outside a browser", () => {
    expect(["macos", "windows", "linux", "unknown"]).toContain(detectReminderPlatform());
  });
});

describe("the permission flow (task 12)", () => {
  const api = (
    status: Awaited<ReturnType<ReminderPermissionApi["status"]>>,
    answer = status,
  ): ReminderPermissionApi => ({
    status: async () => status,
    request: async () => answer,
  });

  it("asks at the FIRST reminder and not before", () => {
    expect(
      shouldRequestPermission("not-determined", { priorReminderCount: 0, alreadyAsked: false }),
    ).toBe(true);
    expect(
      shouldRequestPermission("not-determined", { priorReminderCount: 3, alreadyAsked: false }),
    ).toBe(false);
  });

  it("never asks twice automatically", () => {
    expect(
      shouldRequestPermission("not-determined", { priorReminderCount: 0, alreadyAsked: true }),
    ).toBe(false);
  });

  it("shows the in-app explanation BEFORE the platform dialog", async () => {
    const order: string[] = [];
    const result = await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      {
        api: {
          status: async () => "not-determined",
          request: async () => {
            order.push("platform");
            return "granted";
          },
        },
        explain: async () => {
          order.push("explain");
          return true;
        },
        markAsked: () => {},
      },
    );
    expect(order).toEqual(["explain", "platform"]);
    expect(result).toEqual({ outcome: "granted" });
  });

  it("never shows the platform dialog if the user backs out of the explainer", async () => {
    // The OS allows one prompt; spending it on a user who just declined the
    // explanation would waste it.
    const request = vi.fn(async () => "granted" as const);
    const result = await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      {
        api: { status: async () => "not-determined", request },
        explain: async () => false,
        markAsked: () => {},
      },
    );
    expect(request).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "skipped", reason: "declined-explainer" });
  });

  it("marks the ask BEFORE requesting, so a hung dialog cannot cause a second prompt", async () => {
    const order: string[] = [];
    await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      {
        api: {
          status: async () => "not-determined",
          request: async () => {
            order.push("request");
            return "denied";
          },
        },
        explain: async () => true,
        markAsked: () => void order.push("mark"),
      },
    );
    expect(order).toEqual(["mark", "request"]);
  });

  it("reports denial without re-prompting", async () => {
    const request = vi.fn(async () => "granted" as const);
    const result = await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      { api: { status: async () => "denied", request }, explain: async () => true, markAsked: () => {} },
    );
    expect(result).toEqual({ outcome: "denied" });
    expect(request).not.toHaveBeenCalled();
  });

  it("stays silent when permission was already granted", async () => {
    const result = await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      { api: api("granted"), explain: async () => true, markAsked: () => {} },
    );
    expect(result).toEqual({ outcome: "skipped", reason: "already-answered" });
  });

  it("never throws — a platform that errors reports unavailable", async () => {
    const result = await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      {
        api: {
          status: async () => {
            throw new Error("no such API");
          },
          request: async () => "granted",
        },
        explain: async () => true,
        markAsked: () => {},
      },
    );
    expect(result).toEqual({ outcome: "unavailable" });
  });

  it("an errored request is unavailable, not a false grant", async () => {
    const result = await requestReminderPermission(
      { priorReminderCount: 0, alreadyAsked: false },
      {
        api: {
          status: async () => "not-determined",
          request: async () => {
            throw new Error("dialog failed");
          },
        },
        explain: async () => true,
        markAsked: () => {},
      },
    );
    expect(result).toEqual({ outcome: "unavailable" });
  });
});
