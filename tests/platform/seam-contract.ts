// The platform-seam contract (phase3-web-client task 3).
//
// ONE assertion suite, run against EVERY implementation of `src/platform/`.
// It is the load-bearing test of the web-client architecture: the reason the
// desktop E2E suite is not dual-driven against a browser is "it is the same
// `src/` tree, only the seam differs". Nothing verified that premise before
// this file — the desktop seam's own behaviour was unpinned too.
//
// What it asserts, per module:
//   - call shape: arguments reach the underlying transport verbatim, and the
//     transport's resolved value comes back unwrapped. `invoke`'s
//     `(cmd, args) => Promise` in particular is the contract the whole UI is
//     written against.
//   - error propagation: a rejecting transport rejects the seam call with the
//     SAME value. No swallowing, no re-wrapping, no stringification — the
//     callers pattern-match on Rust error enums (`src/types/`).
//   - subscribe/unsubscribe lifecycle: `listen` resolves an unlisten function,
//     handlers receive events until it is called and not after.
//   - the typed unsupported outcome: an operation an implementation declares
//     unsupported rejects with `PlatformUnsupportedError` and nothing else.
//
// Parameterisation: a caller supplies a `SeamSubject` — how to load the seam
// modules, how to program the transport underneath them, and which operations
// this platform supports. `tests/platform/tauri-seam.test.ts` is the first
// subject; the web implementation (task 25) is the second and adds no
// assertions here.

import { describe, expect, it, beforeEach } from "vitest";
import {
  isPlatformUnsupported,
  type SeamOperation,
} from "../../src/platform/unsupported";

/** The shape of `src/platform/*`, as the contract exercises it. */
export interface SeamModules {
  core: {
    invoke: (cmd: string, args?: unknown) => Promise<unknown>;
    Channel: new <T>() => { onmessage: ((m: T) => void) | null };
  };
  event: {
    listen: (
      name: string,
      handler: (e: { event: string; payload: unknown }) => void,
    ) => Promise<() => void>;
  };
  dialog: {
    open: (opts?: unknown) => Promise<unknown>;
    save: (opts?: unknown) => Promise<unknown>;
    confirm: (message: string, opts?: unknown) => Promise<boolean>;
  };
  opener: {
    openUrl: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    revealItemInDir: (path: string) => Promise<void>;
  };
  path: {
    appDataDir: () => Promise<string>;
    join: (...parts: string[]) => Promise<string>;
  };
  window: { getCurrentWindow: () => { destroy: () => Promise<void> } };
  webviewWindow: {
    getCurrentWebviewWindow: () => {
      listen: (name: string, handler: (e: unknown) => void) => Promise<() => void>;
    };
  };
  clipboardManager: {
    writeText: (text: string) => Promise<void>;
  };
  deepLink: {
    loadDeepLink: () => Promise<{
      getCurrent: () => Promise<string[] | null>;
      onOpenUrl: (h: (urls: string[]) => void) => Promise<() => void>;
    }>;
  };
}

/**
 * How the contract drives one implementation.
 *
 * `program` is the seam of the seam: the contract must be able to say "the
 * thing underneath resolves X" / "rejects Y" / "emits this event" without
 * knowing whether that thing is Tauri IPC or a wasm Worker.
 */
export interface SeamSubject {
  /** Display name — appears in the test titles. */
  name: string;
  /** Load the seam modules. Called once per test, AFTER `reset()`. */
  load: () => Promise<SeamModules>;
  /** Drop all programmed transport behaviour and recorded calls. */
  reset: () => void;
  /** Program the transport under the seam. */
  program: {
    /** Next call to any transport entry point resolves with `value`. */
    resolveWith: (value: unknown) => void;
    /** Next call to any transport entry point rejects with `err`. */
    rejectWith: (err: unknown) => void;
    /** Every argument tuple the transport received, oldest first. */
    calls: () => unknown[][];
    /** Deliver `payload` to every live subscriber of `name`. */
    emit: (name: string, payload: unknown) => void;
    /** How many subscribers are currently registered for `name`. */
    subscriberCount: (name: string) => number;
  };
  /** Operations this platform implements. Anything absent must reject typed. */
  supports: ReadonlySet<SeamOperation>;
}

