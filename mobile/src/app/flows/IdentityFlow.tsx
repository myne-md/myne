import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Title,
  Lead,
  FooterBar,
  Button,
  MonoField,
  MonoBox,
  TextField,
  RecoveryGrid,
  Checkbox,
  Banner,
  Spinner,
  BlockingOverlay,
  Icon,
} from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import {
  personSetup,
  personStatus,
  personListInvites,
  personAcceptInvite,
  personJoinVault,
  inspectInviteCode,
  personLock,
  type PersonSetupView,
  type InviteSummary,
} from "../../lib/personAccount";
import { syncSetEndpoint, listRoster } from "../../lib/sync";
import { setMyMemberName, memberNameErrorKey } from "../../lib/memberNames";
import { pickChallenge, phraseTypeBackMatches } from "../../lib/phraseChallenge";
import { HOSTED_SYNC_ORIGIN } from "@myne/client-core/hosted-sync";
import { acceptInviteErrorKey } from "@myne/client-core/accept-invite";
import { memberJoinVaultErrorKey } from "@myne/client-core/join-member-vault";
import type { IdentityFlowProps } from "./types";

type Step =
  | "gate"
  | "held"
  | "server"
  | "create"
  | "phrase"
  | "home"
  | "accept-owner"
  | "accept-phrase"
  | "accept-password"
  | "join-phrase"
  | "join-password"
  | "name";

/** The accept wizard's steps, in order. A step-changing control names the step
 *  it moves to, so the three screens cannot disagree about the sequence. */
type AcceptStep = "accept-owner" | "accept-phrase" | "accept-password";

/** The join wizard's two steps, same shape. */
type JoinStep = "join-phrase" | "join-password";

/** Recovery-phrase width. Frozen by BIP-39 at 24 words (256 bits) and by
 *  `PHRASE_CELL_COUNT` on the desktop's `EnrollPhraseCredential`; the client
 *  does not choose it, so a local constant is not a second source of truth. */
const PHRASE_WORDS = 24;

/** The project's device-password floor. A pre-check, not the gate: the backend
 *  holds the same floor and refuses regardless, so a drift here costs an error
 *  message rather than a weak credential. Counted in Unicode scalar values
 *  rather than UTF-16 units, the difference a passphrase with an emoji in it
 *  would otherwise hit. `RecoverFlow` and `MemberUnlockBlock` carry the same
 *  local mirror. */
const MIN_PASSWORD_LEN = 12;

/**
 * Map a failed `sync_set_endpoint` invoke to user copy. The gated-server
 * refusals (`InviteCodeRequired` / `InviteCodeInvalid`, myne-md/myne#800) are
 * not reachability failures: the server answered, and the remedy is the
 * operator's invite code, so "couldn't reach the server" would send the user to
 * fix the wrong thing. Same mapping the sync settings panel uses.
 */
function serverConnectError(
  error: unknown,
  t: (key: string) => string,
): string {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  if (kind === "InviteCodeRequired") return t("sync.enroll.error.inviteCodeRequired");
  if (kind === "InviteCodeInvalid") return t("sync.enroll.error.inviteCodeInvalid");
  if (kind === "TlsFailure") return t("sync.endpoint.tlsFailure");
  return t("identityFlow.serverUnreachable");
}

/** Small uppercase field label, the shape every wired flow uses (`JoinFlow`,
 *  `RecoverFlow`, `CreateVaultFlow` each keep a local copy). */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-caps)",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: "var(--space-2)",
      }}
    >
      {children}
    </div>
  );
}


/** The canonical acknowledgement row (myne#728): a checkbox glyph inside a
 *  named toggle button, with the sentence beside it as the accessible name.
 *  Copying `CreateVaultFlow`'s `AckRow` keeps the two identical by shape. */
function AckRow({
  checked,
  onToggle,
  children,
  testId,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId: string;
}) {
  const labelId = useId();
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--space-3)",
        padding: "14px 0",
        marginTop: "var(--space-4)",
        borderTop: "1px solid var(--line-1)",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <Button
        variant="ghost"
        full={false}
        onClick={onToggle}
        aria-pressed={checked}
        aria-labelledby={labelId}
        data-testid={testId}
        style={{ border: "none", background: "transparent", padding: 0, height: "auto", width: "auto", display: "flex", flex: "none" }}
      >
        <Checkbox checked={checked} />
      </Button>
      <div
        id={labelId}
        onClick={onToggle}
        style={{ flex: 1, fontSize: "var(--text-md)", lineHeight: "var(--leading-normal)", color: "var(--fg-1)", cursor: "pointer" }}
      >
        {children}
      </div>
    </div>
  );
}

/** Secondary ink for a hint line under a field or section. */
const HINT_STYLE = { fontSize: "var(--text-sm)", lineHeight: "var(--leading-normal)", color: "var(--fg-3)" } as const;

/**
 * The invite wizards' step counter (myne-md/myne#871): a row of `total`
 * segments filled up to `n`, over the same sentence the desktop wizard renders
 * (`identityHome.stepIndicator`). Module scope, because it holds no state and
 * both wizards mount it on every step; `testId` names the wrapper so a spec can
 * assert which step is on screen and the fill state of each segment.
 *
 * A private copy rather than the desktop's `StepProgress`
 * (`src/screens/vault-creation/step-shell.tsx`), which this change extracted for
 * the desktop wizard. That one belongs to the desktop vault-creation shell, and a
 * phone flow importing a desktop screen's internals would couple the two clients
 * through a module neither owns; what the pair shares is the shape (a row of
 * token-coloured segments), not code, and the sentence above IS shared because
 * both read one catalog key. Hoisting the primitive into a package all three
 * clients can consume is a design-system change, not this fix.
 */
function StepProgress({
  testId,
  n,
  total,
  label,
}: {
  testId: string;
  n: number;
  total: number;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} style={{ marginTop: "var(--space-4)" }}>
      <div aria-hidden="true" style={{ display: "flex", gap: "var(--space-1)" }}>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            data-filled={index < n ? "true" : "false"}
            style={{
              flex: 1,
              height: 3,
              borderRadius: "var(--radius-pill)",
              background: index < n ? "var(--accent)" : "var(--line-2)",
            }}
          />
        ))}
      </div>
      <div style={{ ...HINT_STYLE, marginTop: "var(--space-2)" }}>
        {t("identityHome.stepIndicator", { n, total, label })}
      </div>
    </div>
  );
}

/** The inline mismatch line under a wrong type-back word. Tokens, so the
 *  token-adoption ratchet sees no new literal. */
const MISMATCH_STYLE = {
  marginTop: "var(--space-1)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
} as const;

/** Multi-line input chrome for the owner's identity code, which is a long
 *  opaque string a user pastes. The desktop's `MULTILINE_STYLE` serves the same
 *  field; mobile carries its own, in tokens. */
const OWNER_CODE_STYLE = {
  width: "100%",
  boxSizing: "border-box",
  resize: "none",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-1)",
  padding: "var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
} as const;

