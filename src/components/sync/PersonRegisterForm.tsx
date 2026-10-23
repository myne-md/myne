// SPDX-License-Identifier: AGPL-3.0
// The one register-an-identity form (2026-10-23 review).
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
// What it owns, and why each piece belongs HERE rather than at the call site:
//
//  - the 24 cells and the phrase, wiped on every failure arm that touched
//    `personRegister` (a mounted component holding the phrase is one devtools
//    panel away from exposure);
//  - the sync-server address, asked only when the device has none OR when the
//    registration answered `NotConfigured`, because registering is a write
//    against a server and the identity home is reachable at zero vaults, where
//    Settings (the endpoint's own home) does not exist;
//  - the endpoint write BEFORE the phrase crosses IPC, so a mistyped address
//    costs a URL rather than a phrase, and its failure is reported as its own
//    arm that KEEPS the cells (the review found both copies wiping the phrase and
//    blaming it for a bad address);
//  - the beta-terms gate. Registration is a server-facing act; the identity home
//    had this gate and the Settings door did not, which `useBetaTermsGate`'s own
//    header calls out as not a gate at all.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "../PhraseEntryGrid";
import { BetaTermsConsent } from "./BetaTermsConsent";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";
import {
  personRegister,
  readSyncEndpoint,
  writeSyncEndpoint,
} from "../../lib/personAccount";

const emptyCells = (): string[] => Array.from({ length: PHRASE_CELL_COUNT }, () => "");

/** Which failure the single error slot is showing. */
type Failure = "needsServer" | "server" | "generic";

/**
 * The kind of a rejected command, or `undefined` for anything that is not one.
 * The backend rejects with a serialized `SyncDeviceError` (`{ kind }`).
 */
function errorKind(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "kind" in error
    ? ((error as { kind?: unknown }).kind as string | undefined)
    : undefined;
}

export interface PersonRegisterFormProps {
  /**
   * `data-testid` prefix for every control. Two hosts mount this form, and one
   * screen's ids must not silently satisfy a selector meant for the other.
   */
  testIdPrefix: string;
  /** Fired after the backend accepted the registration. */
  onRegistered: () => void;
  /** The way back out, where the host has one. The identity home keeps the
   *  register block open until it succeeds or the host leaves, so it passes
   *  nothing. */
  onCancel?: () => void;
}

export function PersonRegisterForm({
  testIdPrefix,
  onRegistered,
  onCancel,
}: PersonRegisterFormProps) {
  const { t } = useTranslation();
  const [words, setWords] = useState<string[]>(emptyCells);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Whether the block must ask for a sync server address. `null` while the
  // device-local read is in flight; `false` means one is already configured and
  // the field stays out of the way.
  const [serverNeeded, setServerNeeded] = useState<boolean | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const betaTerms = useBetaTermsGate();
  const [termsOpen, setTermsOpen] = useState(false);

  // Ask once, on mount, whether this device already has somewhere to register
  // against. Best effort: a failed read leaves the answer unknown and the field
  // hidden, and a `NotConfigured` refusal reveals it a moment later.
  useEffect(() => {
    let alive = true;
    void readSyncEndpoint().then(
      (url) => {
        if (alive) setServerNeeded(url === null);
      },
      () => {
        /* unknown; the refusal arm is the fallback */
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const tid = (suffix: string) => `${testIdPrefix}-${suffix}`;

  const resetCells = () => setWords(emptyCells());

  const submit = async () => {
    const phrase = words.join(" ").trim();
    if (phrase === "" || words.some((word) => word.trim() === "")) return;
    setBusy(true);
    setFailure(null);
    try {
      if (serverNeeded === true && serverUrl.trim() !== "") {
        try {
          await writeSyncEndpoint(serverUrl.trim());
        } catch {
          // Its own arm: the address is what failed, so the cells stay exactly
          // as the user typed them.
          setFailure("server");
          return;
        }
      }
      try {
        await personRegister(phrase);
      } catch (e: unknown) {
        // The phrase does not survive a registration failure: the copy asks for
        // it again, and nothing mounted should keep holding it.
        resetCells();
        const kind = errorKind(e);
        if (kind === "NotConfigured") {
          setServerNeeded(true);
          setFailure("needsServer");
        } else {
          setFailure("generic");
        }
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
    failure === "needsServer"
      ? t("identityHome.registerNeedsServer")
      : failure === "server"
        ? t("identityHome.registerServerError")
        : failure === "generic"
          ? t("identityHome.registerError")
          : null;

  return (
    <div
      data-testid={tid("form")}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
        {t("identityHome.registerPrompt")}
      </p>
      <BetaTermsConsent
        open={termsOpen}
        testId={tid("beta-terms")}
        onAccept={() => {
          setTermsOpen(false);
          // `accept()` then the body directly, because `needed` is still true for
          // this render and `register()` would reopen the dialog.
          void betaTerms.accept().then(() => submit());
        }}
        onCancel={() => setTermsOpen(false)}
      />
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
        onCellPaste={(index) => (event) => {
          const tokens = event.clipboardData
            .getData("text")
            .split(/\s+/)
            .filter((token) => token.length > 0);
          if (tokens.length < 2) return;
          event.preventDefault();
          setFailure(null);
          setWords((cells) => {
            const next = [...cells];
            for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
              next[index + i] = tokens[i];
            }
            return next;
          });
        }}
      />
      {serverNeeded === true ? (
        <Input
          type="url"
          value={serverUrl}
          onChange={(e) => {
            setFailure(null);
            setServerUrl(e.target.value);
          }}
          aria-label={t("identityHome.registerServerLabel")}
          placeholder={t("identityHome.registerServerPlaceholder")}
          data-testid={tid("server")}
          autoComplete="off"
          spellCheck={false}
        />
      ) : null}
      {message !== null ? (
        <p role="alert" data-testid={tid("error")} style={{ margin: 0 }}>
          {message}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {onCancel ? (
          <Button variant="ghost" disabled={busy} onClick={onCancel} data-testid={tid("cancel")}>
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void register()}
          disabled={
            busy ||
            words.some((word) => word.trim() === "") ||
            (serverNeeded === true && serverUrl.trim() === "")
          }
          data-testid={tid("submit")}
        >
          {t("identityHome.registerSubmit")}
        </Button>
      </div>
    </div>
  );
}
