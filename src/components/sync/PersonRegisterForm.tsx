// SPDX-License-Identifier: AGPL-3.0-only
// The one register-an-identity form (2026-10-23 review; reshaped 2026-10-24).
//
// It exists because the review found the same secret-handling path written twice:
// the identity home and Settings → Sync each carried their own 24-cell state, the
// same paste-to-distribute arithmetic, the same optional server field and the
// same error kinds, and the two copies had already drifted (only one of them ran
// the beta-terms gate, and only one kept its cells on an endpoint failure). The
// lesson `PhraseEntryGrid`'s own header records applies here: a shared primitive
// whose callers keep a private copy of the logic around it has not collapsed
// anything.
//
// **The order was wrong and is inverted here** (2026-10-24 owner report: "it asks
// us this before we have chosen which sync server"). Registration writes this
// identity's public halves to a server and mints a device token there, so which
// server is a decision with a place, not a formality. The form used to hide the
// address until the device turned out to have none (`readSyncEndpoint() === null`)
// and ask for it BELOW the 24 cells, which produced the worst order available: 24
// words typed, `NotConfigured` from the backend, the words WIPED, and only then
// an address field. Now the server row is the FIRST thing in the form, it is
// always there with the configured address prefilled, and the phrase comes after
// it. Both facts are stated rather than inferred: the address, and the admission
// code a gated server wants (a self-hoster who sets `MYNE_INVITE_CODE` could not
// register from this surface at all before, because `writeSyncEndpoint` was only
// ever given a URL).
//
// What it owns, and why each piece belongs HERE rather than at the call site:
//
//  - the 24 cells and the phrase, wiped on every failure arm that touched
//    `personRegister` (a mounted component holding the phrase is one devtools
//    panel away from exposure);
//  - the server row, and the endpoint write BEFORE the phrase crosses IPC, so a
//    mistyped address costs a URL rather than a phrase. Its failure is reported as
//    its own arm that KEEPS the cells (the review found both copies wiping the
//    phrase and blaming it for a bad address);
//  - the beta-terms gate. Registration is a server-facing act; the identity home
//    had this gate and the Settings door did not, which `useBetaTermsGate`'s own
//    header calls out as not a gate at all.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "../PhraseEntryGrid";
import { applyPastedPhrase, phrasePasteTokens } from "@myne/client-core/phrase-cells";
import { BetaTermsConsent } from "./BetaTermsConsent";
import { HELPER_STYLE, LABEL_STYLE } from "../settings/panel-styles";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";
import {
  personRegister,
  readSyncConfig,
  writeSyncEndpoint,
} from "../../lib/personAccount";

const emptyCells = (): string[] => Array.from({ length: PHRASE_CELL_COUNT }, () => "");

/** Which failure the single error slot is showing. There were three arms; the
 *  "no server configured" one is gone with the ordering fix, because this form
 *  now always names a server. */
type Failure = "server" | "generic";

/** The kind of a rejected command, or `undefined` for anything that is not one.
 *  The backend rejects with a serialized `SyncDeviceError` (`{ kind }`). */
function errorKind(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "kind" in error
    ? ((error as { kind?: unknown }).kind as string | undefined)
    : undefined;
}

/** What the device's config said when this form opened, so an unchanged address
 *  costs no second round trip and no second TLS handshake against the server. */
interface Configured {
  url: string;
  code: string;
}

/** One labelled field: the label, the control, then its helper. The label is
 *  VISIBLE on every field (2026-10-24 owner report: the admission-code box sat
 *  there unlabelled and read as a password field nobody could identify). */
const FIELD_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
} as const;

/** The body scrolls; the actions do not. A dialog whose buttons scroll out of
 *  view reads as unanswerable, and this one is 24 cells tall (`BetaTermsConsent`
 *  carries the same pair for the same reason). */
const SCROLL_STYLE = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
} as const;

const ACTIONS_STYLE = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
  flex: "0 0 auto",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
} as const;

export interface PersonRegisterFormProps {
  /**
   * `data-testid` prefix for every control. Two hosts mount this form, and one
   * screen's ids must not silently satisfy a selector meant for the other.
   */
  testIdPrefix: string;
  /** Fired after the backend accepted the registration. */
  onRegistered: () => void;
  /** The way back out, where the host has one. */
  onCancel?: () => void;
}