/** Run the whole contract against one implementation. */
export function runSeamContract(subject: SeamSubject): void {
  describe(`platform seam contract — ${subject.name}`, () => {
    let seam: SeamModules;

    beforeEach(async () => {
      subject.reset();
      seam = await subject.load();
    });

    /**
     * Every operation gets exactly one of two treatments: the supported
     * assertions, or the single unsupported assertion. Neither is skippable —
     * an implementation cannot quietly opt out of an operation by omitting it,
     * because omission IS a claim ("unsupported") that gets asserted.
     */
    function contractFor(
      op: SeamOperation,
      supported: () => Promise<void> | void,
      call: () => Promise<unknown>,
    ) {
      if (subject.supports.has(op)) {
        it(`${op} — forwards and unwraps`, supported);
      } else {
        it(`${op} — rejects with the typed unsupported outcome`, async () => {
          const err = await call().then(
            () => {
              throw new Error(`${op} resolved; an unsupported op must reject`);
            },
            (e: unknown) => e,
          );
          expect(isPlatformUnsupported(err)).toBe(true);
          expect((err as { operation: string }).operation).toBe(op);
        });
      }
    }

    // ── core ────────────────────────────────────────────────────────────
    contractFor(
      "core.invoke",
      async () => {
        subject.program.resolveWith({ ok: true });
        const out = await seam.core.invoke("plugin:notes|note_read", { id: "n1" });
        expect(out).toEqual({ ok: true });
        // Arity and order are the contract: (cmd, args), nothing injected.
        expect(subject.program.calls()[0]).toEqual([
          "plugin:notes|note_read",
          { id: "n1" },
        ]);
      },
      () => seam.core.invoke("plugin:notes|note_read", { id: "n1" }),
    );

    if (subject.supports.has("core.invoke")) {
      it("core.invoke — accepts a command with no arguments", async () => {
        subject.program.resolveWith(null);
        await seam.core.invoke("vault_status");
        expect(subject.program.calls()[0][0]).toBe("vault_status");
      });

      it("core.invoke — rejects with the transport's value, unwrapped and unwrapped-again", async () => {
        // Callers pattern-match on Rust error enums serialized as objects
        // (`src/types/*`). A seam that stringified or wrapped this would turn
        // every `catch (e) { if (e.kind === …) }` in the UI into a silent miss.
        const rustError = { kind: "IoError", message: "EACCES" };
        subject.program.rejectWith(rustError);
        const caught = await seam.core
          .invoke("vault_unlock", { password: "x" })
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(caught).toBe(rustError);
      });
    }

    contractFor(
      "core.Channel",
      () => {
        const ch = new seam.core.Channel<string>();
        const seen: string[] = [];
        ch.onmessage = (m) => seen.push(m);
        // A Channel is a value the caller constructs and passes INTO invoke;
        // the contract is that it is constructible and carries an assignable
        // `onmessage`, which is the whole surface `ai-chat.ts`/`transcribe.ts` use.
        ch.onmessage?.("token");
        expect(seen).toEqual(["token"]);
      },
      async () => {
        new seam.core.Channel<string>();
        return undefined;
      },
    );

    // ── event ───────────────────────────────────────────────────────────
    contractFor(
      "event.listen",
      async () => {
        const seen: unknown[] = [];
        const unlisten = await seam.event.listen("sync://changed", (e) =>
          seen.push(e.payload),
        );
        expect(typeof unlisten).toBe("function");
        expect(subject.program.subscriberCount("sync://changed")).toBe(1);

        subject.program.emit("sync://changed", { note: "n1" });
        expect(seen).toEqual([{ note: "n1" }]);

        // Unsubscribe must actually detach — a leaked listener survives the
        // React effect that owns it and fires against an unmounted tree.
        unlisten();
        expect(subject.program.subscriberCount("sync://changed")).toBe(0);
        subject.program.emit("sync://changed", { note: "n2" });
        expect(seen).toEqual([{ note: "n1" }]);
      },
      () => seam.event.listen("sync://changed", () => {}),
    );

    if (subject.supports.has("event.listen")) {
      it("event.listen — a second subscriber on the same name is independent", async () => {
        const a: unknown[] = [];
        const b: unknown[] = [];
        const unA = await seam.event.listen("x", (e) => a.push(e.payload));
        await seam.event.listen("x", (e) => b.push(e.payload));
        expect(subject.program.subscriberCount("x")).toBe(2);
        unA();
        subject.program.emit("x", 1);
        expect(a).toEqual([]);
        expect(b).toEqual([1]);
      });
    }

    // ── dialog ──────────────────────────────────────────────────────────
    contractFor(
      "dialog.open",
      async () => {
        subject.program.resolveWith("/tmp/pick.md");
        const picked = await seam.dialog.open({ multiple: false });
        expect(picked).toBe("/tmp/pick.md");
        expect(subject.program.calls()[0]).toEqual([{ multiple: false }]);
      },
      () => seam.dialog.open({ multiple: false }),
    );

    if (subject.supports.has("dialog.open")) {
      it("dialog.open — a cancelled pick resolves null, it does not reject", async () => {
        // Cancellation is a normal outcome, not an error; every caller in
        // `src/` branches on a null return.
        subject.program.resolveWith(null);
        expect(await seam.dialog.open()).toBeNull();
      });
    }

    contractFor(
      "dialog.save",
      async () => {
        subject.program.resolveWith("/tmp/out.pdf");
        expect(await seam.dialog.save({ defaultPath: "out.pdf" })).toBe("/tmp/out.pdf");
      },
      () => seam.dialog.save({ defaultPath: "out.pdf" }),
    );

    contractFor(
      "dialog.confirm",
      async () => {
        subject.program.resolveWith(true);
        expect(await seam.dialog.confirm("Delete?", { title: "Myne" })).toBe(true);
        // The MESSAGE must reach the platform, and the boolean must come back.
        // The options deliberately are NOT asserted: they are presentation
        // (title, button labels, kind), `window.confirm` accepts none of them,
        // and the browser owns its own dialog chrome. Asserting them would have
        // encoded a desktop-only capability into a cross-platform contract.
        //
        // The web seam's resulting loss — a browser-titled dialog instead of a
        // Myne-titled one — is real and is documented at the implementation
        // (`web/src/platform/dialog.ts`) rather than hidden by a passing test.
        expect(subject.program.calls()[0][0]).toBe("Delete?");
      },
      () => seam.dialog.confirm("Delete?"),
    );

    // ── opener ──────────────────────────────────────────────────────────
    contractFor(
      "opener.openUrl",
      async () => {
        subject.program.resolveWith(undefined);
        await seam.opener.openUrl("https://myne.md");
        expect(subject.program.calls()[0]).toEqual(["https://myne.md"]);
      },
      () => seam.opener.openUrl("https://myne.md"),
    );

    contractFor(
      "opener.openPath",
      async () => {
        subject.program.resolveWith(undefined);
        await seam.opener.openPath("/vault/note.myn");
        expect(subject.program.calls()[0]).toEqual(["/vault/note.myn"]);
      },
      () => seam.opener.openPath("/vault/note.myn"),
    );

    contractFor(
      "opener.revealItemInDir",
      async () => {
        subject.program.resolveWith(undefined);
        await seam.opener.revealItemInDir("/vault");
        expect(subject.program.calls()[0]).toEqual(["/vault"]);
      },
      () => seam.opener.revealItemInDir("/vault"),
    );

    // ── path ────────────────────────────────────────────────────────────
    contractFor(
      "path.appDataDir",
      async () => {
        subject.program.resolveWith("/home/u/.local/share/md.myne.desktop");
        expect(await seam.path.appDataDir()).toBe("/home/u/.local/share/md.myne.desktop");
      },
      () => seam.path.appDataDir(),
    );

    contractFor(
      "path.join",
      async () => {
        // RESULT only — deliberately not "reached the transport".
        //
        // Joining path segments is pure string arithmetic. Tauri happens to do
        // it over IPC; the web seam does it locally, which is correct AND avoids
        // a round trip. Asserting the forwarding would have been asserting the
        // desktop's *mechanism* rather than the seam's guarantee, and it would
        // have failed a better implementation. (Found when the web subject
        // landed — `path.appDataDir` genuinely must forward, because only the
        // host knows the answer; `join` does not.)
        subject.program.resolveWith("/a/b/c");
        expect(await seam.path.join("/a", "b", "c")).toBe("/a/b/c");
      },
      () => seam.path.join("/a", "b"),
    );

    // ── window ──────────────────────────────────────────────────────────
    contractFor(
      "window.destroy",
      async () => {
        subject.program.resolveWith(undefined);
        await seam.window.getCurrentWindow().destroy();
        expect(subject.program.calls().length).toBeGreaterThan(0);
      },
      () => seam.window.getCurrentWindow().destroy(),
    );

    // ── webviewWindow ───────────────────────────────────────────────────
    contractFor(
      "webviewWindow.listen",
      async () => {
        const seen: unknown[] = [];
        const unlisten = await seam.webviewWindow
          .getCurrentWebviewWindow()
          .listen("tauri://blur", (e) => seen.push(e));
        expect(subject.program.subscriberCount("tauri://blur")).toBe(1);
        unlisten();
        expect(subject.program.subscriberCount("tauri://blur")).toBe(0);
      },
      () => seam.webviewWindow.getCurrentWebviewWindow().listen("tauri://blur", () => {}),
    );

    // ── clipboard ───────────────────────────────────────────────────────
    // Write only. `readText` / `clear` left the seam with myne#379 — the
    // recovery-kit auto-clear's read+compare moved host-side, and the two
    // `clipboard-manager:` grants behind them left `capabilities/default.json`
    // with it. There is deliberately no contract for a member no host offers.
    contractFor(
      "clipboard.writeText",
      async () => {
        subject.program.resolveWith(undefined);
        await seam.clipboardManager.writeText("secret");
        expect(subject.program.calls()[0]).toEqual(["secret"]);
      },
      () => seam.clipboardManager.writeText("secret"),
    );

    // ── deep link ───────────────────────────────────────────────────────
    contractFor(
      "deepLink.onOpenUrl",
      async () => {
        const mod = await seam.deepLink.loadDeepLink();
        expect(typeof mod.getCurrent).toBe("function");
        expect(typeof mod.onOpenUrl).toBe("function");
        const seen: string[][] = [];
        const un = await mod.onOpenUrl((urls) => seen.push(urls));
        expect(typeof un).toBe("function");
      },
      async () => {
        const mod = await seam.deepLink.loadDeepLink();
        return mod.onOpenUrl(() => {});
      },
    );
  });
}
