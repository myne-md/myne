// The TS prefs surface for the remote AI provider (ai-remote-providers task 3,
// myne#415).
//
// What is worth testing here is not "the wrapper calls invoke" — it is the two
// confinements the design rests on, both of which are invisible to `tsc`:
//
//   1. **The key is not in the view.** `prefs_read` serializes the whole
//      host-side `PrefsView`; a key field in the TS mirror would be an
//      invitation to make the host send one. The absence is asserted against
//      the mirror's own declared shape, not against a runtime payload.
//   2. **Every setter goes through `writePref`.** That is the only path that
//      bumps the prefs nonce, and a sibling `usePrefs` re-reads on nothing
//      else. `scripts/check-prefs-nonce.mjs` enforces it statically; this spec
//      asserts the resulting behaviour, so a refactor that satisfies the guard
//      while breaking the bump still fails.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, bumpPrefsNonce } = vi.hoisted(() => ({
  // Typed with the real call shape so `invoke.mock.calls[n][1]` is a payload
  // rather than an index into an empty tuple.
  invoke: vi.fn(
    (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> =>
      Promise.resolve(undefined),
  ),
  bumpPrefsNonce: vi.fn(),
}));
vi.mock("../../src/platform/core", () => ({ invoke }));
vi.mock("../../src/notes/prefsNonce", () => ({ bumpPrefsNonce }));

import {
  aiProviderHasKey,
  setAiProvider,
  setAiProviderConsent,
  setAiProviderKey,
  type PrefsView,
} from "../../src/lib/prefs";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  bumpPrefsNonce.mockReset();
});

describe("remote-provider prefs — the TS surface", () => {
  it("has NO key field on the PrefsView mirror", () => {
    // A compile-time assertion, kept honest by being written as one: if
    // `ai_provider_key` were ever added to the mirror, `Extract` resolves to
    // that key and the `never` annotation fails to typecheck. A runtime check
    // could not see the difference between "absent from the type" and
    // "present but undefined at runtime", which is exactly the confusion this
    // guards against.
    type KeyOnView = Extract<keyof PrefsView, "ai_provider_key">;
    const mustBeNever: KeyOnView extends never ? true : false = true;
    expect(mustBeNever).toBe(true);

    // The two siblings that DO cross are present, so the assertion above is a
    // targeted absence rather than a mirror that forgot the whole feature.
    type Provider = Extract<keyof PrefsView, "ai_provider">;
    type Consent = Extract<keyof PrefsView, "ai_provider_consent">;
    const hasProvider: Provider extends never ? false : true = true;
    const hasConsent: Consent extends never ? false : true = true;
    expect(hasProvider && hasConsent).toBe(true);
  });

  it("routes every setter through writePref, so the nonce bumps", async () => {
    await setAiProvider("openrouter");
    await setAiProviderConsent(true);
    await setAiProviderKey("sk-secret");
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "plugin:prefs|set_ai_provider",
      "plugin:prefs|set_ai_provider_consent",
      "plugin:prefs|set_ai_provider_key",
    ]);
    // The bump is the whole reason `writePref` exists: without it a second
    // `usePrefs` consumer shows the old value for the rest of the session.
    expect(bumpPrefsNonce).toHaveBeenCalledTimes(3);
  });

  it("passes null through for clear and revoke rather than an empty string", async () => {
    await setAiProvider(null);
    await setAiProviderKey(null);
    expect(invoke.mock.calls[0][1]).toEqual({ provider: null });
    expect(invoke.mock.calls[1][1]).toEqual({ key: null });
  });

  it("reads has-key as a boolean and never bumps the nonce for it", async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(aiProviderHasKey()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:prefs|ai_provider_has_key");
    // It is a READ. Bumping here would invalidate every sibling's cache on a
    // question that changed nothing.
    expect(bumpPrefsNonce).not.toHaveBeenCalled();
  });

  it("answers false when the host refuses, instead of throwing at the caller", async () => {
    // A locked vault or an unreadable blob is not something a control choosing
    // between "Add key" and "Replace key" can act on, and "no key" is the safe
    // label to fall back to.
    invoke.mockRejectedValueOnce(new Error("SlotNotUnlocked"));
    await expect(aiProviderHasKey()).resolves.toBe(false);
  });

  it("does not swallow a refused provider name — the caller must see it", async () => {
    // The host refuses a value outside its known set rather than storing it.
    // Swallowing that would leave the panel showing a selection the request
    // path ignores, which is the failure mode the closed set exists to prevent.
    invoke.mockRejectedValueOnce({ kind: "InvalidValue" });
    await expect(setAiProvider("not-a-provider")).rejects.toBeTruthy();
  });
});