/** The two-column recovery-phrase grid. Two columns is what the phone can hold
 *  without a horizontal scroll; `RecoverFlow` uses the same shape. */
const PHRASE_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
} as const;

/** One editable recovery-phrase cell: the barrel's `TextField` with the grid's
 *  `01` index in front of it and the fill state wired to its border. The cell
 *  carries a testid, because the flow-logic tier has to fill 24 of them and a
 *  field with no testid is not reachable by position from there. */
function PhraseCell({
  index,
  word,
  testId,
  label,
  onChange,
  onPaste,
}: {
  index: number;
  word: string;
  testId: string;
  label: string;
  onChange: (index: number, value: string) => void;
  onPaste: (index: number, event: ClipboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <TextField
      value={word}
      onChange={(value) => onChange(index, value)}
      onPaste={(event) => onPaste(index, event)}
      testId={testId}
      label={label}
      filled={word.trim() !== ""}
      mono
      dir="ltr"
      leading={
        <span
          aria-hidden="true"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            flexShrink: 0,
          }}
        >
          {String(index + 1).padStart(2, "0")}
        </span>
      }
    />
  );
}

/**
 * Masked device-password input with a reveal toggle. The field is the barrel's
 * `TextField` and not its `PasswordField`, which is a gallery specimen that
 * renders bullets as text and holds no value, so it cannot collect a password.
 * The toggle stays here rather than in the field, because `type` is a prop: the
 * field never holds reveal state, this wrapper does.
 */
function DevicePasswordField({
  value,
  onChange,
  testId,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
  label: string;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <TextField
      type={revealed ? "text" : "password"}
      value={value}
      onChange={onChange}
      testId={testId}
      label={label}
      mono
      masked={!revealed}
      autoComplete="new-password"
      trailing={
        <Button
          variant="ghost"
          full={false}
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? t("password.input.hide") : t("password.input.show")}
          style={{ border: "none", background: "transparent", padding: 0, height: "auto", width: "auto", flex: "none" }}
        >
          <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
        </Button>
      }
    />
  );
}

/**
 * The mobile identity-first flow (myne-md/myne#768).
 *
 * The phone-side counterpart of the desktop `IdentitySetupDialog` +
 * `IdentityHome`: create one identity, then create or join vaults under it. The
 * backend is the same `sync_person_*` plugin the desktop uses, so an identity
 * made here is addressable from a laptop.
 *
 * Deliberately its own flow rather than an import of the shared desktop dialog:
 * mobile composes its own UI from `mobile/src/components/` and imports no
 * desktop screen or component (that is the whole shape of the client), so
 * reaching into `src/components/IdentitySetupDialog` would be the first mobile
 * screen built from desktop JSX. The commands are shared; the presentation is
 * not. The presentation nonetheless follows the same envelope as every other
 * mobile flow: `Screen` → `FlowHeader` → padded `ScreenScroll` carrying a
 * `Title`/`Lead`, and a `FooterBar` for the step's actions.
 */