export function PersonRegisterForm({
  testIdPrefix,
  onRegistered,
  onCancel,
}: PersonRegisterFormProps) {
  const { t } = useTranslation();
  // Which half of the act is on screen (2026-10-24 owner report: the 24 cells and
  // the two server fields do not belong in one view). The server first, always:
  // the address is a decision and the phrase is a secret, and a dialog that asks
  // them together makes the user read both before understanding either. The step
  // lives HERE rather than in the dialog because the submit path is what moves it.
  const [step, setStep] = useState<"server" | "phrase">("server");
  const [words, setWords] = useState<string[]>(emptyCells);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The server this identity will be registered ON. Prefilled from the device's
  // own config and editable, because the address is the first thing this act
  // needs and a user registering an identity has no other surface to set it on
  // (the identity home renders at zero vaults, where Settings does not exist).
  const [serverUrl, setServerUrl] = useState("");
  // The admission code a gated server wants (`MYNE_INVITE_CODE`). Optional: an
  // open server needs none, so the field is not gated on anything.
  const [inviteCode, setInviteCode] = useState("");
  const [configured, setConfigured] = useState<Configured | null>(null);
  const betaTerms = useBetaTermsGate();
  const [termsOpen, setTermsOpen] = useState(false);

  // Read what would be used today, so the row opens on the truth rather than on
  // an empty box. A failed read is not fatal: the fields stay empty, the address
  // is required before submit, and the honest fallback is "type where to
  // register" rather than a hidden field revealed by a refusal.
  useEffect(() => {
    let alive = true;
    void readSyncConfig().then(
      (cfg) => {
        if (!alive) return;
        const url = cfg.endpoint_url ?? "";
        const code = cfg.invite_code ?? "";
        setServerUrl(url);
        setInviteCode(code);
        setConfigured({ url, code });
      },
      () => {
        /* unknown; the address field is the answer either way */
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const tid = (suffix: string) => `${testIdPrefix}-${suffix}`;

  const resetCells = () => setWords(emptyCells());

  /** Whether the device's own config already says what the server step says. An
   *  unchanged address is not re-written: `sync_set_endpoint` verifies TLS as part
   *  of the write, so re-sending it buys a second handshake and a press that looks
   *  hung. */
  const addressChanged = () => {
    const url = serverUrl.trim();
    const code = inviteCode.trim();
    return configured === null || configured.url !== url || configured.code !== code;
  };

  /**
   * Step one's only act: settle the address, then move on.
   *
   * The write happens HERE rather than on the final press, so a mistyped address
   * costs a URL and is refused before any secret is typed. Its failure keeps the
   * user on this step, where the fix is.
   */
  const continueFromServer = async () => {
    const url = serverUrl.trim();
    const code = inviteCode.trim();
    if (url === "") return;
    setFailure(null);
    if (!addressChanged()) {
      setStep("phrase");
      return;
    }
    setBusy(true);
    try {
      // `null` (not `""`) when the field is empty: the backend reads `None` as
      // "preserve the stored code" and `Some("")` as an EXPLICIT CLEAR, and this
      // form must never be the surface that erases the only copy of a server's
      // admission word. Clearing one stays `EndpointConfig`'s job.
      await writeSyncEndpoint(url, code === "" ? null : code);
      setConfigured({ url, code });
      setStep("phrase");
    } catch {
      setFailure("server");
    } finally {
      setBusy(false);
    }
  };

  /** Step two's act: the phrase, as the proof of possession. */
  const submit = async () => {
    const phrase = words.join(" ").trim();
    if (phrase === "" || words.some((word) => word.trim() === "")) return;
    setBusy(true);
    setFailure(null);
    try {
      try {
        await personRegister(phrase);
      } catch (e: unknown) {
        // `NotConfigured` means no address reached the backend, which is the
        // SERVER's problem, so the words stay and the dialog goes back to the step
        // where they can be fixed. Everything else is read as a refusal of the
        // phrase, which does not survive it: a mounted component holding 24 words
        // is one devtools panel away from exposure, and the copy asks again.
        if (errorKind(e) === "NotConfigured") {
          setFailure("server");
          setStep("server");
          return;
        }
        resetCells();
        setFailure("generic");
        return;
      }
      resetCells();
      onRegistered();
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (betaTerms.needed) {
      setTermsOpen(true);
      return;
    }
    await submit();
  };

  const message =
    failure === "server"
      ? t("identityHome.registerServerError")
      : failure === "generic"
        ? t("identityHome.registerError")
        : null;

  const phraseReady = !busy && !words.some((word) => word.trim() === "");
  const serverReady = !busy && serverUrl.trim() !== "";

  return (
    <div
      data-testid={tid("form")}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <div style={SCROLL_STYLE}>
        <BetaTermsConsent
          open={termsOpen}
          testId={tid("beta-terms")}
          onAccept={() => {
            setTermsOpen(false);
            // `accept()` then the body directly, because `needed` is still true
            // for this render and `register()` would reopen the dialog.
            void betaTerms.accept().then(() => submit());
          }}
          onCancel={() => setTermsOpen(false)}
        />
        {step === "server" ? (
          <>
            {/* Two fields, two labels, two one-line helpers. Nothing here
                explains the act back to the reader: the title says what is being
                done, the labels say what each field takes, and the only sentence
                that survives is the consequence (who learns that this identity
                exists), which is not a restatement. */}
            {/* The server rows, each with a VISIBLE label: an unlabelled box
                above the phrase grid read as a password prompt for nothing
                (2026-10-24 owner report). */}
            <div style={FIELD_STYLE}>
              <label htmlFor={`${testIdPrefix}-server`} style={LABEL_STYLE}>
                {t("identityHome.registerServerLabel")}
              </label>
              <Input
                id={`${testIdPrefix}-server`}
                type="url"
                value={serverUrl}
                onChange={(e) => {
                  setFailure(null);
                  setServerUrl(e.target.value);
                }}
                placeholder={t("identityHome.registerServerPlaceholder")}
                data-testid={tid("server")}
                autoComplete="off"
                spellCheck={false}
              />
              <p data-testid={tid("server-hint")} style={HELPER_STYLE}>
                {t("identityHome.registerServerHint")}
              </p>
            </div>
            <div style={FIELD_STYLE}>
              <label htmlFor={`${testIdPrefix}-invite-code`} style={LABEL_STYLE}>
                {t("identityHome.registerInviteCodeLabel")}
              </label>
              <Input
                id={`${testIdPrefix}-invite-code`}
                type="text"
                value={inviteCode}
                onChange={(e) => {
                  setFailure(null);
                  setInviteCode(e.target.value);
                }}
                data-testid={tid("invite-code")}
                autoComplete="off"
                spellCheck={false}
              />
              <p style={HELPER_STYLE}>{t("identityHome.registerInviteCodeHint")}</p>
            </div>
          </>
        ) : (
          <>
            <PhraseEntryGrid
              baseId={`${testIdPrefix}-phrase-grid`}
              label={t("identityHome.registerPhraseLabel")}
              cells={words}
              disabled={busy}
              gridTestId={tid("phrase-grid")}
              cellTestId={(index) =>
                index === 0 ? tid("phrase") : `${tid("phrase")}-cell-${index + 1}`
              }
              onCellChange={(index) => (event) => {
                setFailure(null);
                setWords((cells) =>
                  cells.map((cell, cellIndex) =>
                    cellIndex === index ? event.target.value.replace(/\s+/g, "") : cell,
                  ),
                );
              }}
              onCellPaste={() => (event) => {
                const tokens = phrasePasteTokens(event.clipboardData.getData("text"));
                if (tokens.length < 2) return;
                event.preventDefault();
                setFailure(null);
                setWords((cells) => applyPastedPhrase(cells, tokens));
              }}
            />
          </>
        )}
        {message !== null ? (
          <p
            role="alert"
            data-testid={tid("error")}
            style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--danger)" }}
          >
            {message}
          </p>
        ) : null}
      </div>
      <div style={ACTIONS_STYLE}>
        {step === "server" ? (
          <>
            {onCancel ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={onCancel}
                data-testid={tid("cancel")}
              >
                {t("common.cancel")}
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => void continueFromServer()}
              disabled={!serverReady}
              data-testid={tid("continue")}
            >
              {t("common.continue")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setFailure(null);
                setStep("server");
              }}
              data-testid={tid("back")}
            >
              {t("common.back")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void register()}
              disabled={!phraseReady}
              data-testid={tid("submit")}
            >
              {t("identityHome.registerSubmit")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
