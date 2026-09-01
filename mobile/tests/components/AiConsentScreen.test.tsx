// @vitest-environment jsdom
//
// The per-provider consent screen (myne-md/myne#456).
//
// **What is under test is the DISCLOSURE, not the layout.** This screen is what
// closes SYNC-22: a phone enrolled into a vault configured on a laptop already
// holds the provider, the model and the key, because those sync, and holds no
// approval, because `ai_provider_consent` is device-local. Everything here is
// about the sentences a user must have had on screen before the accepting
// action existed.
//
// The clauses are asserted against `@myne/copy` BY IDENTITY rather than by
// substring, and that is the point of them living there: a paraphrase on one
// client is a threat-model claim nobody reviewed, and identity is the only
// assertion a paraphrase cannot pass.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  AI_TRUST_A7_RESIDUAL,
  CONSENT_DEVICE_SCOPE,
  CONSENT_DIRECT_CONNECTION,
  CONSENT_HOW_TO_REVOKE,
  CONSENT_WHAT_LEAVES,
  CONSENT_WHEN_IT_LEAVES,
  consentCannotVerify,
  consentToWhom,
} from "@myne/copy";
import { AiConsentScreen } from "../../src/components/AiConsentScreen";

// Explicit, because this suite's setup does not auto-clean: without it the
// second `render` leaves two screens in the DOM and every `getByTestId`
// fails with "found multiple elements", which reads like a duplicate-testid
// bug in the component rather than a test-harness one.
afterEach(cleanup);

function renderScreen(overrides: Partial<Parameters<typeof AiConsentScreen>[0]> = {}) {
  const onAccept = vi.fn();
  const onCancel = vi.fn();
  render(
    <AiConsentScreen
      provider="openrouter"
      onAccept={onAccept}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onAccept, onCancel };
}

describe("AiConsentScreen", () => {
  it("carries every clause verbatim from the shared copy package", () => {
    renderScreen();

    // Identity, not `toContain`. A client that paraphrased one of these would
    // pass a substring check on the words it kept.
    expect(screen.getByTestId("ai-consent.what").textContent).toBe(CONSENT_WHAT_LEAVES);
    expect(screen.getByTestId("ai-consent.when").textContent).toBe(CONSENT_WHEN_IT_LEAVES);
    expect(screen.getByTestId("ai-consent.who").textContent).toBe(
      consentToWhom("OpenRouter"),
    );
    expect(screen.getByTestId("ai-consent.cannot-verify").textContent).toBe(
      consentCannotVerify("OpenRouter"),
    );
    expect(screen.getByTestId("ai-consent.revoke").textContent).toBe(
      CONSENT_HOW_TO_REVOKE,
    );
    expect(screen.getByTestId("ai-consent.scope").textContent).toBe(
      CONSENT_DEVICE_SCOPE,
    );
    expect(screen.getByTestId("ai-consent.connection").textContent).toBe(
      CONSENT_DIRECT_CONNECTION,
    );
    // The EIGHTH element, which this screen omitted while the desktop screen
    // rendered it (myne-md/myne#456, found by review). This file's own subject
    // is that the disclosure is whole rather than a summary, and it asserted
    // seven of eight, so the miss was invisible to the one test written to
    // catch exactly it. The sentence lived in `src/lib/load-bearing-copy.ts`,
    // which mobile does not compile; it is in `@myne/copy` now.
    expect(screen.getByTestId("ai-consent.residual").textContent).toBe(
      AI_TRUST_A7_RESIDUAL,
    );
  });

  it("names the recipient as a proper noun, never as a wire value", () => {
    renderScreen();

    // A consent screen that cannot name the recipient is not consent, and
    // "openrouter" is not the name of anything a user recognises.
    //
    // **Asserted on the CLAUSES, not on the title or the button**, and that is a
    // fact about this harness rather than a gap: `t()` here returns the key
    // itself, so `ai-consent.title` renders the literal string
    // "settings.ai.consent.title" and an assertion on it would be asserting
    // nothing either way. The clauses are the right place regardless: they are
    // not i18n'd precisely because their wording is threat-model-bounded, so
    // they carry the name in every locale.
    for (const id of ["ai-consent.who", "ai-consent.cannot-verify"]) {
      const text = screen.getByTestId(id).textContent ?? "";
      expect(text).toContain("OpenRouter");
      expect(text).not.toContain("openrouter");
    }
  });

  it("says the approval covers this device and the key does not", () => {
    renderScreen();
    const scope = screen.getByTestId("ai-consent.scope").textContent ?? "";

    // The half that closes SYNC-22.
    expect(scope).toContain("this device only");
    // The half that keeps it honest: a phone CAN hold a credential it has not
    // been permitted to use, and a screen that omitted this would be leaving
    // the surprising part out.
    expect(scope).toContain("key does travel");
    // And the sentence the residual USED to say must not come back in a copy
    // edit. Asserting an absence is the only way to pin that.
    expect(scope).not.toContain("will not ask again");
  });

  it("says the connection is direct, because nothing else does", () => {
    renderScreen();
    const connection = screen.getByTestId("ai-consent.connection").textContent ?? "";

    // A reader who has seen the Tor routing option elsewhere in the product
    // would reasonably assume it applies here. It does not (myne-md/myne#607).
    expect(connection).toContain("direct");
    expect(connection).toContain("IP address");
  });

  it("has exactly one accepting action, and it is on this screen", () => {
    const { onAccept, onCancel } = renderScreen();

    const accept = screen.getByTestId("ai-consent.accept");
    accept.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("declines by dismissing, and dismissing stores nothing", () => {
    const { onAccept, onCancel } = renderScreen();

    screen.getByTestId("ai-consent.cancel").click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The load-bearing half: there is no dismissal that leaves a consent
    // recorded, so there is no dismissal that has to be undone.
    expect(onAccept).not.toHaveBeenCalled();
  });
});