export function IdentityFlow({ onCancel, onAccepted }: IdentityFlowProps) {
  const { t } = useTranslation();
  // Names the accept step's phrase grid, which is 24 bare inputs with no visible
  // label of their own.
  const phraseLabelId = useId();
  // …and the join step's, which is a second grid of the same 24 bare inputs. Two
  // ids rather than one: the accept's `aria-labelledby` must not point at a label
  // that belongs to a step that is not on screen.
  const joinPhraseLabelId = useId();
  const [step, setStep] = useState<Step>("gate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server step
  const [serverUrl, setServerUrl] = useState("");
  // The shared invite code for a gated server (myne-md/myne#800); empty for an
  // open one. Identity creation registers a new account, so a gated server
  // refuses it without the code.
  const [inviteCode, setInviteCode] = useState("");

  // Identity
  const [result, setResult] = useState<PersonSetupView | null>(null);
  const [revealed, setRevealed] = useState(false);
  // The type-back challenge (myne-md/myne#855): four positions drawn when the
  // phrase arrives, plus the answers. It REPLACES the acknowledgement checkbox,
  // for the reason `docs/spec/protocol.md` section 7.1.3 gives and the vault flow
  // already acted on: a tick is not evidence, the demonstration is. The phrase is
  // the only way to recover an identity, so a user who never wrote it down had no
  // signal at all until they lost the device.
  const [challenge, setChallenge] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", "", ""]);

  // Home
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [identityCode, setIdentityCode] = useState<string | null>(null);
  // Forget-this-identity acknowledgement (myne-md/myne#782).
  const [forgetAck, setForgetAck] = useState(false);

  // Accept step (myne-md/myne#851 task 14). The invite is held rather than its
  // id, so the step cannot render for a row that has left the list.
  const [acceptInvite, setAcceptInvite] = useState<InviteSummary | null>(null);
  const [ownerCode, setOwnerCode] = useState("");
  // The fingerprint read back from the owner's code, once the owner has been
  // asked to read it aloud. Null means "not inspected", and the SAS block and
  // everything behind it stay closed: an unchecked code must not be acceptable.
  const [ownerFingerprint, setOwnerFingerprint] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [acceptWords, setAcceptWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inspecting, setInspecting] = useState(false);

  // Join step (myne-md/myne#852 task 7). A member's SECOND device adding a vault
  // this identity already belongs to. Its own state rather than the accept's,
  // deliberately: the two steps are never both open, and sharing the fields would
  // make "this step never inherits the other's phrase or password" a property of
  // every reset path instead of a property of the shape.
  const [joinInvite, setJoinInvite] = useState<InviteSummary | null>(null);
  const [joinWords, setJoinWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));
  const [joinPassword, setJoinPassword] = useState("");
  const [joinConfirmPassword, setJoinConfirmPassword] = useState("");
  const [joining, setJoining] = useState(false);
  // The join's own banner. The home step renders the shared `error` in its forget
  // block, so a refusal parked there would follow the user back onto a screen it
  // does not belong to.
  const [joinError, setJoinError] = useState<string | null>(null);

  // Name step (myne-md/myne#851 task 15). It runs after an accept lands and its
  // completion callback is withheld until it finishes, so an accepted vault cannot
  // reach the editor unnamed, the same ordering the desktop gate holds.
  const [nameDraft, setNameDraft] = useState("");
  const [nameChecking, setNameChecking] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Secret-wipe artefact for the two credential-collecting steps, accept and join.
  // Mirrors the in-flight phrase, the owner code and the device password so the
  // unmount cleanup can drop them: V8 strings are immutable, so this is best-effort
  // on the JS side (the load-bearing zeroize is Rust-side), but the reference goes
  // on every exit. Same mechanism as `RecoverFlow`, which holds the same two kinds
  // of secret; the phrase is a full identity credential and the password becomes
  // this device's `vault.member-unlock` credential. One artefact for both steps
  // rather than one each: the unmount cleanup is the half that cannot be forgotten
  // per-path, and a second object here would be a second thing to remember to wipe.
  const acceptSecretsRef = useRef<{
    ownerCode: string;
    words: string[];
    password: string;
    confirmPassword: string;
    joinWords: string[];
    joinPassword: string;
    joinConfirmPassword: string;
  }>({
    ownerCode: "",
    words: [],
    password: "",
    confirmPassword: "",
    joinWords: [],
    joinPassword: "",
    joinConfirmPassword: "",
  });
  const wipeSecrets = useCallback(() => {
    acceptSecretsRef.current = {
      ownerCode: "",
      words: [],
      password: "",
      confirmPassword: "",
      joinWords: [],
      joinPassword: "",
      joinConfirmPassword: "",
    };
  }, []);
  useEffect(() => {
    acceptSecretsRef.current = {
      ownerCode,
      words: acceptWords,
      password,
      confirmPassword,
      joinWords,
      joinPassword,
      joinConfirmPassword,
    };
  });
  useEffect(() => () => wipeSecrets(), [wipeSecrets]);


  // Gate on boot: if an identity already exists, skip straight to the home.
  useEffect(() => {
    if (!HAS_TAURI) {
      setStep("gate");
      return;
    }
    let cancelled = false;
    void personStatus()
      .then((s) => {
        if (cancelled) return;
        if (s.enrolled) {
          setIdentityCode(s.identity_code);
          setStep("home");
        } else if (s.sealed_keypair_present) {
          // A sealed identity this device cannot open with a fresh phrase
          // (myne-md/myne#780): offer to forget it rather than loop through a
          // create that is guaranteed to fail.
          setStep("held");
        } else {
          setStep("gate");
        }
      })
      .catch(() => {
        if (!cancelled) setStep("gate");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load invites whenever the home step is shown.
  useEffect(() => {
    if (step !== "home" || !HAS_TAURI) return;
    let cancelled = false;
    void personListInvites()
      .then((list) => {
        if (!cancelled) setInvites(list);
      })
      .catch(() => {
        if (!cancelled) setInvites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const connectServer = useCallback(async () => {
    const trimmed = serverUrl.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await syncSetEndpoint(trimmed, inviteCode.trim());
      setStep("create");
    } catch (e) {
      setError(serverConnectError(e, t));
    } finally {
      setBusy(false);
    }
  }, [serverUrl, inviteCode, t]);

  // The hosted door uses the same public-CA and hostname verification.
  const connectHosted = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await syncSetEndpoint(HOSTED_SYNC_ORIGIN, inviteCode.trim());
      setStep("create");
    } catch (e) {
      setError(serverConnectError(e, t));
    } finally {
      setBusy(false);
    }
  }, [inviteCode, t]);

  // Forget a held identity this device cannot open with a fresh phrase, so a
  // create can proceed (myne-md/myne#780).
  const forgetHeld = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await personLock(true);
      setStep("gate");
    } catch {
      setError(t("identityFlow.createFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const createIdentity = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await personSetup();
      setResult(view);
      setIdentityCode(view.identity_code);
      setChallenge(pickChallenge());
      setAnswers(["", "", "", ""]);
      setStep("phrase");
    } catch {
      // The typed `NotConfigured` case means the endpoint did not take; send the
      // user back to the server step rather than showing a dead end.
      setError(t("identityFlow.createFailed"));
      setStep("server");
    } finally {
      setBusy(false);
    }
  }, [t]);

  const finishPhrase = useCallback(() => {
    setResult(null);
    setRevealed(false);
    setChallenge([]);
    setAnswers(["", "", "", ""]);
    setStep("home");
  }, []);

  // ── Accept step (myne-md/myne#851 task 14) ──────────────────────────────────

  /** Drop the accept step's secrets from both the state and the wipe ref. Called
   *  on every exit that keeps this flow mounted (back to the home, accepted):
   *  the unmount cleanup covers the rest, since closing the overlay unmounts the
   *  whole flow. */
  const clearAcceptSecrets = useCallback(() => {
    wipeSecrets();
    setOwnerCode("");
    setOwnerFingerprint(null);
    setConfirmed(false);
    setAcceptWords(Array(PHRASE_WORDS).fill(""));
    setPassword("");
    setConfirmPassword("");
  }, [wipeSecrets]);

  /**
   * Open the accept step for a pending invite.
   *
   * Everything the step collects is RESET here rather than on the way out, so a
   * second accept can never inherit the first invite's owner code, phrase or
   * password.
   */
  const openAccept = useCallback((invite: InviteSummary) => {
    clearAcceptSecrets();
    setAcceptInvite(invite);
    setError(null);
    setStep("accept-owner");
  }, [clearAcceptSecrets]);

  /** Leave the accept wizard for the home, dropping what it collected. The
   *  header chevron on step 1 and the footer cancel both land here. */
  const leaveAccept = useCallback(() => {
    clearAcceptSecrets();
    setAcceptInvite(null);
    setError(null);
    setStep("home");
  }, [clearAcceptSecrets]);

  /** Move between the accept wizard's steps, clearing the banner as we go: an
   *  error about a step the user has left is stale the moment they leave it. */
  const goAcceptStep = useCallback((next: AcceptStep) => {
    setError(null);
    setStep(next);
  }, []);

  /** The join step's counterpart. Same rule, same reason: the phrase and the
   *  device password are re-collected per invite rather than left over from the
   *  last one. It touches no accept state, so opening a join cannot clear a form
   *  the user is not looking at anyway. */
  const clearJoinSecrets = useCallback(() => {
    setJoinWords(Array(PHRASE_WORDS).fill(""));
    setJoinPassword("");
    setJoinConfirmPassword("");
    setJoinError(null);
  }, []);

  /**
   * Open the join step for a CLAIMED invite: a vault this identity is already a
   * member of, being added to this device (myne-md/myne#852 task 7).
   *
   * The step collects NO owner code. The owner it verifies against is the one this
   * person's own sealed profile already pins (`decisions/protocol/0675`), which is
   * the whole difference from the accept above it, and the reason the two steps
   * have two error mappings: a `BadRequest` here means "no owner could be
   * established", not "the pasted code did not verify".
   */
  const openJoin = useCallback((invite: InviteSummary) => {
    clearJoinSecrets();
    setJoinInvite(invite);
    setStep("join-phrase");
  }, [clearJoinSecrets]);

  /** Leave the join wizard for the home. The header chevron on step 1 and the
   *  footer cancel both land here. */
  const leaveJoin = useCallback(() => {
    clearJoinSecrets();
    setJoinInvite(null);
    setStep("home");
  }, [clearJoinSecrets]);

  /** Move between the join wizard's steps, clearing its own banner as we go. */
  const goJoinStep = useCallback((next: JoinStep) => {
    setJoinError(null);
    setStep(next);
  }, []);

  /**
   * Read the fingerprint out of the owner's identity code, so the user can
   * compare it with the owner out of band.
   *
   * A failed read clears any fingerprint already on screen and un-confirms, and
   * the desktop form does the same when the code is edited (its `onChange`): a
   * confirmed fingerprint that belongs to a code no longer in the box is a
   * confirmation of nothing.
   */
  const inspectOwner = useCallback(async () => {
    const code = ownerCode.trim();
    if (!code) return;
    setInspecting(true);
    setError(null);
    setOwnerFingerprint(null);
    setConfirmed(false);
    try {
      const view = await inspectInviteCode(code);
      setOwnerFingerprint(view.fingerprint_hex);
    } catch {
      setError(t("identityHome.acceptInvalid"));
    } finally {
      setInspecting(false);
    }
  }, [ownerCode, t]);

  const setAcceptWord = useCallback((index: number, value: string) => {
    setError(null);
    setAcceptWords((words) => words.map((w, i) => (i === index ? value.replace(/\s+/g, "") : w)));
  }, []);

  const setJoinWord = useCallback((index: number, value: string) => {
    setJoinError(null);
    setJoinWords((words) => words.map((w, i) => (i === index ? value.replace(/\s+/g, "") : w)));
  }, []);

  /** Paste-to-grid, shared by the accept grid and the join grid. A 24-word phrase
   *  is pasted rather than typed, so a paste that lands whole in the first cell is
   *  the only usable shape. Fewer than two tokens is left to the browser, so pasting
   *  a single word into a cell still works. `setWords` is whichever grid's setter
   *  was pasted into, so the two steps cannot inherit each other's words, and `onEdit`
   *  clears the banner of the step the paste belongs to. */
  const pasteWords = useCallback(
    (
      setWords: Dispatch<SetStateAction<string[]>>,
      onEdit: () => void,
      index: number,
      event: ClipboardEvent<HTMLInputElement>,
    ) => {
      const tokens = event.clipboardData
        .getData("text")
        .split(/\s+/)
        .filter((word) => word.length > 0);
      if (tokens.length < 2) return;
      event.preventDefault();
      onEdit();
      setWords((words) => {
        const next = [...words];
        for (let i = 0; i < tokens.length && index + i < PHRASE_WORDS; i += 1) {
          next[index + i] = tokens[i];
        }
        return next;
      });
    },
    [],
  );

  // Every gate in one place, so the submit button and the handler cannot
  // disagree about whether the form is complete. The backend re-checks the floor
  // and the phrase; this is the affordance, not the gate.
  //
  // Split per step (myne-md/myne#871): each step's Continue is gated on what
  // THAT step collects, and the final `acceptReady` stays the submit gate so
  // the full check is what guards the call.
  const acceptOwnerReady = ownerFingerprint !== null && confirmed;
  const acceptPhraseReady = acceptWords.every((word) => word.length > 0);
  const acceptReady =
    acceptOwnerReady &&
    acceptPhraseReady &&
    [...password].length >= MIN_PASSWORD_LEN &&
    password === confirmPassword;

  /** The join's gate: the same phrase completeness and the same device-password
   *  floor, and deliberately NO confirmation step. There is no owner code on this
   *  form to confirm, because there is none to collect. */
  const joinPhraseReady = joinWords.every((word) => word.length > 0);
  const joinReady =
    joinPhraseReady &&
    [...joinPassword].length >= MIN_PASSWORD_LEN &&
    joinPassword === joinConfirmPassword;

  /**
   * Claim the invite and materialize the member vault on this device.
   *
   * The password is REQUIRED (myne-md/myne#851 task 7): it is written as this
   * device's `vault.member-unlock` credential as part of installing the session,
   * so a member vault accepted without one could only ever be opened by retyping
   * the recovery phrase. The copy says plainly that it is not the owner's.
   *
   * It lands on the NAME step rather than on `onAccepted` (task 15): the vault is
   * already on disk and unlocked at this point, and the name step is what the owner
   * and every other member will see this person as. `onAccepted` runs from there,
   * so the shell's re-probe happens after the name step has finished.
   */
  const accept = useCallback(async () => {
    if (!acceptInvite || !acceptReady) return;
    setBusy(true);
    setError(null);
    try {
      await personAcceptInvite(
        acceptInvite.invite_id_hex,
        ownerCode.trim(),
        acceptWords.join(" "),
        password,
      );
      setAcceptInvite(null);
      clearAcceptSecrets();
      setError(null);
      setStep("name");
    } catch (e) {
      // Which failure it was, not only "could not be accepted": the kinds are a
      // shared closed enum and carry no secret (myne-md/myne#794).
      setError(t(acceptInviteErrorKey(e)));
    } finally {
      setBusy(false);
    }
  }, [acceptInvite, acceptReady, ownerCode, acceptWords, password, clearAcceptSecrets, t]);

  /**
   * Add a vault this identity already belongs to onto this device
   * (myne-md/myne#852 task 7).
   *
   * It lands on `onAccepted` DIRECTLY, with no name step in between, which is the
   * one deliberate difference from the accept above it. The accept creates a member,
   * so the vault's roster has no row for this person yet and the name is the identity
   * every other member will see. A join installs a vault the person is already a
   * member of, under a name their first device already wrote; asking again would let a
   * second device silently re-name a person, and the roster the name step consults is
   * the one that already holds that name.
   *
   * The refusal mapping is the join's own (`@myne/client-core/join-member-vault`), not
   * the accept's: the accept's `BadRequest` arm tells the user to check a pasted owner
   * code, and this screen never collected one.
   */
  const join = useCallback(async () => {
    if (!joinInvite || !joinReady) return;
    setJoining(true);
    setJoinError(null);
    try {
      await personJoinVault(
        joinInvite.invite_id_hex,
        joinInvite.vault_account_hash_hex,
        joinWords.join(" "),
        joinPassword,
      );
      setJoinInvite(null);
      clearJoinSecrets();
      accepted.current();
    } catch (e) {
      // Which failure it was, not only "could not be added": the kinds are a shared
      // closed enum and carry no secret (myne-md/myne#794). `Transport` is the arm a
      // user will actually hit here, since a group package the owner has not
      // published yet arrives as one, so the copy says to retry.
      setJoinError(t(memberJoinVaultErrorKey(e)));
    } finally {
      setJoining(false);
    }
  }, [joinInvite, joinReady, joinWords, joinPassword, clearJoinSecrets, t]);

  // ── Name step (myne-md/myne#851 task 15) ─────────────────────────────────────

  /**
   * The completion callback and its latch.
   *
   * `onAccepted` is an inline arrow in `AppShell`, so it is a new function every
   * render; reading it through a ref is what lets the check below run exactly once
   * per arrival at the step rather than on every parent render. Same shape, and the
   * same reason, as the desktop `MemberNameGate`.
   */
  const accepted = useRef(onAccepted);
  accepted.current = onAccepted;
  const nameChecked = useRef(false);

  /**
   * Decide whether to ask at all, then ask.
   *
   * The question is the roster's, not the store's: a row carries `is_self` (decided
   * by identity, myne-md/myne#859) and `name_state`, which separates a verified name
   * from an absent record and from one whose signature failed. The raw store is keyed
   * by `person_id_hash`, which this screen has no way to supply for itself, and it
   * carries no verification verdict, and asking it would mean treating a tampered record
   * as a name.
   *
   * A member re-invited to a vault they already named in is the reason this is here
   * at all; an unreadable roster is not a reason to skip a required step, and it is
   * not a reason to claim a name either, so the safe direction is to ask.
   */
  useEffect(() => {
    if (step !== "name" || nameChecked.current) return;
    let cancelled = false;
    setNameChecking(true);
    void (async () => {
      let named = false;
      try {
        const view = await listRoster();
        named = view.members.some((m) => m.is_self && m.name_state === "verified");
      } catch {
        named = false;
      }
      if (cancelled) return;
      // The latch goes HERE, after the await and after the cancellation guard, to
      // match the desktop gate (`src/components/sync/MemberNameGate.tsx`) exactly
      // (myne-md/myne#871). Latched before the await, the second run a StrictMode
      // double-invoke performs bails on it while the first run's cleanup has
      // already marked that one cancelled, and the roster answer is then discarded
      // by neither branch, so the step would render "Checking your name…" forever.
      // That hang is NOT reachable on this client as it stands, and saying so is
      // the honest form of the claim: the flow mounts at the gate step, and
      // StrictMode double-invokes effects at MOUNT, so this effect's one run
      // happens long after the double-invoke. It is fixed because the ordering is
      // the defect the desktop carried and the twin should not be the one place a
      // future mount change reopens it.
      nameChecked.current = true;
      setNameChecking(false);
      if (named) accepted.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  const saveName = useCallback(async () => {
    const name = nameDraft.trim();
    if (name === "" || nameBusy) return;
    setNameBusy(true);
    setNameError(null);
    try {
      await setMyMemberName(name);
      accepted.current();
    } catch (e) {
      // Which refusal it was: `NameTooLong`, `StoreUnreadable` and `SlotNotUnlocked`
      // are three different remedies, and the mapping is shared with the desktop
      // writer so neither client can drop an arm (`@myne/client-core/member-name`).
      setNameError(t(memberNameErrorKey(e)));
    } finally {
      setNameBusy(false);
    }
  }, [nameDraft, nameBusy, t]);

  const renderServer = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.server.title")} onBack={() => setStep("gate")} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.server.title")}</Title>
        <Lead>{t("identityFlow.server.lead")}</Lead>
        <div style={{ marginTop: "var(--space-5)" }}>
          <Button
            variant="secondary"
            onClick={() => void connectHosted()}
            disabled={busy}
            data-testid="identity-flow.server-myne-sync"
          >
            {t("identityFlow.server.useMyneSync")}
          </Button>
        </div>
        <div style={{ ...HINT_STYLE, marginTop: "var(--space-4)" }}>{t("identityFlow.server.selfHostedHint")}</div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel>{t("identityFlow.server.urlLabel")}</FieldLabel>
          <MonoField
            value={serverUrl}
            onChange={setServerUrl}
            placeholder="https://sync.example"
            inputMode="url"
            testId="identity-flow.server-input"
          />
        </div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel>{t("sync.endpoint.inviteLabel")}</FieldLabel>
          <MonoField
            value={inviteCode}
            onChange={setInviteCode}
            placeholder={t("sync.endpoint.invitePlaceholder")}
            testId="identity-flow.server-invite"
          />
        </div>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button variant="secondary" full={false} onClick={() => setStep("gate")} data-testid="identity-flow.server-back">
          {t("identityFlow.back")}
        </Button>
        <Button
          onClick={() => void connectServer()}
          disabled={busy || !serverUrl.trim()}
          data-testid="identity-flow.server-connect"
        >
          {busy ? t("identityFlow.server.connecting") : t("identityFlow.server.connect")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.server.connecting")} />}
    </Screen>
  );

  const renderHeld = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.held.title")} onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.held.title")}</Title>
        <Lead>{t("identityFlow.held.lead")}</Lead>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        <Button variant="danger" onClick={() => void forgetHeld()} disabled={busy} data-testid="identity-flow.held-forget">
          {t("identityFlow.held.forget")}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.held-cancel">
          {t("identityFlow.back")}
        </Button>
      </FooterBar>
    </Screen>
  );

  const renderGate = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.title")} onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.title")}</Title>
        <Lead>{t("identityFlow.lead")}</Lead>
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        <Button onClick={() => setStep("server")} data-testid="identity-flow.start">
          {t("identityFlow.start")}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.skip">
          {t("identityFlow.skip")}
        </Button>
      </FooterBar>
    </Screen>
  );

  const renderCreate = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.create.title")} onBack={() => setStep("server")} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.create.title")}</Title>
        <Lead>{t("identityFlow.create.lead")}</Lead>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button variant="secondary" full={false} onClick={() => setStep("server")}>
          {t("identityFlow.back")}
        </Button>
        <Button onClick={() => void createIdentity()} disabled={busy} data-testid="identity-flow.create">
          {busy ? t("identityFlow.create.working") : t("identityFlow.create.cta")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.create.working")} />}
    </Screen>
  );

  const renderPhrase = () => {
    const phrase = (result?.phrase ?? "").split(" ");
    // The gate: the challenge must be answered, and the phrase revealed (the
    // challenge is unanswerable without it).
    const { matches: corrects, allCorrect } = phraseTypeBackMatches(phrase, challenge, answers);
    return (
      <Screen>
        <FlowHeader label={t("identityFlow.phrase.title")} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("identityFlow.phrase.title")}</Title>
          <Lead>{t("identityFlow.phrase.warning")}</Lead>
          <div style={{ marginTop: "var(--space-5)" }}>
            {revealed ? (
              <RecoveryGrid words={phrase} />
            ) : (
              <Button onClick={() => setRevealed(true)} data-testid="identity-flow.phrase-reveal">
                {t("identityFlow.phrase.reveal")}
              </Button>
            )}
          </div>
          <div style={{ marginTop: "var(--space-4)" }}>
            <FieldLabel>{t("identityFlow.phrase.typebackLead")}</FieldLabel>
            {challenge.map((pos, i) => (
              <div key={pos} style={{ marginTop: "var(--space-3)" }}>
                <FieldLabel>
                  {t("identityFlow.phrase.wordNumber", { position: pos + 1 })}
                </FieldLabel>
                <MonoField
                  value={answers[i] ?? ""}
                  onChange={(v) => setAnswers((prev) => prev.map((a, j) => (j === i ? v : a)))}
                  placeholder=""
                  dir="ltr"
                  testId={`identity-flow.typeback-${pos + 1}`}
                />
                {corrects[i] === false ? (
                  <div
                    style={MISMATCH_STYLE}
                    data-testid={`identity-flow.typeback-error-${pos + 1}`}
                  >
                    {t("identityFlow.phrase.wordMismatch", { pos: pos + 1 })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScreenScroll>
        <FooterBar>
          <Button
            onClick={finishPhrase}
            disabled={!revealed || !allCorrect}
            data-testid="identity-flow.phrase-continue"
          >
            {t("identityFlow.phrase.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  };

  const renderHome = () => {
    // The invite list is recipient-scoped and carries CLAIMED rows too, and a
    // claimed row is not an invitation to accept: the accept claims the invite and
    // mints the membership, so running it on a claimed one is a re-claim of something
    // this identity already holds a membership for. The two lists render different
    // affordances off the same row shape, so they are split once here rather than
    // filtered again at each use (myne-md/myne#852 task 7).
    const pending = (invites ?? []).filter((i) => !i.claimed);
    const claimed = (invites ?? []).filter((i) => i.claimed);
    return (
      <Screen>
        <FlowHeader label={t("identityFlow.home.title")} onBack={onCancel} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("identityFlow.home.title")}</Title>
          <Lead>{t("identityFlow.home.lead")}</Lead>

          {identityCode ? (
            <div style={{ marginTop: "var(--space-5)" }}>
              <FieldLabel>{t("identityFlow.home.codeLabel")}</FieldLabel>
              <MonoBox value={identityCode} testId="identity-flow.home-code" />
            </div>
          ) : null}

          <div style={{ marginTop: "var(--space-5)" }}>
            <FieldLabel>{t("identityFlow.home.invitesHeading")}</FieldLabel>
            {invites === null ? (
              <Spinner />
            ) : pending.length === 0 && claimed.length === 0 ? (
              <div style={HINT_STYLE} data-testid="identity-flow.home-empty">
                {t("identityFlow.home.noInvites")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {pending.map((inv) => (
                  <div
                    key={inv.invite_id_hex}
                    data-testid="identity-flow.invite-row"
                    style={{
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-1)",
                      borderRadius: "var(--radius-2)",
                      padding: "var(--space-3)",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-3)",
                        wordBreak: "break-all",
                        userSelect: "all",
                      }}
                    >
                      {inv.vault_account_hash_hex}
                    </div>
                    <div style={{ ...HINT_STYLE, marginTop: "var(--space-2)" }}>{t("identityFlow.home.inviteHint")}</div>
                    {/* The action the row was missing (myne-md/myne#851 task
                        14). Until this landed the list named the invite and the
                        hint told the user to open it from the vault picker,
                        which cannot open a vault that has not been claimed yet:
                        there was no way to accept on this client at all. */}
                    <Button
                      variant="secondary"
                      full={false}
                      onClick={() => openAccept(inv)}
                      style={{ marginTop: "var(--space-3)" }}
                      data-testid="identity-flow.invite-open"
                    >
                      {t("identityHome.accept")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* The second device (myne-md/myne#852 task 7). A claimed invite is a
              vault this identity is already a member of, and before this block
              existed it was filtered out of the list above altogether, so a phone
              had no way to add one: the vault simply never appeared, and the
              "No invitations yet" empty state is what a member looking at their
              own claimed invite saw. */}
          {claimed.length > 0 ? (
            <div style={{ marginTop: "var(--space-5)" }}>
              <FieldLabel>{t("identityHome.claimedHeading")}</FieldLabel>
              <div data-testid="identity-flow.claimed-hint" style={HINT_STYLE}>
                {t("identityHome.claimedHint")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
                {claimed.map((inv) => (
                  <div
                    key={inv.invite_id_hex}
                    data-testid="identity-flow.claimed-row"
                    style={{
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-1)",
                      borderRadius: "var(--radius-2)",
                      padding: "var(--space-3)",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-3)",
                        wordBreak: "break-all",
                        userSelect: "all",
                      }}
                    >
                      {inv.vault_account_hash_hex}
                    </div>
                    <Button
                      variant="secondary"
                      full={false}
                      onClick={() => openJoin(inv)}
                      style={{ marginTop: "var(--space-3)" }}
                      data-testid="identity-flow.join-open"
                    >
                      {t("identityHome.join")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Forget this identity on this device (myne-md/myne#782). Device-local:
              the server account survives and is recoverable with the phrase. */}
          <div style={{ marginTop: "var(--space-5)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--line-1)" }}>
            <FieldLabel>{t("identityFlow.home.forgetHeading")}</FieldLabel>
            {error ? (
              <Banner kind="warning" style={{ marginBottom: "var(--space-3)" }}>
                {error}
              </Banner>
            ) : null}
            <AckRow
              checked={forgetAck}
              onToggle={() => setForgetAck((v) => !v)}
              testId="identity-flow.home-forget-ack"
            >
              {t("identityFlow.home.forgetCheckbox")}
            </AckRow>
            <Button
              variant="ghost"
              disabled={!forgetAck || busy}
              onClick={() => void forgetHeld()}
              style={{ color: "var(--danger)", marginTop: "var(--space-3)" }}
              data-testid="identity-flow.home-forget"
            >
              {t("identityFlow.home.forget")}
            </Button>
          </div>
        </ScreenScroll>
      </Screen>
    );
  };

  /**
   * Accept an invite (myne-md/myne#851 task 14).
   *
   * Three things are collected, and the step is deliberately sequential: the
   * owner's identity code, the fingerprint read out of it for an out-of-band
   * compare, and only then the phrase and this device's password. Everything past
   * the fingerprint is hidden until the code has been checked, so a user cannot
   * type a recovery phrase into a form whose owner they have not verified: the
   * phrase is the one secret that must never reach the wrong party, and the
   * invitation is the one place another party chooses what this device is asked
   * to open.
   *
   * The copy is the desktop's, key for key (`identityHome.accept*`): both clients
   * render the same catalog, and a member accepting on a phone and a laptop is
   * answering the same question.
   */
  const renderAccept = () => {
    const ready = acceptReady && !busy;
    return (
      <Screen>
        <FlowHeader
          label={t("identityHome.accept")}
          onBack={() => {
            // Step 1's chevron is the wizard's exit; a later step's goes back one.
            if (step === "accept-owner") leaveAccept();
            else if (step === "accept-phrase") goAcceptStep("accept-owner");
            else goAcceptStep("accept-phrase");
          }}
        />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          {step === "accept-owner" ? (
            <>
              <StepProgress
                testId="identity-flow.accept-step"
                n={1}
                total={3}
                label={t("identityHome.stepVerifyOwner")}
              />
              <Title>{t("identityHome.acceptHeading")}</Title>
              <div data-testid="identity-flow.accept-hint" style={HINT_STYLE}>
                {t("identityHome.acceptHint")}
              </div>

              <div style={{ marginTop: "var(--space-5)" }}>
                <FieldLabel>{t("identityHome.acceptOwnerCodeLabel")}</FieldLabel>
                <textarea
                  data-testid="identity-flow.accept-owner-code"
                  aria-label={t("identityHome.acceptOwnerCodeLabel")}
                  value={ownerCode}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                    setOwnerCode(e.target.value);
                    setOwnerFingerprint(null);
                    setConfirmed(false);
                    setError(null);
                  }}
                  rows={3}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  style={OWNER_CODE_STYLE}
                />
              </div>

              {ownerFingerprint === null ? (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Button
                    variant="secondary"
                    full={false}
                    data-testid="identity-flow.accept-inspect"
                    disabled={inspecting || ownerCode.trim() === ""}
                    onClick={() => void inspectOwner()}
                  >
                    {t("identityHome.acceptInspect")}
                  </Button>
                </div>
              ) : (
                <div data-testid="identity-flow.accept-sas">
                  <div data-testid="identity-flow.accept-sas-hint" style={{ ...HINT_STYLE, marginTop: "var(--space-4)" }}>
                    {t("identityHome.acceptSasHint")}
                  </div>
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <MonoBox value={ownerFingerprint} testId="identity-flow.accept-owner-fingerprint" />
                  </div>
                  <AckRow
                    checked={confirmed}
                    onToggle={() => setConfirmed((v) => !v)}
                    testId="identity-flow.accept-confirm"
                  >
                    {t("identityHome.acceptConfirm")}
                  </AckRow>
                </div>
              )}

              {/* The inspect failure belongs to THIS step, so its banner does too. */}
              {error ? (
                <Banner kind="danger" testID="identity-flow.accept-error" style={{ marginTop: "var(--space-4)" }}>
                  {error}
                </Banner>
              ) : null}
            </>
          ) : step === "accept-phrase" ? (
            <>
              <StepProgress
                testId="identity-flow.accept-step"
                n={2}
                total={3}
                label={t("identityHome.stepRecoveryPhrase")}
              />
              <Title>{t("identityHome.phraseHeading")}</Title>
              <div style={HINT_STYLE}>{t("identityHome.acceptPhraseHint")}</div>

              <div id={phraseLabelId} data-testid="identity-flow.accept-phrase-label" style={{ marginTop: "var(--space-4)" }}>
                <FieldLabel>{t("identityHome.acceptPhraseLabel")}</FieldLabel>
              </div>
              <div style={HINT_STYLE}>{t("sync.enroll.recoveryPhraseHint")}</div>
              <div role="group" aria-labelledby={phraseLabelId} style={PHRASE_GRID_STYLE}>
                {acceptWords.map((word, i) => (
                  <PhraseCell
                    key={i}
                    index={i}
                    word={word}
                    testId={
                      i === 0
                        ? "identity-flow.accept-phrase"
                        : `identity-flow.accept-phrase-cell-${i + 1}`
                    }
                    label={t("sync.enroll.wordAria", { number: i + 1 })}
                    onChange={setAcceptWord}
                    onPaste={(index, event) => pasteWords(setAcceptWords, () => setError(null), index, event)}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <StepProgress
                testId="identity-flow.accept-step"
                n={3}
                total={3}
                label={t("identityHome.stepDevicePassword")}
              />
              <Title>{t("identityHome.passwordHeading")}</Title>
              <div
                data-testid="identity-flow.accept-password-note"
                style={{ ...HINT_STYLE, marginTop: "var(--space-4)" }}
              >
                {t("identityHome.acceptPasswordNote")}
              </div>
              <div data-testid="identity-flow.accept.password-label" style={{ marginTop: "var(--space-3)" }}>
                <FieldLabel>{t("password.createForm.passwordLabel")}</FieldLabel>
              </div>
              <DevicePasswordField
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  setError(null);
                }}
                testId="identity-flow.accept.password-input"
                label={t("password.createForm.passwordLabel")}
              />
              <div data-testid="identity-flow.accept.confirm-label" style={{ marginTop: "var(--space-3)" }}>
                <FieldLabel>{t("password.createForm.confirmLabel")}</FieldLabel>
              </div>
              <DevicePasswordField
                value={confirmPassword}
                onChange={(v) => {
                  setConfirmPassword(v);
                  setError(null);
                }}
                testId="identity-flow.accept.confirm-input"
                label={t("password.createForm.confirmLabel")}
              />
              {confirmPassword !== "" && password !== confirmPassword ? (
                <div style={MISMATCH_STYLE} data-testid="identity-flow.accept.password-mismatch">
                  {t("password.createForm.mismatch")}
                </div>
              ) : null}

              {/* The submit refusal belongs to THIS step, so its banner does too. */}
              {error ? (
                <Banner kind="danger" testID="identity-flow.accept-error" style={{ marginTop: "var(--space-4)" }}>
                  {error}
                </Banner>
              ) : null}
            </>
          )}
        </ScreenScroll>
        <FooterBar>
          {step === "accept-owner" ? (
            <>
              <Button
                variant="secondary"
                full={false}
                onClick={leaveAccept}
                data-testid="identity-flow.accept-cancel"
              >
                {t("identityFlow.back")}
              </Button>
              <Button
                onClick={() => goAcceptStep("accept-phrase")}
                disabled={!acceptOwnerReady}
                data-testid="identity-flow.accept-continue"
              >
                {t("common.continue")}
              </Button>
            </>
          ) : step === "accept-phrase" ? (
            <>
              <Button
                variant="secondary"
                full={false}
                onClick={() => goAcceptStep("accept-owner")}
                data-testid="identity-flow.accept-step-back"
              >
                {t("common.back")}
              </Button>
              <Button
                onClick={() => goAcceptStep("accept-password")}
                disabled={!acceptPhraseReady}
                data-testid="identity-flow.accept-continue"
              >
                {t("common.continue")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                full={false}
                onClick={() => goAcceptStep("accept-phrase")}
                data-testid="identity-flow.accept-step-back"
              >
                {t("common.back")}
              </Button>
              <Button
                onClick={() => void accept()}
                disabled={!ready}
                data-testid="identity-flow.accept.submit"
              >
                {t("identityHome.acceptSubmit")}
              </Button>
            </>
          )}
        </FooterBar>
        {busy && <BlockingOverlay title={t("identityHome.acceptSubmit")} />}
      </Screen>
    );
  };

  /**
   * Add a vault this identity already belongs to onto this device
   * (myne-md/myne#852 task 7).
   *
   * Two things are collected and the owner code is NOT one of them, which is the
   * whole shape of the step. A second device has no out-of-band owner code, and the
   * owner it verifies the group package against is the one this person's own sealed
   * profile already pins (`decisions/protocol/0675`); a field here would let whatever
   * is pasted into it become the trust anchor the pin exists to be. So there is no
   * code field, no fingerprint compare and nothing to confirm, and the form goes
   * straight to the phrase and this device's password.
   *
   * The copy is the desktop's, key for key (`identityHome.join*`): both clients render
   * the same catalog, and a member adding a vault on a phone and on a laptop is
   * answering the same question.
   */
  const renderJoin = () => {
    const ready = joinReady && !joining;
    return (
      <Screen>
        <FlowHeader
          label={t("identityHome.join")}
          onBack={() => {
            // Step 1's chevron is the wizard's exit; step 2's goes back one.
            if (step === "join-phrase") leaveJoin();
            else goJoinStep("join-phrase");
          }}
        />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          {step === "join-phrase" ? (
            <>
              <StepProgress
                testId="identity-flow.join-step"
                n={1}
                total={2}
                label={t("identityHome.stepRecoveryPhrase")}
              />
              <Title>{t("identityHome.phraseHeading")}</Title>
              <div data-testid="identity-flow.join-hint" style={HINT_STYLE}>
                {t("identityHome.joinHint")}
              </div>

              <div
                id={joinPhraseLabelId}
                data-testid="identity-flow.join-phrase-label"
                style={{ marginTop: "var(--space-4)" }}
              >
                <FieldLabel>{t("identityHome.joinPhraseLabel")}</FieldLabel>
              </div>
              <div style={HINT_STYLE}>{t("sync.enroll.recoveryPhraseHint")}</div>
              <div role="group" aria-labelledby={joinPhraseLabelId} style={PHRASE_GRID_STYLE}>
                {joinWords.map((word, i) => (
                  <PhraseCell
                    key={i}
                    index={i}
                    word={word}
                    testId={
                      i === 0 ? "identity-flow.join-phrase" : `identity-flow.join-phrase-cell-${i + 1}`
                    }
                    label={t("sync.enroll.wordAria", { number: i + 1 })}
                    onChange={setJoinWord}
                    onPaste={(index, event) =>
                      pasteWords(setJoinWords, () => setJoinError(null), index, event)
                    }
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <StepProgress
                testId="identity-flow.join-step"
                n={2}
                total={2}
                label={t("identityHome.stepDevicePassword")}
              />
              <Title>{t("identityHome.passwordHeading")}</Title>
              <div
                data-testid="identity-flow.join-password-note"
                style={{ ...HINT_STYLE, marginTop: "var(--space-4)" }}
              >
                {t("identityHome.joinPasswordNote")}
              </div>
              <div data-testid="identity-flow.join.password-label" style={{ marginTop: "var(--space-3)" }}>
                <FieldLabel>{t("password.createForm.passwordLabel")}</FieldLabel>
              </div>
              <DevicePasswordField
                value={joinPassword}
                onChange={(v) => {
                  setJoinPassword(v);
                  setJoinError(null);
                }}
                testId="identity-flow.join.password-input"
                label={t("password.createForm.passwordLabel")}
              />
              <div data-testid="identity-flow.join.confirm-label" style={{ marginTop: "var(--space-3)" }}>
                <FieldLabel>{t("password.createForm.confirmLabel")}</FieldLabel>
              </div>
              <DevicePasswordField
                value={joinConfirmPassword}
                onChange={(v) => {
                  setJoinConfirmPassword(v);
                  setJoinError(null);
                }}
                testId="identity-flow.join.confirm-input"
                label={t("password.createForm.confirmLabel")}
              />
              {joinConfirmPassword !== "" && joinPassword !== joinConfirmPassword ? (
                <div style={MISMATCH_STYLE} data-testid="identity-flow.join.password-mismatch">
                  {t("password.createForm.mismatch")}
                </div>
              ) : null}

              {/* The submit refusal belongs to THIS step, so its banner does too. */}
              {joinError ? (
                <Banner kind="danger" testID="identity-flow.join-error" style={{ marginTop: "var(--space-4)" }}>
                  {joinError}
                </Banner>
              ) : null}
            </>
          )}
        </ScreenScroll>
        <FooterBar>
          {step === "join-phrase" ? (
            <>
              <Button
                variant="secondary"
                full={false}
                onClick={leaveJoin}
                data-testid="identity-flow.join-cancel"
              >
                {t("identityFlow.back")}
              </Button>
              <Button
                onClick={() => goJoinStep("join-password")}
                disabled={!joinPhraseReady}
                data-testid="identity-flow.join-continue"
              >
                {t("common.continue")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                full={false}
                onClick={() => goJoinStep("join-phrase")}
                data-testid="identity-flow.join-step-back"
              >
                {t("common.back")}
              </Button>
              <Button
                onClick={() => void join()}
                disabled={!ready}
                data-testid="identity-flow.join.submit"
              >
                {t("identityHome.joinSubmit")}
              </Button>
            </>
          )}
        </FooterBar>
        {joining && <BlockingOverlay title={t("identityHome.joinSubmit")} />}
      </Screen>
    );
  };

  /**
   * The required name step.
   *
   * There is no skip control and no back: story 6 of the feature makes this step
   * unskippable during onboarding, so the exit is quitting the app, which leaves the
   * vault exactly as the accept left it: openable, unnamed, and falling back to the
   * fingerprint. It writes NOTHING until the user saves, so there is no half-written
   * name anywhere. The copy is the desktop gate's `sync.nameGate.*` keys verbatim:
   * two clients holding the same key cannot render different words.
   */
  const renderName = () => {
    const ready = !nameBusy && nameDraft.trim() !== "";
    return (
      <Screen>
        <FlowHeader label={t("sync.nameGate.title")} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("sync.nameGate.title")}</Title>
          <Lead>{t("sync.nameGate.body")}</Lead>
          {nameChecking ? (
            <div data-testid="identity-flow.name-checking" style={HINT_STYLE}>
              {t("sync.nameGate.checking")}
            </div>
          ) : (
            <>
              <div style={{ marginTop: "var(--space-5)" }}>
                <FieldLabel>{t("sync.nameGate.label")}</FieldLabel>
                <TextField
                  value={nameDraft}
                  onChange={(value) => {
                    setNameError(null);
                    setNameDraft(value);
                  }}
                  onEnter={() => void saveName()}
                  testId="identity-flow.name-input"
                  label={t("sync.nameGate.label")}
                  disabled={nameBusy}
                  autoCapitalize="words"
                />
              </div>
              {nameError ? (
                <Banner kind="danger" testID="identity-flow.name-error" style={{ marginTop: "var(--space-4)" }}>
                  {nameError}
                </Banner>
              ) : null}
            </>
          )}
        </ScreenScroll>
        <FooterBar>
          <Button
            onClick={() => void saveName()}
            disabled={!ready}
            data-testid="identity-flow.name.save"
          >
            {t("sync.nameGate.save")}
          </Button>
        </FooterBar>
        {nameBusy && <BlockingOverlay title={t("sync.nameGate.save")} />}
      </Screen>
    );
  };

  return (
    <Screen style={{ padding: 0 }}>
      {step === "gate" && renderGate()}
      {step === "held" && renderHeld()}
      {step === "server" && renderServer()}
      {step === "create" && renderCreate()}
      {step === "phrase" && renderPhrase()}
      {step === "home" && renderHome()}
      {(step === "accept-owner" || step === "accept-phrase" || step === "accept-password") &&
        renderAccept()}
      {(step === "join-phrase" || step === "join-password") && renderJoin()}
      {step === "name" && renderName()}
    </Screen>
  );
}
