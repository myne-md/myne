// The web client's first-run flow: account number → password → a vault
// (phase3-web-client task 85, closing the leg tasks 30 and 32 stop short of).
//
// # Why this exists as its own screen rather than inside `AccountNumberEntry`
//
// `AccountNumberEntry` answers one question — "is this a well-formed account
// number" — locally, with no network and no key material. Bolting the password
// and the join onto it would put a check that must never touch the wire in the
// same component as the call that does, and the property "the raw account number
// is only ever passed to a LOCAL command" would then be a claim about a code path
// instead of a claim about a module.
//
// # Why it is not `JoinDeviceModal`
//
// The desktop join modal asks for three things: server URL, account number,
// password. Two of the three are wrong here.
//
// * **The server URL is not the user's to choose.** Task 50 fixes the sync
//   origin when the container starts and generates a `connect-src` naming
//   exactly it, so any other address is CSP-blocked before a request leaves the
//   page. Offering a field would be a lie of capability whose failure mode is an
//   unexplained network error.
// * **The certificate step cannot happen.** A page never sees a leaf
//   certificate, and pinning is gone from every client anyway
//   (`decisions/sync/0620`): a browser verifies the chain itself. What is left of
//   the desktop step is the trust-status line, and `sync_join_account`'s web arm
//   returns `fingerprint: null` with `PinSource::PlatformTrustStore` precisely
//   so this screen has a typed answer to render, rather than an empty string
//   that would read as a certificate nothing could name.
//
// What DOES carry over is the pending gate. A browser enrols on the password
// path, which per `server-protocol.md` §3.1 lands **pending** until an existing
// device approves — and task 92 makes that the only path a browser has, because
// the self-approving recovery path is absent from this bundle. So "pending" is
// the normal outcome here, not an edge case, and the screen says so instead of
// looking stuck.
//
// # What is deliberately NOT here
//
// No vault creation and no recovery phrase: both are substituted out of the web
// bundle (task 32), and this screen must not become the third door to them. If
// the account number is wrong, or the password is wrong, or the account does not
// exist, the answer is to try again — there is no "create it then" affordance,
// because a browser cannot create a vault at all.

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../platform/core";
import { CenteredCard, ctaHover, ctaStyle } from "../components/primitives/CenteredCard";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { PasswordInput } from "../components/PasswordInput";
import { Spinner } from "../components/Spinner";
import { AccountNumberEntry } from "./AccountNumberEntry";
import { BetaTermsConsent } from "../components/sync/BetaTermsConsent";
import { useBetaTermsGate } from "../hooks/useBetaTermsGate";
import { useHeadFingerprintCompare } from "../hooks/useHeadFingerprintCompare";
import {
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE,
  ENROLL_PENDING_NOTICE,
} from "../lib/load-bearing-copy";
import { has } from "../platform/capabilities";
import { deploymentSyncOrigin } from "../platform/deployment-config";

/** Mirrors the Rust `JoinResult`. */
interface JoinResult {
  device_id_hex: string;
  vault_id: string;
  pending: boolean;
  /** Always `null` on web — a browser cannot see a leaf certificate. */
  fingerprint: string | null;
}

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-2)",
};

const HINT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

const ACCOUNT_ECHO_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  letterSpacing: "0.06em",
};

const LINK_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  color: "var(--accent)",
  textDecoration: "underline",
  cursor: "pointer",
  font: "inherit",
  alignSelf: "flex-start",
};

