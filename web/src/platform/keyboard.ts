// Platform seam (web) — the chords a browser keeps for itself
// (phase3-web-client task 66).
//
// See `src/platform/keyboard.ts` for why this is a seam and why the
// reconciliation is presentational (the keymap syncs; a web session must never
// rewrite what desktop stored).
//
// # What is in the table, and what a wrong entry costs
//
// The list below is the UNION across the three target browsers (Chromium,
// Firefox, Safari — `prd.md`; Edge is proxied by Chromium and that is a proxy,
// stated in the PRD's own risk list), with each entry naming which of them it
// applies to. It is knowledge, not a measurement: no test can assert "the tab
// really closed" without driving browser chrome, and a page cannot observe
// whether the host acted — `preventDefault()` on a reserved chord returns
// exactly the same nothing whether it worked or not.
//
// That is survivable because the failure is asymmetric. **Over-listing** costs
// the user one binding they could have had, with a visible explanation.
// **Under-listing** costs them a binding that silently does nothing — which is
// the status quo this task exists to end. So when a chord is arguable, it is
// listed, and the tier says how sure we are.
//
// # `Mod` is the accelerator, and the reservations follow it
//
// `Mod` is Cmd on macOS and Ctrl elsewhere (`src/commands/chord.ts`), and the
// browser reservations track the same key: Cmd+W and Ctrl+W both close a tab.
// Chords reserved on ONE platform only (Cmd+M minimise; Ctrl+Shift+Q quit) are
// filtered by `isMacPlatform()`, so a Linux user is not told that Cmd+M is
// unavailable on a machine that has no Cmd key.

import { isMacPlatform, normalizeChord } from "../../../src/commands/chord";
import type {
  ReservedChord,
  ReservedTier,
  TargetBrowser,
} from "../../../src/platform/keyboard";

export type { ReservedChord, ReservedTier, TargetBrowser };

const ALL: readonly TargetBrowser[] = ["chromium", "firefox", "safari"];

/** Which platform an entry applies to. `both` is the default. */
type Applies = "both" | "mac" | "other";

interface Entry {
  chord: string;
  tier: ReservedTier;
  browsers: readonly TargetBrowser[];
  actionKey: string;
  applies?: Applies;
}

