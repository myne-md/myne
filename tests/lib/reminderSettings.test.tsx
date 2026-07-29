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
  it("renders the OS disclosure VERBATIM", () => {
    const { host, cleanup } = render(
      <ReminderSettings
        enabled
        showText={false}
        horizonDays={null}
        onEnabledChange={() => {}}
        onShowTextChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(q(host, "settings.reminders.disclosure")?.textContent).toBe(
      REMINDER_OS_DISCLOSURE_SENTENCE,
    );
    cleanup();
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

  it("the text opt-in has its own sentence, shown at the decision point", () => {
    const { host, cleanup } = render(
      <ReminderSettings
        enabled
        showText={false}
        horizonDays={null}
        onEnabledChange={() => {}}
        onShowTextChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(q(host, "settings.reminders.text-disclosure")?.textContent).toBe(
      REMINDER_SHOW_TEXT_SENTENCE,
    );
    cleanup();
  });

  it("neither sentence alarms", () => {
    for (const s of [REMINDER_OS_DISCLOSURE_SENTENCE, REMINDER_SHOW_TEXT_SENTENCE]) {
      expect(s).not.toMatch(/warning|danger|⚠|risk|insecure/i);
    }
  });
});

describe("the switch and the text opt-in", () => {
  it("the text opt-in defaults off — its own toggle, reported upward", () => {
    const onShowTextChange = vi.fn();
    const { host, cleanup } = render(
      <ReminderSettings
        enabled
        showText={false}
        horizonDays={null}
        onEnabledChange={() => {}}
        onShowTextChange={onShowTextChange}
        today="2026-07-28"
      />,
    );
    const toggle = q(host, "settings.reminders-text-toggle")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    cleanup();
  });

  it("hides the text opt-in and the horizon when reminders are off", () => {
    const { host, cleanup } = render(
      <ReminderSettings
        enabled={false}
        showText={false}
        horizonDays={null}
        onEnabledChange={() => {}}
        onShowTextChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(q(host, "settings.reminders-text-toggle")).toBeNull();
    expect(q(host, "settings.reminders.horizon")).toBeNull();
    // The disclosure stays: it explains what the switch does.
    expect(q(host, "settings.reminders.disclosure")).not.toBeNull();
    cleanup();
  });

  it("creates no new settings panel — it is a block, not a rail entry", () => {
    const { host, cleanup } = render(
      <ReminderSettings
        enabled
        showText={false}
        horizonDays={null}
        onEnabledChange={() => {}}
        onShowTextChange={() => {}}
      />,
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

  it("renders the date and is factual rather than alarming", () => {
    const { host, cleanup } = render(
      <ReminderSettings
        enabled
        showText={false}
        horizonDays={7}
        onEnabledChange={() => {}}
        onShowTextChange={() => {}}
        today="2026-07-28"
      />,
    );
    const line = q(host, "settings.reminders.horizon")!;
    expect(line.textContent).toContain("2026-08-03");
    expect(line.textContent).not.toMatch(/warning|will fail|lost|⚠/i);
    cleanup();
  });
});

describe("platform honesty (task 7)", () => {
  it("classifies macOS and Windows as pre-registered", () => {
    expect(reminderTier("macos")).toBe("pre-registered");
    expect(reminderTier("windows")).toBe("pre-registered");
  });

  it("classifies Linux as in-app only", () => {
    expect(reminderTier("linux")).toBe("in-app-only");
    expect(showsInAppOnlyLimitation("linux")).toBe(true);
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