export interface AccountBootstrapProps {
  /**
   * The bootstrap finished and a vault container now exists. The caller
   * re-enters through the boot probe rather than being handed a stage — the same
   * door restore-backup and back-from-create use, so boot routing stays the one
   * place that decides what a container means.
   */
  onBootstrapped: () => void;
  /**
   * Leave for the creation flow (`decisions.md` 2026-08-15). Passed straight
   * through to `AccountNumberEntry`, and optional for the same reason it is
   * optional there: a client without `vaultCreation` must not be offered a door
   * it cannot open.
   */
  onCreateAccount?: () => void;
  /**
   * Mount straight into the approval wait, skipping account-number and password
   * entry (MYND-635).
   *
   * Set by boot routing when the probe finds this device enrolled but not yet
   * approved. Before this existed the wait was reachable only by *completing* a
   * join in the current page, so a refresh lost it — and the boot probe, seeing
   * the `vault.meta` the join had already written, offered the unlock form
   * instead. The password worked and the vault opened empty, because a pending
   * device holds no token and can pull nothing.
   *
   * A mount-time INITIAL value, not a controlled prop: once mounted the screen
   * owns the state, so an approval it observes takes effect immediately instead
   * of waiting for the parent to re-probe.
   */
  initiallyPending?: boolean;
}

const SAS_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--weight-bold)",
  letterSpacing: "0.16em",
  textAlign: "center",
  padding: "var(--space-4)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

const APPROVER_LIST_STYLE: CSSProperties = {
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  margin: "var(--space-1) 0",
  paddingInlineStart: "var(--space-5)",
};