// The `actionKey`s resolve under `settings.hotkeys.reserved.*` and describe what
// the BROWSER does — never what Myne would have done. The user's question when
// they see the badge is "why can't I have this", and the answer is the browser's
// behaviour.
const TABLE: readonly Entry[] = [
  // ── tab and window lifecycle: the hardest of the hard ────────────────────
  { chord: "Mod-w", tier: "hard", browsers: ALL, actionKey: "closeTab" },
  { chord: "Mod-Shift-w", tier: "hard", browsers: ALL, actionKey: "closeWindow" },
  { chord: "Mod-t", tier: "hard", browsers: ALL, actionKey: "newTab" },
  { chord: "Mod-Shift-t", tier: "hard", browsers: ALL, actionKey: "reopenTab" },
  { chord: "Mod-n", tier: "hard", browsers: ALL, actionKey: "newWindow" },
  { chord: "Mod-Shift-n", tier: "hard", browsers: ALL, actionKey: "newPrivateWindow" },
  // Firefox uses Ctrl/Cmd+Shift+P for its private window; Chromium and Safari
  // leave it to the page. Listed for the browser that takes it, not for all.
  { chord: "Mod-Shift-p", tier: "hard", browsers: ["firefox"], actionKey: "newPrivateWindow" },
  { chord: "Mod-q", tier: "hard", browsers: ALL, actionKey: "quit", applies: "mac" },
  // Ctrl+Shift+Q on Windows/Linux Firefox. Written `Mod-` because `Mod` IS Ctrl
  // there — spelling it `Ctrl-` would produce a chord string that can never
  // match, since `eventToChord` only emits a literal `Ctrl` token on macOS.
  { chord: "Mod-Shift-q", tier: "hard", browsers: ["firefox"], actionKey: "quit", applies: "other" },

  // ── browser chrome the page cannot take ─────────────────────────────────
  { chord: "Mod-l", tier: "hard", browsers: ALL, actionKey: "focusAddressBar" },
  { chord: "Mod-Shift-a", tier: "hard", browsers: ["firefox"], actionKey: "openExtensions" },
  { chord: "Mod-m", tier: "hard", browsers: ALL, actionKey: "minimiseWindow", applies: "mac" },
  { chord: "Mod-h", tier: "hard", browsers: ALL, actionKey: "hideApplication", applies: "mac" },

  // ── tab switching by number ─────────────────────────────────────────────
  //
  // Nine entries rather than a range, because the panel matches whole canonical
  // chords and a range would need a second matching rule for one case.
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: `Mod-${i + 1}`,
    tier: "hard" as ReservedTier,
    browsers: ALL,
    actionKey: "switchTab",
  })),

  // ── developer tools ─────────────────────────────────────────────────────
  { chord: "Mod-Alt-i", tier: "hard", browsers: ALL, actionKey: "openDevTools", applies: "mac" },
  { chord: "Mod-Shift-i", tier: "hard", browsers: ["chromium", "firefox"], actionKey: "openDevTools", applies: "other" },
  { chord: "Mod-Shift-j", tier: "hard", browsers: ["chromium"], actionKey: "openDevTools", applies: "other" },
  { chord: "Mod-Shift-c", tier: "hard", browsers: ["chromium", "firefox"], actionKey: "inspectElement", applies: "other" },
  { chord: "F12", tier: "hard", browsers: ["chromium", "firefox"], actionKey: "openDevTools", applies: "other" },

  // ── the unreliable tier ─────────────────────────────────────────────────
  //
  // These reach the page in some target browsers and not others, or depend on a
  // setting the user controls. Binding one is not dead weight everywhere — it is
  // a binding that works on some of their machines, which is its own kind of
  // confusing, so it is surfaced rather than refused outright.
  // Tab cycling. Two spellings of the same physical keys: a literal `Ctrl`
  // token only exists on macOS, and on every other platform Ctrl IS `Mod`.
  { chord: "Ctrl-Tab", tier: "unreliable", browsers: ALL, actionKey: "cycleTabs", applies: "mac" },
  { chord: "Ctrl-Shift-Tab", tier: "unreliable", browsers: ALL, actionKey: "cycleTabs", applies: "mac" },
  { chord: "Mod-Tab", tier: "unreliable", browsers: ALL, actionKey: "cycleTabs", applies: "other" },
  { chord: "Mod-Shift-Tab", tier: "unreliable", browsers: ALL, actionKey: "cycleTabs", applies: "other" },
  { chord: "F11", tier: "unreliable", browsers: ["chromium", "firefox"], actionKey: "toggleFullscreen", applies: "other" },
  { chord: "Mod-o", tier: "unreliable", browsers: ALL, actionKey: "openFile" },
  { chord: "Mod-d", tier: "unreliable", browsers: ALL, actionKey: "bookmarkPage" },
  { chord: "Mod-h", tier: "unreliable", browsers: ["chromium", "firefox"], actionKey: "openHistory", applies: "other" },
  { chord: "Mod-y", tier: "unreliable", browsers: ["chromium"], actionKey: "openHistory", applies: "mac" },
  { chord: "Mod-Shift-o", tier: "unreliable", browsers: ["chromium", "firefox"], actionKey: "openBookmarks" },
];

function applicable(e: Entry, mac: boolean): boolean {
  if (e.applies === undefined || e.applies === "both") return true;
  return e.applies === "mac" ? mac : !mac;
}

function toReserved(e: Entry): ReservedChord {
  return {
    chord: normalizeChord(e.chord),
    tier: e.tier,
    browsers: e.browsers,
    actionKey: e.actionKey,
  };
}

export function reservedChord(chord: string): ReservedChord | null {
  const mac = isMacPlatform();
  const want = normalizeChord(chord);
  const hit = TABLE.find((e) => applicable(e, mac) && normalizeChord(e.chord) === want);
  return hit ? toReserved(hit) : null;
}

export function allReservedChords(): readonly ReservedChord[] {
  const mac = isMacPlatform();
  return TABLE.filter((e) => applicable(e, mac)).map(toReserved);
}