export function AccountBootstrap({
  onBootstrapped,
  onCreateAccount,
  initiallyPending = false,
}: AccountBootstrapProps) {
  const betaTerms = useBetaTermsGate();
  /** The beta-terms dialog, opened from the gate below. */
  const [termsOpen, setTermsOpen] = useState(false);
  const { t } = useTranslation();
  const [account, setAccount] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(initiallyPending);
  const [aborting, setAborting] = useState(false);
  /** Who can approve, named up front rather than discovered at a spinner. */
  const [approvers, setApprovers] = useState<string[] | null>(null);

  // The approval watch and the SYNC-40 compare, through the shared hook
  // (myne#462). Two things this screen used to do differently, both fixed by
  // adopting it:
  //
  // 1. It AWAITED `sync_now` in front of every fingerprint read — the
  //    pre-MYND-537 shape the other joining screens deliberately left behind.
  //    On a web re-bootstrap that re-materialises a whole corpus, that gated the
  //    code behind the download rather than behind the head.
  // 2. It latched on the first non-null answer, like every other copy did.
  //
  // This screen matters more than its desktop siblings, not less: per
  // `decisions.md` 2026-07-26 a web client re-runs this compare on EVERY
  // re-bootstrap, because OPFS is evictable — so a cleared profile or a private
  // window lands here again. And a browser has neither certificate pinning nor
  // channel binding (`sync-protocol.md` §8.4), which leaves this eye-compare
  // carrying a larger share of the client's assurance than it does on desktop.
  const { fingerprint: sas, changed: sasChanged } = useHeadFingerprintCompare(pending, "joiner");

  // Who can approve. Read once on entering the pending state — a device that is
  // still pending cannot read the roster for itself, so this is best-effort and
  // its FAILURE is meaningful: `null` renders neither list nor "nobody can", and
  // saying "nobody can approve you" on the strength of a failed call would be
  // worse than saying nothing.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    void invoke<Array<{ name?: string | null; device_id_hex?: string; approved?: boolean }>>(
      "plugin:sync|sync_list_devices",
    )
      .then((rows) => {
        if (cancelled) return;
        setApprovers(
          rows
            .filter((r) => r.approved === true)
            .map((r) => r.name?.trim() || (r.device_id_hex ?? "").slice(0, 8)),
        );
      })
      .catch(() => {
        /* leave `null`: unknown is not "nobody" */
      });
    return () => {
      cancelled = true;
    };
  }, [pending]);
  // Resolved once, at module-capability level rather than per-render, so the
  // two literals cannot be mixed within one session.
  const nonDistinguishingBanner = has("phraseRecovery")
    ? ENROLL_NON_DISTINGUISHING_BANNER
    : ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE;

  // The wait is checked BEFORE the account-number step (MYND-635), and the
  // order is the whole point of a resumed mount. `account` is React state, so a
  // device that enrolled before a refresh comes back with it `null` — and an
  // account-number-first check would put the user back at the beginning of a
  // flow they have already completed, asking for a credential that is already
  // registered. Enrolling again from there mints a fresh `device_id` and
  // strands a second pending record.
  //
  // Safe for the fresh path too: `pending` only becomes true when a join has
  // returned, which cannot happen before an account number was entered.
  if (pending) {
    // The device is registered and awaiting approval from an existing one.
    //
    // **Not a spinner.** A new laptop is usually enrolled sitting next to your
    // other devices; a browser is typically opened precisely when they are not
    // with you. The gate is identical — only the odds of having an approving
    // device to hand differ — so this screen names WHICH devices can approve
    // before the user starts wondering whether anything is happening.
    //
    // The poll is the join modal's, deliberately: `sync_now` until a head is
    // adopted, then the head fingerprint is the code both sides compare. Same
    // mechanism, not a parallel one — letting a browser self-approve would gut
    // the gate `server-protocol.md` §3.1 exists to enforce.
    if (sas !== null) {
      return (
        <CenteredCard>
          <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
            {t("accountBootstrap.verifyTitle")}
          </h1>
          <p style={HINT_STYLE}>{t("accountBootstrap.verifyBody")}</p>
          <div style={SAS_STYLE} data-testid="account-bootstrap.sas">
            {sas}
          </div>
          {/* The head moved mid-compare. Said out loud, so a changed code is a
              prompt to look again rather than a silent re-convergence. */}
          {sasChanged && (
            <p style={HINT_STYLE} data-testid="account-bootstrap.sas-changed">
              {t("accountBootstrap.verifyChanged")}
            </p>
          )}
          {/* The abort's own failure surfaces HERE, in the step where the user
              pressed it — not as a cleared screen that implies it worked. */}
          {error && (
            <DestructiveBanner testId="account-bootstrap.error">{error}</DestructiveBanner>
          )}
          <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
            <button
              data-testid="account-bootstrap.sas-mismatch"
              type="button"
              disabled={aborting}
              style={{ ...LINK_BUTTON_STYLE, color: "var(--danger)" }}
              onClick={() => {
                // A mismatch means the data this device adopted may be forked.
                // Un-enrol so it stops trusting it — the join modal's answer,
                // and the only safe one.
                //
                // A FAILED un-enrol must not clear the screen. This used to
                // `.catch(() => {})` and then reset the state either way, so a
                // user who saw a fingerprint mismatch — the single signal that a
                // hostile server or a forked head is in play — and pressed abort
                // got the same screen whether the device was actually
                // disconnected or not. If the reset failed they were left
                // enrolled against that endpoint, looking at a UI that had just
                // told them they backed out (test-audit #10/#65).
                setAborting(true);
                setError(null);
                void invoke("plugin:sync|sync_reset_local")
                  .then(() => {
                    setAborting(false);
                    setPending(false);
                    setAccount(null);
                  })
                  .catch(() => {
                    setAborting(false);
                    setError(t("sync.join.sasAbortFailed"));
                  });
              }}
            >
              {t("accountBootstrap.sasMismatch")}
            </button>
            <button
              data-testid="account-bootstrap.sas-match"
              type="button"
              disabled={aborting}
              style={ctaStyle(aborting)}
              {...ctaHover(aborting)}
              onClick={onBootstrapped}
            >
              <span>{t("accountBootstrap.sasMatch")}</span>
            </button>
          </div>
        </CenteredCard>
      );
    }
    return (
      <CenteredCard>
        <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
          {t("accountBootstrap.pendingTitle")}
        </h1>
        {/* Load-bearing copy: rendered verbatim, never translated (SYNC-13 /
            `src/lib/load-bearing-copy.ts`). It states what approval does and
            does not mean, and a paraphrase would weaken it. */}
        <p style={HINT_STYLE} data-testid="account-bootstrap.pending-notice">
          {ENROLL_PENDING_NOTICE}
        </p>
        {approvers !== null && approvers.length > 0 && (
          <>
            <p style={HINT_STYLE} data-testid="account-bootstrap.approvers-intro">
              {t("accountBootstrap.approversIntro")}
            </p>
            <ul style={APPROVER_LIST_STYLE} data-testid="account-bootstrap.approvers">
              {approvers.map((name, i) => (
                <li key={`${name}-${i}`}>{name}</li>
              ))}
            </ul>
          </>
        )}
        {approvers !== null && approvers.length === 0 && (
          // The situation worth saying out loud: nothing on the account can
          // approve this browser. A spinner here would wait forever without
          // ever explaining why.
          <p style={HINT_STYLE} data-testid="account-bootstrap.no-approvers">
            {t("accountBootstrap.noApprovers")}
          </p>
        )}
        {/* #269: the way out.
            Boot re-enters this stage on every reload, the enrol-gate treats
            `pending` as "already enrolled" and hides the form, and the Settings
            sync panel does not render one while pending — so a device that
            enrolled against the WRONG account, or one whose approver is gone,
            had no route back at all. Reloading returned here; there was nothing
            else to press.

            Same handler as the SAS-mismatch escape above, deliberately: both
            are "stop trusting this enrolment and start over", and a second
            implementation of that is a second thing to keep correct. */}
        <button
          data-testid="account-bootstrap.pending-reset"
          type="button"
          disabled={aborting}
          style={{ ...LINK_BUTTON_STYLE, color: "var(--danger)", marginTop: "var(--space-3)" }}
          onClick={() => {
            setAborting(true);
            void invoke("plugin:sync|sync_reset_local")
              .catch(() => {})
              .finally(() => {
                setAborting(false);
                setPending(false);
                setAccount(null);
              });
          }}
        >
          {t("accountBootstrap.pendingStartOver")}
        </button>
      </CenteredCard>
    );
  }

  // The beta-terms gate (operations#15) — the third and last door onto sync.
  //
  // On this client sync is not optional (decisions.md 2026-07-26), so this door
  // is the ONLY way in and the terms are the first thing a new user sees. It
  // sits below the pending-approval wait for the same reason the account entry
  // does: a device already waiting for approval has been through here, and
  // re-asking would be asking again for something already given.
  //
  // There is nothing to cancel TO — the browser client with no account has no
  // other screen — so the terms are a dialog over THIS gate rather than over
  // the account entry: dismissing returns here, and the entry form is not
  // rendered at all until the terms are accepted. A dismissable dialog in
  // front of a live form would be a route past the gate, not a gate.
  if (!betaTerms.pending && betaTerms.needed) {
    return (
      <CenteredCard>
        <div data-testid="bootstrap.beta-terms">
          <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
            {t("sync.betaTerms.title")}
          </h1>
          <p style={HINT_STYLE}>{t("sync.betaTerms.intro")}</p>
          <button
            data-testid="bootstrap.beta-terms.open"
            type="button"
            style={{ ...ctaStyle(false), marginTop: "var(--space-3)" }}
            {...ctaHover(false)}
            onClick={() => setTermsOpen(true)}
          >
            <span>{t("sync.betaTerms.review")}</span>
          </button>
        </div>
        <BetaTermsConsent
          open={termsOpen}
          testId="bootstrap.beta-terms.dialog"
          onAccept={() => {
            setTermsOpen(false);
            void betaTerms.accept();
          }}
          onCancel={() => setTermsOpen(false)}
        />
      </CenteredCard>
    );
  }

  // Only now the first-run beginning. Below the wait, not above it — see the
  // ordering note there.
  if (account === null) {
    return <AccountNumberEntry onValid={setAccount} onCreateAccount={onCreateAccount} />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length === 0 || busy || account === null) return;
    setBusy(true);
    setError(null);
    try {
      // The origin is the container's, read rather than typed. A null endpoint
      // is a DEPLOYMENT fault, not a user one, and gets its own message — telling
      // someone their password is wrong when the client has no server configured
      // sends them to change a credential that is fine.
      const cfg = await invoke<{ endpoint_url: string | null } | null>(
        "plugin:sync|sync_get_endpoint",
      );
      // Second place to look, and on a first-run browser it is the ONLY one
      // that answers: the stored config is written by `sync_set_endpoint`, and
      // on this client nothing calls it before the join — the origin comes from
      // the deployment, not from a field the user fills in (task 50). Without
      // this the very first sign-in failed with "no sync server configured"
      // against a correctly-configured container, having sent no request at
      // all. Empty on desktop by construction, so the desktop path is
      // unchanged: `null` there still means what it always meant.
      //
      // The join persists what it is given (`config::set_endpoint`, called
      // inside `join_account_from_host`), so this fallback is load-bearing
      // exactly once per browser.
      const serverUrl = cfg?.endpoint_url ?? (await deploymentSyncOrigin());
      if (serverUrl === null) {
        setError(t("accountBootstrap.noEndpoint"));
        return;
      }
      const res = await invoke<JoinResult>("plugin:sync|sync_join_account", {
        serverUrl,
        accountNumber: account,
        password,
      });
      // Drop the password from component state the moment the call returns —
      // it is not needed again on either branch, and the unlock that follows
      // asks for it separately.
      setPassword("");
      if (res.pending) {
        setPending(true);
        return;
      }
      onBootstrapped();
    } catch (e) {
      // ONE message for every credential/account failure. The alternatives leak:
      // "no such account" is an account-existence oracle for anyone holding a
      // guessed number, and distinguishing it from "wrong password" would make
      // the pair a two-step enumeration. `account-number.md` §5 requires the
      // non-distinguishing answer, and this is the same rule one layer up.
      //
      // `AccountMismatch` is the exception, and it leaks nothing: it is a fact
      // about THIS browser's own storage — that it already holds a different
      // account's vault — which the person sitting in front of it can see
      // anyway. It gets its own message because nothing they retype fixes it;
      // folding it into the banner above would send them round a loop with no
      // exit.
      const kind = (e as { kind?: string } | null)?.kind;
      setError(
        kind === "AccountMismatch"
          ? t("accountBootstrap.accountMismatch")
          : // The load-bearing literal, rendered verbatim in every locale, NOT an
            // i18n key (`src/AGENTS.md`: "Do NOT i18n load-bearing copy"). Its
            // exact wording is the privacy property — one message for a wrong
            // account number and a wrong password, because both fail at the same
            // AEAD-open step and two messages would make the pair an account
            // enumeration. Selected by the capability so a client that CAN take
            // a phrase names it and one that cannot does not.
            nonDistinguishingBanner,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredCard>
      <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
        {t("accountBootstrap.title")}
      </h1>
      <p style={HINT_STYLE}>{t("accountBootstrap.hint")}</p>
      <p style={ACCOUNT_ECHO_STYLE} data-testid="account-bootstrap.account">
        {account}
      </p>
      <form style={FORM_STYLE} onSubmit={(e) => void handleSubmit(e)}>
        <PasswordInput
          testId="account-bootstrap.password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          label={t("accountBootstrap.passwordLabel")}
          show={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          disabled={busy}
          autoFocus
        />
        {error !== null && (
          <DestructiveBanner testId="account-bootstrap.error">{error}</DestructiveBanner>
        )}
        {/* The `<Spinner>` earns its place here and not on the account-number
            step: this button runs a network join AND Argon2id, so the wait is
            seconds rather than a frame, and a CTA that only swaps its label
            reads as a hung app. Same shape as `Unlock.tsx`'s submit. */}
        <button
          data-testid="account-bootstrap.submit"
          type="submit"
          disabled={password.length === 0 || busy}
          style={ctaStyle(password.length === 0 || busy)}
          {...ctaHover(password.length === 0 || busy)}
        >
          {busy && <Spinner size={14} />}
          <span>{busy ? t("accountBootstrap.working") : t("accountBootstrap.continue")}</span>
        </button>
        <button
          data-testid="account-bootstrap.change-account"
          type="button"
          style={LINK_BUTTON_STYLE}
          onClick={() => {
            setAccount(null);
            setPassword("");
            setError(null);
          }}
        >
          {t("accountBootstrap.changeAccount")}
        </button>
      </form>
    </CenteredCard>
  );
}
