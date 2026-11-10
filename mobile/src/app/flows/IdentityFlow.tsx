import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LEN, passwordLength } from "@myne/client-core/password-policy";
import { formatPersonAccountNumber } from "@myne/client-core/person-account";
import { personJoinErrorKey } from "@myne/client-core/person-join";
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
  PhraseEntryGrid,
  TextField,
  RecoveryGrid,
  Checkbox,
  Banner,
  Spinner,
  BlockingOverlay,
  Icon,
  ListGroup,
} from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import {
  copySecretToClipboard,
  saveSecretToDocuments,
  secretSaveMessage,
} from "../../lib/secret-export";
import { canHoldSecretOnClipboard } from "../../lib/clipboardTransport";
// The kit's file format, ALIASED to the desktop implementation rather than
// re-derived here, for the reason `CreateVaultFlow` gives: a document saved on a
// phone is read back by a person on a computer, so it has to be one function.
import { recoveryKitText } from "@myne/recovery-kit";
import {
  personSetup,
  personStatus,
  personUnlock,
  personAccountNumber,
  personRegister,
  personListInvites,
  personAcceptInvite,
  personJoinVault,
  personJoinDevice,
  personClaimDevice,
  personListVaults,
  personLock,
  type PersonAccountState,
  type PersonSetupView,
  type InviteSummary,
} from "../../lib/personAccount";
import { syncSetEndpoint, syncGetEndpoint, listRoster } from "../../lib/sync";
import { setMyMemberName, memberNameErrorKey } from "../../lib/memberNames";
import { pickChallenge, phraseTypeBackMatches } from "../../lib/phraseChallenge";
import { acceptInviteErrorKey } from "@myne/client-core/accept-invite";
import { memberJoinVaultErrorKey } from "@myne/client-core/join-member-vault";
import type { IdentityFlowProps, JoinLanding } from "./types";
import { FieldLabel } from "@myne/field-label";

type Step =
  | "gate"
  | "held"
  | "create"
  // The gate's third door: this device has never held the identity, and the user
  // brings it across with its 24-word phrase instead of minting a new one. It
  // sits beside `create` because it is the same fork, one step over.
  | "recover"
  /**
   * "I already have an identity", as its own first-run step (myne-md/myne#932).
   *
   * The welcome screen's second button used to be "Connect to my account", which
   * only ever opened the QR scanner, and the phrase door sat behind a button
   * labelled "Create". The desktop answers the same fork at the top level
   * (`IdentitySetupPanel`: "A new identity → Create" beside "I already have one →
   * Recover"), so this step offers the two CREDENTIALS one already has: the 24
   * words, or a code from a device that has the identity.
   */
  | "join-fork"
  | "phrase"
  // The type-back challenge gets a step of its own (myne-md/myne#869), the
  // `kit`/`typeback` split `CreateVaultFlow` has had since it shipped: the
  // phrase step shows the words and nothing else, and this step asks for four
  // of them back. On one screen the challenge read as a footnote to the grid.
  | "typeback"
  | "home"
  /**
   * The identity unlock door (2026-10-25). Desktop's identity home has had it
   * since `PersonLocked` became reachable; the phone did not, so a phone holding
   * a SEALED identity offered "Create a vault" whose only outcome was that
   * refusal, with no surface that clears it. Reached from the home's locked
   * block, which replaces the action rather than disabling it.
   */
  | "unlock-identity"
  /**
   * The explicit registration (myne-md/myne#911 task 12, mirroring the desktop
   * identity home's register block).
   *
   * Creating an identity is network-free, so a phone that has no server
   * configured still ends up with one: `reserved`, sealed on disk, usable, and
   * not reachable by anybody else. Registration is the separate act that asks for
   * the 24 words as proof of possession, and without this step a phone-created
   * identity could never become invitable at all.
   */
  | "register"
  /**
   * The register act's SECOND half (2026-10-24, desktop parity). The server is a
   * decision and the phrase is a secret, and asking for both on one screen made
   * the user read two unrelated things before understanding either — the desktop
   * dialog split for the same reason. `register` is the server step.
   */
  | "register-phrase"
  | "accept-owner"
  | "accept-phrase"
  | "accept-password"
  | "join-phrase"
  | "join-password"
  /**
   * The PERSON device join (myne-md/myne#911 task 9, wired on this client by
   * task 12): a fresh device scans the owner's code, types the identity phrase,
   * and waits for an existing device to approve it. Distinct from the two join
   * steps above, which join a MEMBER to one shared vault and end with the vault on
   * disk: this one admits the device to the whole account and installs no key
   * material, so the vaults it then lists still open with their own passwords.
   */
  | "person-phrase"
  | "person-pending"
  /**
   * The join is admitted and only the account's vault list is outstanding
   * (myne-md/myne#911 review). A step rather than a fire-and-forget call,
   * because `sync_person_list_vaults` materialises each vault's frame locally
   * and is the ONLY thing that puts the account's vaults on this device: a
   * failure used to be swallowed and the flow routed onward to a picker with
   * nothing in it, with a comment claiming a later discovery retries, which was
   * not true. Here the failure is visible and retryable.
   */
  | "person-finishing"
  | "name";

/** The accept wizard's steps, in order. A step-changing control names the step
 *  it moves to, so the three screens cannot disagree about the sequence. */
type AcceptStep = "accept-owner" | "accept-phrase" | "accept-password";

/** The join wizard's two steps, same shape. */
type JoinStep = "join-phrase" | "join-password";

/** Recovery-phrase width. Frozen by BIP-39 at 24 words (256 bits) and by
 *  `PHRASE_CELL_COUNT` on the desktop's `PhraseEntryGrid`; the client
 *  does not choose it, so a local constant is not a second source of truth. */
const PHRASE_WORDS = 24;

/** The project's device-password floor. A pre-check, not the gate: the backend
 *  holds the same floor and refuses regardless, so a drift here costs an error
 *  message rather than a weak credential. Counted in Unicode scalar values
 *  rather than UTF-16 units, the difference a passphrase with an emoji in it
 *  would otherwise hit. `RecoverFlow` and `MemberUnlockBlock` carry the same
 *  local mirror. */


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
export function IdentityFlow({
  onCancel,
  onAccepted,
  onCreateVault,
  fromQr,
  fromPersonQr,
  initialStep,
  onScanCode,
  onUnlocked,
}: IdentityFlowProps) {
  const { t, i18n } = useTranslation();
  // The clipboard's auto-clear timer holds the phrase in its closure, so this
  // ref MUST be cancelled on unmount: the same rule `CreateVaultFlow` states
  // over the account number: without it the only copy of a person's identity
  // phrase sits in the JS heap for the full 30 s after the screen is gone.
  const clipboardCancelRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      clipboardCancelRef.current?.();
      clipboardCancelRef.current = null;
    },
    [],
  );
  // Names the accept step's phrase grid, which is 24 bare inputs with no visible
  // label of their own.
  const phraseLabelId = useId();
  // …and the join step's, which is a second grid of the same 24 bare inputs. Two
  // ids rather than one: the accept's `aria-labelledby` must not point at a label
  // that belongs to a step that is not on screen.
  const joinPhraseLabelId = useId();
  /** The register and person-join grids' labels, same reason as the two above. */
  const registerPhraseLabelId = useId();
  const personPhraseLabelId = useId();
  // …and the recover step's, a third grid of the same fields, for the same reason
  // a third time.
  const recoverPhraseLabelId = useId();
  /**
   * Whether this mount IS the sync surface's repair door, as a BOOLEAN.
   *
   * A flag rather than the callback it came from, because a callback prop is not a
   * stable effect key: `EditorFlow` passes an inline arrow, so naming `onUnlocked`
   * in the boot probe's dependency list would re-probe on every parent render and
   * drag a user who had left the phrase grid back onto it (myne-md/myne#1029
   * review). The callback itself is read through a ref, the same way the invite
   * block below reads its own.
   */
  const repairDoor = onUnlocked !== undefined;
  const onUnlockedRef = useRef(onUnlocked);
  useEffect(() => {
    onUnlockedRef.current = onUnlocked;
  }, [onUnlocked]);
  /** Where a mount lands when the probe cannot answer: the door's own step, never
   *  the creation gate on a device that demonstrably holds an identity. */
  const unaskedStep: Step = repairDoor ? "unlock-identity" : (initialStep ?? "gate");
  const [step, setStep] = useState<Step>(unaskedStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NO server step (myne-md/myne#911 task 12). It used to gate the create door,
  // which made an offline first run impossible on this client, and the endpoint it
  // collected lives in Settings (Sync), where a gated server's invite code is
  // collected too. What is left of the endpoint in this flow is the RECOVER arm's
  // one write below, and only when nothing is configured: `personSetup` resolves the
  // endpoint before it can register anything, and a scanned code's issuer is a
  // channel the user already trusts.

  // Identity
  const [result, setResult] = useState<PersonSetupView | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Copy and Save on the phrase step (myne-md/myne#970 item 20). The step told
  // the user to write 24 words down and gave them no way to move the words off
  // the screen, which is the one thing the vault flow's kit screen does
  // (`CreateVaultFlow`) and the exact gap that pushes people to screenshot a
  // phrase, the thing `screen_guard` exists to prevent. Both outcomes are
  // reported INLINE rather than in a toast: this screen is shown once, and a
  // toast the user misses is indistinguishable from a copy that never happened.
  // ONE message for both actions, not one each. With two, the render had to
  // pick a winner (`copyMsg ?? fileMsg`), so once a copy had succeeded a later
  // save failure could never appear: the user read a stale "Copied" and the
  // phrase file was never written (myne-md/myne#972 review, D9). Last action
  // wins, which is what a one-line status under two buttons means.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // The clipboard gate, same probe and same default as the vault flow: the
  // control is ABSENT until the OS answers yes, because a button that appears
  // and then explains its own limits still implies a guarantee. iOS can hold a
  // secret to a standard Android has no equivalent of, so the honest answer
  // differs per device and only the device can give it.
  const [canCopyPhrase, setCanCopyPhrase] = useState(false);
  useEffect(() => {
    let live = true;
    void canHoldSecretOnClipboard().then(
      (ok) => {
        if (live) setCanCopyPhrase(ok);
      },
      () => {
        // Unknown resolves to NO: an unanswered question is not a yes.
      },
    );
    return () => {
      live = false;
    };
  }, []);
  /**
   * The sync server this device already names, read ONCE at mount.
   *
   * The ceremony's last step offers to register the identity it just made, and
   * registration needs an address (myne-md/myne#1029). Two rules decide the offer.
   * The address is a decision with a place, so it appears only when the device
   * already has one; a device with none keeps the identity home's own register
   * block, which is where the address is asked for. And the step NAMES the host,
   * because the ceremony sends the 24 words to a stored address rather than one
   * typed beside them: the desktop records that ordering as an owner decision
   * (2026-10-24, `PersonRegisterForm`), and a phrase that crosses IPC to an
   * endpoint the screen never shows would be the shape it warns about.
   *
   * One read, both fields: the register step seeds its own prefilled row from this
   * same value, so the two surfaces cannot disagree about which server is meant.
   * A failed read answers NO, because an unanswered question is not a yes.
   */
  const [server, setServer] = useState<{ url: string; code: string } | null>(null);
  useEffect(() => {
    if (!HAS_TAURI) return;
    let live = true;
    void syncGetEndpoint()
      .then((cfg) => {
        if (!live) return;
        setServer({ url: cfg.endpoint_url ?? "", code: cfg.invite_code ?? "" });
      })
      .catch(() => {
        /* unknown; the home's register block is the fallback either way */
      });
    return () => {
      live = false;
    };
  }, []);
  /** The server's host alone, for the copy. A full URL carries a path nobody needs. */
  const serverHost = (() => {
    const url = server?.url ?? "";
    if (url === "") return "";
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const serverConfigured = serverHost !== "";

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
  // The person account number, display form, for the home (myne-md/myne#911
  // review): derived from the phrase, so it needs no network and cannot be
  // lost, and it is the one value support or a server operator reads back.
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  /**
   * The identity's lifecycle state (myne-md/myne#911 task 12): `reserved` means
   * this identity was created with no server account, so the home offers the
   * explicit registration beside the create-vault action. `null` until the probe
   * answers, and the register block is simply absent until then.
   */
  const [accountState, setAccountState] = useState<PersonAccountState | null>(null);
  /**
   * Whether the sealed identity is open in RAM for this session
   * (`PersonStatusView.identity_unlocked`). It gates the create-vault action,
   * because that act signs the vault's first member list with the identity: a
   * sealed identity makes the command answer `PersonLocked`, and a button whose
   * only outcome is a refusal is a broken control, not an offer
   * (`decisions/ui/0729`).
   */
  const [identityUnlocked, setIdentityUnlocked] = useState(false);
  /** The unlock step's phrase cells, wiped when the step is left. */
  const [unlockWords, setUnlockWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));
  /** The registration step's phrase cells, wiped when the step is left. */
  const [registerWords, setRegisterWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));
  const unlockPhraseLabelId = useId();
  /**
   * The server this identity will be registered ON, and the admission code a
   * gated server asks for (2026-10-24, the desktop fix mirrored).
   *
   * The step asks for the address BEFORE the phrase, because registration is a
   * write against a NAMED server: which server is a decision with a place, and
   * the old order collected 24 words first and then, on `NotConfigured`, told the
   * user to go and set a server in Settings — a screen with no door at zero
   * vaults, which is exactly where this step lives. The invite code rides in the
   * same row for the same reason: a self-hoster who gates registration with
   * `MYNE_INVITE_CODE` had no way to enter one here at all.
   */
  const [registerServerUrl, setRegisterServerUrl] = useState("");
  const [registerInviteCode, setRegisterInviteCode] = useState("");
  /** What the device's config said when the step opened, so an unchanged address
   *  costs no second write (each one re-verifies TLS against the server). */
  const [registerConfigured, setRegisterConfigured] = useState<{
    url: string;
    code: string;
  } | null>(null);
  /** Whether the server step has read the device's config already: it reads once,
   *  so Back from the phrase step cannot overwrite what the user just typed. */
  const registerEndpointLoaded = useRef(false);
  /** The person join's phrase cells, and whether the claim still needs them. */
  const [personWords, setPersonWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));
  // The forget act's own two-step state: the acknowledgement is only on screen
  // once the user has asked to forget (myne-md/myne#932).
  const [forgetOpen, setForgetOpen] = useState(false);
  // The invite code a gated server asks for (myne-md/myne#932). Optional by
  // design: a server that does not gate new accounts never reads it, and an
  // existing account registers without one.
  const [personInvite, setPersonInvite] = useState("");
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState<string | null>(null);
  const [personClaimNeedsPhrase, setPersonClaimNeedsPhrase] = useState(false);
  /** The listing step's own failure, kept apart from `personError` because the
   *  phrase screen and the finishing screen are different screens: one is a
   *  refused credential, the other is an admitted device whose vault list did not
   *  arrive. */
  const [personListError, setPersonListError] = useState<string | null>(null);
  // What the account's vault listing answered on the home step (myne-md/myne#932).
  // `null` = nothing to report, `"failed"` = the call did not answer, `"empty"` =
  // the account is bound to no vault server-side, and a number = that many
  // bindings came back WITHOUT a local container (`PersonVaultRow.vault_id: null`:
  // an unreachable frame, or a generation this device cannot hold).
  //
  // Its own state rather than the flow's `error`, which is about the identity: a
  // listing that fell short leaves the identity fine and only the vaults short. A
  // triage rather than a list, because the vault surface is the picker. What this
  // step owes is the answer to "my account is right and my vaults are missing",
  // which silence used to give.
  const [vaultIssue, setVaultIssue] = useState<"failed" | "empty" | number | null>(null);
  // Is this the first-run door (the only caller that passes `onCreateVault`)? Read
  // through a ref by the listing effect below, for the reason given there.
  const createAction = useRef(onCreateVault !== undefined);
  createAction.current = onCreateVault !== undefined;
  // Forget-this-identity acknowledgement (myne-md/myne#782).
  const [forgetAck, setForgetAck] = useState(false);

  // Accept step (myne-md/myne#851 task 14). The invite is held rather than its
  // id, so the step cannot render for a row that has left the list.
  const [acceptInvite, setAcceptInvite] = useState<InviteSummary | null>(null);
  const [ownerCode, setOwnerCode] = useState("");
  const [acceptWords, setAcceptWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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

  // Recover step. The gate's third door: a phone that has never held the identity
  // brings it across with its 24-word phrase rather than minting a new person id.
  // Its own state, for the same reason the join's is its own: the three
  // credential-collecting steps are never open together, and sharing the fields
  // would make "this step never inherits another's phrase" a property of every
  // reset path instead of a property of the shape.
  const [recoverWords, setRecoverWords] = useState<string[]>(() => Array(PHRASE_WORDS).fill(""));

  // Name step (myne-md/myne#851 task 15). It runs after an accept lands and its
  // completion callback is withheld until it finishes, so an accepted vault cannot
  // reach the editor unnamed, the same ordering the desktop gate holds.
  const [nameDraft, setNameDraft] = useState("");
  const [nameChecking, setNameChecking] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Secret-wipe artefact for the three credential-collecting steps, recover,
  // accept and join. Mirrors the in-flight phrase, the owner code and the device
  // password so the unmount cleanup can drop them: V8 strings are immutable, so
  // this is best-effort on the JS side (the load-bearing zeroize is Rust-side),
  // but the reference goes on every exit. Same mechanism as `RecoverFlow`, which
  // holds the same two kinds of secret; the phrase is a full identity credential
  // and the password becomes this device's `vault.member-unlock` credential. One
  // artefact for all three steps rather than one each: the unmount cleanup is the
  // half that cannot be forgotten per-path, and a second object here would be a
  // second thing to remember to wipe.
  const acceptSecretsRef = useRef<{
    ownerCode: string;
    words: string[];
    password: string;
    confirmPassword: string;
    joinWords: string[];
    joinPassword: string;
    joinConfirmPassword: string;
    recoverWords: string[];
    registerWords: string[];
  }>({
    ownerCode: "",
    words: [],
    password: "",
    confirmPassword: "",
    joinWords: [],
    joinPassword: "",
    joinConfirmPassword: "",
    recoverWords: [],
    registerWords: [],
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
      recoverWords: [],
      registerWords: [],
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
      recoverWords,
      registerWords,
    };
  });
  useEffect(() => () => wipeSecrets(), [wipeSecrets]);


  // Gate on boot: if an identity already exists, skip straight to the home.
  useEffect(() => {
    // The person join comes FIRST, before any status probe (myne-md/myne#911 task
    // 12): a device that scanned an owner's code has no identity yet, and the
    // phrase it is about to type is what creates one. Probing first would send it
    // to the gate and offer to mint a SECOND person id, which is the opposite of
    // joining the account whose code it just scanned.
    if (fromPersonQr) {
      setStep("person-phrase");
      return;
    }
    if (!HAS_TAURI) {
      setStep(unaskedStep);
      return;
    }
    let cancelled = false;
    void personStatus()
      .then((s) => {
        if (cancelled) return;
        // `state` is the authoritative three-way answer (myne-md/myne#911 task
        // 4), and a `reserved` identity IS an identity: it was created offline,
        // it is sealed on disk, and its phrase is the only copy. Landing it on
        // the gate offered to create a second one, and landing it on `held`
        // offered to forget the one it has (myne-md/myne#780's surface is for a
        // sealed frame this device CANNOT open, which `state === null` with a
        // seal present is and `reserved` is not).
        if (s.state != null) {
          setIdentityCode(s.identity_code);
          setAccountState(s.state);
          setIdentityUnlocked(s.identity_unlocked);
          // A mount the editor opened as the REPAIR door lands on the phrase grid
          // (myne-md/myne#1029), and it does so whether or not a session is
          // already live. The open-session case is not hypothetical: the row's
          // other label is `repair_device`, whose cause is a binding row that
          // publishes a key the store cannot produce, and a live session says
          // nothing about that key. The claim runs inside `sync_person_unlock`,
          // so the phrase entry IS the repair in both states, and landing on the
          // home would offer a screen with no control that mints anything.
          setStep(repairDoor ? "unlock-identity" : "home");
          // Read separately and tolerated: a device with no number to show still
          // has a working home, and the number is derived rather than stored.
          void personAccountNumber()
            .then((n) => {
              if (!cancelled) setAccountNumber(n);
            })
            .catch(() => {});
        } else if (s.sealed_keypair_present) {
          // A sealed identity this device cannot open with a fresh phrase
          // (myne-md/myne#780): offer to forget it rather than loop through a
          // create that is guaranteed to fail.
          setStep("held");
        } else {
          // No identity on this device: leave the door the CALLER opened
          // (myne-md/myne#932). The first-run screen has two of them, and the
          // probe used to overwrite the fork with the gate, so "I already have an
          // identity" landed on a screen offering to create one.
          setStep(initialStep ?? "gate");
        }
      })
      .catch(() => {
        if (!cancelled) setStep(unaskedStep);
      });
    return () => {
      cancelled = true;
    };
  }, [initialStep, repairDoor, unaskedStep]);

  // Load invites whenever the home step is shown, and refresh the lifecycle
  // state with them: registration happens on another step and must remove its own
  // block from this one (myne-md/myne#911 task 12), which is what re-reading
  // `state` here does rather than the register step trying to unset it.
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
    void personStatus()
      .then((s) => {
        if (cancelled) return;
        setAccountState(s.state);
        setIdentityUnlocked(s.identity_unlocked);
        // The account's vaults, written locally as frames (myne-md/myne#932).
        // Listing them HERE as well as after a register is what makes the home
        // step self-sufficient: a device that reached it by any other road (a
        // re-opened app, a reclaimed identity, frames cleared by a reinstall)
        // would otherwise show a picker with only "create a vault" while its
        // account owned one. Only for an ENROLLED identity: a reserved one has no
        // account to ask, and the command would refuse.
        if (s.state !== "enrolled") return;
        void personListVaults()
          .then((rows) => {
            if (cancelled) return;
            const missing = rows.filter((row) => row.vault_id === null).length;
            // An account bound to nothing is a fact about the SERVER's index, not
            // about this device, and it is the difference between "the vault is not
            // published yet" (act on the device that holds it) and "the frame did
            // not arrive" (retry here). Reporting neither is what a phone showed
            // while its owner looked at a correct account number and no vaults.
            //
            // Except on the first-run door, which passes `onCreateVault`: an account
            // with no vaults is exactly the state that door exists to leave, and its
            // action is already on the screen, so a warning there is noise about
            // nothing being wrong. Read through a ref, because the prop is an inline
            // arrow in the shell and naming it in the dependency list would re-run
            // this fetch on every parent render.
            const firstRun = createAction.current;
            setVaultIssue(
              missing > 0
                ? missing
                : rows.length === 0 && !firstRun
                  ? "empty"
                  : null,
            );
          })
          .catch(() => {
            // A listing failure is not a wrong phrase and not a lost vault: the
            // frames simply did not arrive, and the retry is reopening this step.
            // Said rather than swallowed, because the alternative is a picker that
            // looks merely empty (myne-md/myne#932 review).
            if (!cancelled) setVaultIssue("failed");
          });
      })
      .catch(() => {
        /* keep the last-known state */
      });
    return () => {
      cancelled = true;
    };
  }, [step, t]);

  // The register step's server row, read when the step opens (2026-10-24): the
  // address this identity would be registered against today, prefilled so the
  // screen shows the truth instead of an empty box the user has to guess at. A
  // failed read is not fatal: both fields stay empty and the address is required
  // before submit, which is the honest fallback rather than a hidden field.
  useEffect(() => {
    // Loaded ONCE: going Back to the server step must not re-read the device's
    // config over what the user has just typed.
    if (step !== "register" || registerEndpointLoaded.current || !HAS_TAURI) return;
    registerEndpointLoaded.current = true;
    // The mount's read is the same command, taken once. Seeding from it keeps one
    // answer for one question instead of two reads that can disagree, and it is
    // what lets the type-back step name the host it is about to send the words to.
    if (server !== null) {
      setRegisterServerUrl(server.url);
      setRegisterInviteCode(server.code);
      setRegisterConfigured({ url: server.url, code: server.code });
      return;
    }
    let cancelled = false;
    void syncGetEndpoint()
      .then((cfg) => {
        if (cancelled) return;
        const url = cfg.endpoint_url ?? "";
        const code = cfg.invite_code ?? "";
        setRegisterServerUrl(url);
        setRegisterInviteCode(code);
        setRegisterConfigured({ url, code });
      })
      .catch(() => {
        /* unknown; the address field is the answer either way */
      });
    return () => {
      cancelled = true;
    };
  }, [step, server]);

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
      // No server step to send the user back to any more (myne-md/myne#911 task
      // 12): creating an identity is network-free, so a failure here is a real
      // one (a held identity this device cannot open, a full disk) and the honest
      // place for it is the screen that asked.
      setError(t("identityFlow.createFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  /**
   * Register this identity with the server, using the phrase as proof of
   * possession (myne-md/myne#911 task 12; server row first since 2026-10-24).
   *
   * The address is settled and WRITTEN before any secret crosses IPC, so a
   * mistyped address costs a URL rather than a phrase, and its failure is its own
   * arm that keeps the words. A failure leaves the identity exactly where it was
   * (`reserved`, sealed, and usable), which is what makes registration safe to
   * attempt: nothing about the local identity depends on the server answering.
   */
  /**
   * Unlock the sealed identity for this session (2026-10-25, desktop parity).
   *
   * The command opens the phrase-sealed keypair and installs the in-RAM session
   * the roster, invite and create acts sign with. A refusal is the PHRASE's, not
   * the account's, so the words are wiped and the user retypes them: nothing
   * mounted may keep a credential that was just rejected.
   */
  const unlockIdentity = useCallback(async () => {
    const phrase = unlockWords.join(" ");
    if (!unlockWords.every((word) => word.length > 0)) return;
    setBusy(true);
    setError(null);
    try {
      const view = await personUnlock(phrase);
      setIdentityCode(view.identity_code);
      // The flag flips HERE as well as on the status probe, and both are needed.
      // The probe is the authority on entry to the home; the immediate flip is what
      // stops the door from reappearing for the round trip between the unlock
      // returning and the home's effect re-reading the device. Without it the user
      // unlocked, landed on the home, and was offered the same door again.
      setIdentityUnlocked(true);
      setUnlockWords(Array(PHRASE_WORDS).fill(""));
      // `sync_person_unlock` also mints this device's signing key and writes its
      // binding row, which is what makes the sync cycle able to author a head
      // (myne-md/myne#1029). A mount opened for that repair therefore hands control
      // back rather than landing on the home: the caller closes the overlay and the
      // row that asked re-reads its own status.
      if (onUnlockedRef.current !== undefined) {
        onUnlockedRef.current();
      } else {
        setStep("home");
      }
    } catch {
      setUnlockWords(Array(PHRASE_WORDS).fill(""));
      setError(t("identityFlow.unlock.failed"));
    } finally {
      setBusy(false);
    }
  }, [unlockWords, t]);

  /**
   * Register this identity with the phrase it was given.
   *
   * Takes the phrase rather than reading `registerWords`, because there are two
   * callers with two sources: the register step's grid (the user retyped the
   * words), and the creation ceremony's own type-back step, which still HOLDS them
   * and must not ask for them again (myne-md/myne#1029). Passing the value keeps
   * the secret inside the ceremony: the alternative, seeding the register grid from
   * the ceremony, kept the 24-word phrase in component state across a whole visit to
   * the identity home, which is a custody change no screen needed.
   */
  const registerPhrase = useCallback(async (phrase: string) => {
    if (phrase.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const view = await personRegister(phrase);
      setIdentityCode(view.identity_code);
      setRegisterWords(Array(PHRASE_WORDS).fill(""));
      // The ceremony's copy of the phrase dies here, whatever step it came from
      // (myne-md/myne#1029 review). The registering exit runs from the type-back
      // step, which is the one mount that still HOLDS the words, and leaving
      // `result` set would keep the created identity's only credential in state
      // for the rest of the visit to the home, the invite list and the accept
      // step. `finishPhrase` does the same reset on the other exit; this covers
      // the path that registers instead of finishing.
      setResult(null);
      setRevealed(false);
      setChallenge([]);
      setAnswers(["", "", "", ""]);
      // The account's vaults, written locally as frames (myne-md/myne#932).
      // Nothing else on this path lists them, so a device that registered here
      // showed a picker with only "create a vault" while its account owned one.
      // Tolerated rather than fatal: the registration SUCCEEDED, and a listing
      // failure is a fetch to retry, not a reason to tell the user their phrase
      // did not work.
      await personListVaults().catch(() => {
        // The registration succeeded, so this is not a phrase failure; the vaults
        // are the part that did not arrive. The home step's own listing retries,
        // and its banner is what would say so, so nothing is claimed here beyond
        // leaving the enrolment intact.
      });
      // Re-probe rather than assume: the lifecycle state is DERIVED from disk
      // (myne-md/myne#911 task 4), and the home step's own effect reads it on
      // entry. Setting it from this call's answer would be a second opinion about
      // a fact the probe already owns.
      setStep("home");
    } catch (e) {
      const kind = (e as { kind?: string } | null)?.kind;
      // `NotConfigured` names a MISSING SERVER, so the fix is on the step before
      // this one and the dialog goes back there with the words kept: they were
      // never the problem. Everything else is a refusal of the phrase, which does
      // not survive it (the user retypes it, and nothing mounted keeps holding a
      // credential that was just rejected).
      if (kind === "NotConfigured") {
        setError(t("identityHome.registerServerError"));
        // The words ARE still here, and the copy says so ("Your words are still
        // here"), so the step this lands on must show them: a ceremony that
        // reached this arm holds the phrase in `result`, and the grid is empty
        // otherwise. That is the one place a seed is safe (myne-md/myne#1029
        // review): we are inside the mount that displayed it, seconds ago.
        const created = (result?.phrase ?? "").split(" ").filter((w) => w.length > 0);
        if (created.length === PHRASE_WORDS) setRegisterWords(created);
        setStep("register");
        return;
      }
      setRegisterWords(Array(PHRASE_WORDS).fill(""));
      setError(t("identityFlow.register.failed"));
    } finally {
      setBusy(false);
    }
  }, [t, result]);

  const registerIdentity = useCallback(() => {
    if (!registerWords.every((word) => word.length > 0)) return;
    return registerPhrase(registerWords.join(" "));
  }, [registerWords, registerPhrase]);

  /**
   * The register act's FIRST half: settle the server, then move on (2026-10-24).
   *
   * The address is written HERE rather than on the final press, so a mistyped URL
   * costs a URL and is refused before any secret is typed. Its failure keeps the
   * user on this step, which is where the fix is.
   */
  const continueRegisterServer = useCallback(async () => {
    const url = registerServerUrl.trim();
    const code = registerInviteCode.trim();
    if (url === "") return;
    setError(null);
    const changed =
      registerConfigured === null ||
      registerConfigured.url !== url ||
      registerConfigured.code !== code;
    if (!changed) {
      setStep("register-phrase");
      return;
    }
    setBusy(true);
    try {
      // `undefined` (not `""`) when the field is empty, because the backend reads
      // `null` as "preserve the stored code" and `""` as an explicit CLEAR; this
      // step must never erase the only copy of a server's admission word.
      await syncSetEndpoint(url, code === "" ? undefined : code);
      setRegisterConfigured({ url, code });
      setStep("register-phrase");
    } catch {
      setError(t("identityHome.registerServerError"));
    } finally {
      setBusy(false);
    }
  }, [registerServerUrl, registerInviteCode, registerConfigured, t]);

  const finishPhrase = useCallback(() => {
    setResult(null);
    setRevealed(false);
    setChallenge([]);
    setAnswers(["", "", "", ""]);
    setStep("home");
  }, []);

  /**
   * Finish the ceremony by REGISTERING the identity it just created.
   *
   * The register act was a second screen asking for the same 24 words the ceremony
   * had already displayed and asked four back of (myne-md/myne#1029). It is also the
   * act that mints the device id a binding row needs, so the friction sat on the one
   * path that makes phrase-free sync possible. Registering from the type-back step
   * costs no secret lifetime at all: the phrase is the one this screen is holding,
   * and it is dropped here rather than carried to the home.
   *
   * Deliberately available only when a server is already configured, because
   * registration names a server: `registerServerUrl` is the address the user chose,
   * and a device with none keeps the home's own register block, which is where the
   * address is asked for.
   */
  const finishPhraseRegistering = useCallback(() => {
    const phrase = result?.phrase ?? "";
    if (phrase.trim() === "") {
      // A primary control that reports success while doing the OPTIONAL action is
      // the one shape this file refuses elsewhere: sync stays as blocked as before
      // and the user believes the device registered.
      setError(t("identityFlow.register.failed"));
      return;
    }
    void registerPhrase(phrase);
  }, [result, registerPhrase, t]);

  // ── The person join (myne-md/myne#911 tasks 9 and 12) ──────────────────────

  /**
   * The join's last step: materialise the account's vaults locally, then leave.
   *
   * `personListVaults` is what writes each vault's frame on this device, so it is
   * the difference between the picker showing the account's vaults and showing
   * none. Its failure is NOT a join failure (the device is admitted), so the flow
   * does not treat it as one, and it does not swallow it either: it stays on its
   * own step and says so, with a Retry that runs the same call again. Nothing
   * else re-runs it, which is what the deleted comment here claimed: `onAccepted`
   * closes the overlay and the probe that follows reads only what is already on
   * disk (myne-md/myne#911 review).
   */
  const finishPersonJoin = useCallback(() => {
    setStep("person-finishing");
    setPersonListError(null);
    void personListVaults()
      .then((rows) => {
        // The listing's own answer decides the landing, and until this read it had
        // none: the rows were dropped and `onAccepted()` was called with nothing,
        // so the shell re-probed and a joined vault landed on its unlock form with
        // the §6.3 compare it owed unreachable, and the approving device then
        // waited on a code this device was never going to show (myne#957 follow-up).
        const here = rows.flatMap((row) => (row.vault_id === null ? [] : [row.vault_id]));
        if (rows.length === 0) {
          // The account is bound to nothing on the server, so there is nothing to
          // bring across and the remedy is on another device: publish from the one
          // that holds the vault.
          setPersonListError(t("identityFlow.personJoin.vaultsNoneOnServer"));
          return;
        }
        if (here.length === 0) {
          // Bound to something, and not one frame landed here. "No vaults" would be
          // a claim about the account; the truth is that this device could not hold
          // what the server sent, and the retry is the one control this step has.
          setPersonListError(t("identityFlow.personJoin.noVaults"));
          return;
        }
        onAccepted({ vaultIds: here, holding: "locked" });
      })
      .catch(() => setPersonListError(t("identityFlow.personJoin.listFailed")));
  }, [onAccepted, t]);

  /**
   * Type the identity phrase and ask to be admitted.
   *
   * The device lands PENDING rather than approved: an existing device has to
   * approve it, which is what stops a stolen phrase from attaching a device on its
   * own (story 16). The backend caches the DERIVED secret for the pending window,
   * never the phrase, so the poll below can finish without a second entry.
   */
  const submitPersonPhrase = useCallback(async () => {
    if (!fromPersonQr || !personWords.every((word) => word.length > 0) || personBusy) return;
    const phrase = personWords.join(" ");
    setPersonWords(Array(PHRASE_WORDS).fill(""));
    setPersonBusy(true);
    setPersonError(null);
    setPersonClaimNeedsPhrase(false);
    try {
      const view = await personJoinDevice(
        fromPersonQr.personIdHex,
        fromPersonQr.endpointUrl,
        phrase,
        personInvite,
      );
      if (view.approved) {
        finishPersonJoin();
        return;
      }
      setStep("person-pending");
    } catch (e) {
      // One mapper for every arm, in `@myne/client-core` (myne-md/myne#932). This
      // used to answer two kinds and collapse the rest into "check the words",
      // which blamed a correct phrase for a server refusal: an invite-code gate, a
      // device cap and an unapproved device all read as "your words are wrong".
      setPersonError(t(personJoinErrorKey(e)));
    } finally {
      setPersonBusy(false);
    }
  }, [fromPersonQr, personWords, personInvite, personBusy, finishPersonJoin, t]);

  // While the device waits, ask the server whether the approval has landed. The
  // poll re-runs the SAME handshake with the session's cached secret, which is why
  // it can finish without the phrase; a session that ended in between answers
  // `PersonSessionRequired`, and the screen asks for the phrase again rather than
  // polling a credential it no longer has.
  useEffect(() => {
    if (step !== "person-pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void personClaimDevice()
        .then((view) => {
          if (cancelled) return;
          if (view.approved) {
            finishPersonJoin();
            return;
          }
          timer = setTimeout(tick, 2000);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if ((e as { kind?: string } | null)?.kind === "PersonSessionRequired") {
            setPersonClaimNeedsPhrase(true);
            return; // stop polling: only the phrase can restart the handshake
          }
          timer = setTimeout(tick, 2000);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [step, finishPersonJoin]);

  // ── Accept step (myne-md/myne#851 task 14) ──────────────────────────────────

  /** Drop the accept step's secrets from both the state and the wipe ref. Called
   *  on every exit that keeps this flow mounted (back to the home, accepted):
   *  the unmount cleanup covers the rest, since closing the overlay unmounts the
   *  whole flow. */
  const clearAcceptSecrets = useCallback(() => {
    wipeSecrets();
    setOwnerCode("");
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

  /**
   * Open the join wizard for a vault named by a scanned member-vault QR.
   *
   * One door, the code decides: the join overlay scans the QR and, for a
   * `member_vault` code, closes and re-enters the identity flow with the target in
   * `fromQr` (AppShell). Once this flow reaches the home step and its invites have
   * loaded, the invite whose vault is the one the code named is opened here, so the
   * user lands directly in the join wizard rather than on a list to hunt through.
   *
   * ONCE, through a ref, for the reason the name gate's latch exists: the effect's
   * dependencies move on every parent render, and a second open would yank the user
   * back to step 1 of a wizard they had moved past — or reopen it after they
   * cancelled out. The latch goes DOWN before the match is tested, so the not-found
   * arm is stated once and never re-run. That arm sets the shared `error` (rendered
   * on the home step) rather than opening nothing in silence: a code that names a
   * vault this identity has no invitation for is a dead end the user has to be told
   * about, and the alternative is a screen that looks like the tap did nothing.
   */
  const qrJoinOpened = useRef(false);
  useEffect(() => {
    if (qrJoinOpened.current || !fromQr || step !== "home" || invites === null) return;
    qrJoinOpened.current = true;
    // Case-insensitively, for the reason the desktop producer canonicalises the
    // same field: `vault_account_hash_hex` arrives from the server verbatim
    // (stored by `materialize_member_vault` from the claim reply), while the codec
    // hands this one over in lowercase, so an uppercase reply would read as "this
    // device has no invitation for that vault" on a vault it can actually join.
    const wanted = fromQr.accountHashHex.toLowerCase();
    const match = invites.find(
      (inv) => inv.vault_account_hash_hex.toLowerCase() === wanted,
    );
    if (match) openJoin(match);
    else setError(t("identityFlow.joinFromQr.notFound"));
  }, [fromQr, step, invites, openJoin, t]);

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

  // ── Recover step (the gate's third door) ────────────────────────────────────

  /** Drop the recover step's words from the state, and the banner with them: a
   *  refusal about a step the user has left is stale the moment they leave it.
   *  The phrase itself is the only secret this step collects, and it is a full
   *  identity credential, so this runs on every exit that keeps the flow mounted
   *  (the home step on success, the gate on back); the unmount cleanup covers the
   *  rest. */
  const clearRecoverSecrets = useCallback(() => {
    setRecoverWords(Array(PHRASE_WORDS).fill(""));
    setError(null);
  }, []);

  /** Open the recover step from the gate. Everything the step collects is RESET
   *  here rather than on the way out, so a second attempt can never inherit the
   *  first one's words — the same ordering `openAccept` and `openJoin` keep. */
  const openRecover = useCallback(() => {
    clearRecoverSecrets();
    setStep("recover");
  }, [clearRecoverSecrets]);

  /** Leave the recover step for the gate, dropping what it collected. */
  const leaveRecover = useCallback(() => {
    clearRecoverSecrets();
    setStep("gate");
  }, [clearRecoverSecrets]);



  // Every gate in one place, so the submit button and the handler cannot
  // disagree about whether the form is complete. The backend re-checks the floor
  // and the phrase; this is the affordance, not the gate.
  //
  // Split per step (myne-md/myne#871): each step's Continue is gated on what
  // THAT step collects, and the final `acceptReady` stays the submit gate so
  // the full check is what guards the call.
  const acceptOwnerReady = ownerCode.trim() !== "";
  const acceptPhraseReady = acceptWords.every((word) => word.length > 0);
  const acceptReady =
    acceptOwnerReady &&
    acceptPhraseReady &&
    passwordLength(password) >= MIN_PASSWORD_LEN &&
    password === confirmPassword;

  /** The join's gate: the same phrase completeness and the same device-password
   *  floor, and deliberately NO confirmation step. There is no owner code on this
   *  form to confirm, because there is none to collect. */
  const joinPhraseReady = joinWords.every((word) => word.length > 0);
  const joinReady =
    joinPhraseReady &&
    passwordLength(joinPassword) >= MIN_PASSWORD_LEN &&
    joinPassword === joinConfirmPassword;

  /** The recover step's gate, and it is the phrase alone: there is no second
   *  credential to collect and nothing to confirm. A recovered identity has no
   *  phrase to show (the backend returns one only when it GENERATED it), so the
   *  ceremony here is the 24 words themselves — typing them is the demonstration
   *  the desktop arm treats them as. */
  const recoverReady = recoverWords.every((word) => word.length > 0);

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
      const view = await personAcceptInvite(
        acceptInvite.invite_id_hex,
        ownerCode.trim(),
        acceptWords.join(" "),
        password,
      );
      joined.current = { vaultIds: [view.vault_id], holding: "unlocked" };
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
      const view = await personJoinVault(
        joinInvite.invite_id_hex,
        joinInvite.vault_account_hash_hex,
        joinWords.join(" "),
        joinPassword,
      );
      joined.current = { vaultIds: [view.vault_id], holding: "unlocked" };
      setJoinInvite(null);
      clearJoinSecrets();
      accepted.current(joined.current);
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

  /**
   * Recover an existing identity from its 24-word phrase, and install it on this
   * device.
   *
   * The gate had exactly one way forward before this: `createIdentity`, which
   * calls `personSetup()` with NO phrase and therefore MINTS a new person id. The
   * binding has had the other arm from the day it landed — `personSetup(phrase)`
   * recovers an existing identity — and the desktop dialog has the door
   * (`IdentitySetupDialog`'s `recoverOpen` grid). Only this gate was missing it,
   * and the cost is exactly the case the mobile flow exists for: a scanned
   * member-vault QR hands the target to this flow (`fromQr`, AppShell) and the
   * join wizard's own steps tell the user to bring their identity across with its
   * phrase, so on a phone that had never held the identity the only available
   * person id was a brand-new one with no invitations, and the effect below fell
   * through to `joinFromQr.notFound`. A dead end in the case the feature is for.
   *
   * On success the step is DONE: a recovered identity comes back from the backend
   * with no phrase (`PersonSetupView.phrase` is non-null only when the call
   * generated one), so there is nothing to reveal, nothing to type back and no
   * ceremony to run. It lands on the home step, which is where the QR effect above
   * takes over once the recovered identity's invites have loaded.
   *
   * The failure copy is ONE sentence for every refusal this path can raise, and
   * that is a decision rather than an omission. On a recover the backend folds a
   * wrong phrase and a sealed identity this device cannot open into the SAME kind
   * (`core/src/plugins/sync/person_account.rs` maps `CannotDecrypt` to
   * `AlreadyHeldIdentity` only when the call GENERATED the phrase; with a phrase
   * supplied it is `BadRequest`), so the device genuinely cannot tell the two
   * apart and copy that picked one would be inventing a distinction it does not
   * have. Nothing about the words reaches the banner, and nothing here is logged:
   * the phrase is a full identity credential and it goes straight into the call.
   */
  const recoverIdentity = useCallback(async () => {
    if (!recoverReady) return;
    setBusy(true);
    setError(null);
    try {
      // A device reaching this step has no identity, and the common way it got
      // here is a scanned member-vault code (`fromQr`), which means it very
      // probably has no sync endpoint either — and `personSetup` resolves the
      // endpoint BEFORE it can register anything, so without one it fails
      // `NotConfigured` and the user reads a failure on a phrase that was correct.
      //
      // `syncSetEndpoint` is the same call the server step makes, and it verifies
      // TLS (hostname + public CA) before it writes, so this is not a new trust
      // decision: the endpoint came from a QR the user scanned off the screen of a
      // device they already trust, which is the channel `decisions/protocol/0338`
      // established for exactly this. It writes ONLY when nothing is configured, so
      // a configured endpoint is never silently repointed (a different, deliberate
      // act, and the server step is where it belongs).
      if (fromQr?.endpointUrl && !(await syncGetEndpoint().then((c) => c.endpoint_url))) {
        await syncSetEndpoint(fromQr.endpointUrl, "");
      }
      const view = await personSetup(recoverWords.join(" "));
      // Dropped BEFORE the step changes, so the words do not survive onto a step
      // that has no use for them.
      clearRecoverSecrets();
      setIdentityCode(view.identity_code);
      setStep("home");
    } catch {
      setError(t("identityFlow.recover.failed"));
    } finally {
      setBusy(false);
    }
  }, [recoverReady, recoverWords, clearRecoverSecrets, t, fromQr]);

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
  /**
   * The vaults this flow put on this device, handed to `onAccepted` so the shell
   * can address the approval wait.
   *
   * A ref rather than a state because the accept lands on the NAME step and the
   * callback runs from there: the landing has to survive that hop without a
   * re-render depending on it. `undefined` until a vault actually lands, which is
   * what keeps the shell's other `onAccepted` callers (a plain re-probe) unchanged.
   */
  const joined = useRef<JoinLanding | undefined>(undefined);
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
      if (named) accepted.current(joined.current);
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
      accepted.current(joined.current);
    } catch (e) {
      // Which refusal it was: `NameTooLong`, `StoreUnreadable` and `SlotNotUnlocked`
      // are three different remedies, and the mapping is shared with the desktop
      // writer so neither client can drop an arm (`@myne/client-core/member-name`).
      setNameError(t(memberNameErrorKey(e)));
    } finally {
      setNameBusy(false);
    }
  }, [nameDraft, nameBusy, t]);

  const renderHeld = () => (
    <Screen>
      <FlowHeader onBack={onCancel} />
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
        {/* `forget` deletes the sealed frame and every vault-bound carrier, and it
            is one tap with no confirmation. That is a fair weight on the first-run
            door, which is where this screen has always been. It is NOT fair on a
            repair-door mount reached from a Settings row about sync, so the door
            offers the exit alone and the destructive verb stays where it was
            (myne-md/myne#1029 review). */}
        {repairDoor ? null : (
          <Button variant="danger" onClick={() => void forgetHeld()} disabled={busy} data-testid="identity-flow.held-forget">
            {t("identityFlow.held.forget")}
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.held-cancel">
          {t("common.back")}
        </Button>
      </FooterBar>
    </Screen>
  );

  /**
   * The "I already have an identity" fork (myne-md/myne#932): the two credentials
   * a device can bring an existing identity with, side by side the way the
   * desktop's identity setup offers create beside recover.
   *
   * Both arms end somewhere this flow already knows: the 24 words go to the
   * recover step, and a code hands control back to the shell's scanner, which
   * opens the person-join step with the scanned target.
   */
  const renderJoinFork = () => (
    <Screen>
      <FlowHeader onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("common.youridentity")}</Title>
        <Lead>{t("identityFlow.fork.lead")}</Lead>
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        {/* The desktop's own vocabulary (`identitySetup.*`), reused rather than
            re-coined: the same two credentials are offered there, and one name per
            thing is the rule that keeps the two clients reading alike. */}
        <Button onClick={openRecover} data-testid="identity-flow.fork-words">
          {t("identitySetup.recoverAction")}
        </Button>
        <div data-testid="identity-flow.fork-words-body" style={HINT_STYLE}>
          {t("identitySetup.recoverHint")}
        </div>
        {onScanCode ? (
          <>
            <Button
              variant="secondary"
              onClick={onScanCode}
              data-testid="identity-flow.fork-code"
            >
              {t("identityFlow.fork.code")}
            </Button>
            <div data-testid="identity-flow.fork-code-body" style={HINT_STYLE}>
              {t("identityFlow.fork.codeBody")}
            </div>
          </>
        ) : null}
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.fork-skip">
          {t("identityFlow.skip")}
        </Button>
      </FooterBar>
    </Screen>
  );

  const renderGate = () => (
    <Screen>
      <FlowHeader onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("common.createanidentity")}</Title>
        <Lead>{t("identityFlow.lead")}</Lead>
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        {/* Straight to the create step, with no server step in front of it
            (myne-md/myne#911 task 12). Creating an identity is network-free, so a
            phone with no server configured still ends up with a working one; the
            server step used to gate this door and made an offline first run
            impossible on this client. The endpoint is configured from Settings
            when the user wants sync, and registration is the explicit act on the
            identity home. */}
        <Button onClick={() => setStep("create")} data-testid="identity-flow.start">
          {t("common.createanidentity")}
        </Button>
        {/* The third door, between the two that were already here. A device that
            has never held this identity can bring an EXISTING one across with its
            24-word phrase; without it the gate could only mint a new person id,
            which is what made the scanned-QR path a dead end (see
            `recoverIdentity`). */}
        <Button variant="secondary" onClick={openRecover} data-testid="identity-flow.recover-open">
          {t("identityFlow.recover.open")}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.skip">
          {t("identityFlow.skip")}
        </Button>
      </FooterBar>
    </Screen>
  );

  const renderCreate = () => (
    <Screen>
      <FlowHeader onBack={() => setStep("gate")} />
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
        <Button variant="secondary" full={false} onClick={() => setStep("gate")}>
          {t("common.back")}
        </Button>
        <Button onClick={() => void createIdentity()} disabled={busy} data-testid="identity-flow.create">
          {busy ? t("identityFlow.create.working") : t("identityFlow.create.cta")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.create.working")} />}
    </Screen>
  );

  /**
   * The explicit registration (myne-md/myne#911 task 12), in TWO steps since
   * 2026-10-24.
   *
   * The server is a decision and the phrase is a secret, so they do not share a
   * view: asking on one screen made the user read two unrelated things before
   * understanding either, and it is the same split the desktop dialog took. The
   * old shape went further wrong than a long screen: it collected 24 words, failed
   * `NotConfigured`, and told the user to set a server "in Settings" — a screen
   * with no door before the first vault exists.
   */
  const renderRegisterServer = () => (
    <Screen>
      <FlowHeader onBack={() => setStep("home")} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("common.registerthisidentity")}</Title>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel>{t("identityHome.registerServerLabel")}</FieldLabel>
          <TextField
            value={registerServerUrl}
            onChange={(value) => {
              setError(null);
              setRegisterServerUrl(value);
            }}
            testId="identity-flow.register-server"
            label={t("identityHome.registerServerLabel")}
            disabled={busy}
          />
          <div data-testid="identity-flow.register-server-hint" style={HINT_STYLE}>
            {t("identityHome.registerServerHint")}
          </div>
          <div style={{ marginTop: "var(--space-3)" }}>
            <FieldLabel>{t("identityHome.registerInviteCodeLabel")}</FieldLabel>
            <TextField
              value={registerInviteCode}
              onChange={(value) => {
                setError(null);
                setRegisterInviteCode(value);
              }}
              testId="identity-flow.register-invite-code"
              label={t("identityHome.registerInviteCodeLabel")}
              disabled={busy}
            />
            <div style={HINT_STYLE}>{t("identityHome.registerInviteCodeHint")}</div>
          </div>
        </div>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button
          variant="secondary"
          full={false}
          onClick={() => {
            // Leaving the flow drops whatever phrase a previous attempt left in
            // the grid: it is the account's only credential, and every other grid
            // on this screen drops its own on the way out for the same reason.
            setRegisterWords(Array(PHRASE_WORDS).fill(""));
            setError(null);
            setStep("home");
          }}
        >
          {t("common.back")}
        </Button>
        <Button
          onClick={() => void continueRegisterServer()}
          disabled={busy || registerServerUrl.trim() === ""}
          data-testid="identity-flow.register-continue"
        >
          {t("common.continue")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.register.working")} />}
    </Screen>
  );

  const renderRegisterPhrase = () => (
    <Screen>
      <FlowHeader
        onBack={() => {
          setError(null);
          setStep("register");
        }}
      />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("common.registerthisidentity")}</Title>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel id={registerPhraseLabelId}>
            {t("identityHome.registerPhraseLabel")}
          </FieldLabel>
        </div>
        <PhraseEntryGrid
            cells={registerWords}
            onCells={(next) => {
              setError(null);
              setRegisterWords(next.map((w) => w.replace(/\s+/g, "")));
            }}
            layout="field"
            testIdPrefix="identity-flow.register"
            cellTestId={(i) =>
              i === 0 ? "identity-flow.register-cell" : `identity-flow.register-cell-${i + 1}`
            }
            cellLabel={(i) => t("sync.enroll.wordAria", { number: i + 1 })}
            labelledBy={registerPhraseLabelId}
            style={PHRASE_GRID_STYLE}
          />
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button
          variant="secondary"
          full={false}
          onClick={() => {
            // Back to the server step keeps the words: the address is what the
            // user came back to change.
            setError(null);
            setStep("register");
          }}
        >
          {t("common.back")}
        </Button>
        <Button
          onClick={() => void registerIdentity()}
          disabled={busy || !registerWords.every((word) => word.length > 0)}
          data-testid="identity-flow.register-submit"
        >
          {busy ? t("identityFlow.register.working") : t("identityFlow.register.cta")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.register.working")} />}
    </Screen>
  );

  /**
   * The person join's credential step (myne-md/myne#911 task 12).
   *
   * The code already named the person and the server; the phrase is the proof
   * that this device is that person's, and typing it is also what seals the
   * identity locally. Nothing about the words reaches a log.
   */
  const renderPersonPhrase = () => (
    <Screen>
      <FlowHeader onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.personJoin.title")}</Title>
        <Lead>{t("identityFlow.personJoin.lead")}</Lead>
        {personClaimNeedsPhrase ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {t("identityFlow.personJoin.sessionEnded")}
          </Banner>
        ) : null}
        {/* A server that gates NEW accounts needs its code here, and this screen
            is the only enrolment surface a phone has (myne-md/myne#932). Above the
            grid rather than below it: it arrives from the same place the phrase
            does, and a field under 24 cells reads as an afterthought. */}
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel>{t("identityFlow.personJoin.inviteLabel")}</FieldLabel>
        </div>
        <div style={HINT_STYLE}>{t("identityFlow.personJoin.inviteHint")}</div>
        <TextField
          value={personInvite}
          onChange={setPersonInvite}
          label={t("identityFlow.personJoin.inviteLabel")}
          testId="identity-flow.person-join-invite"
          autoComplete="off"
          mono
        />
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel id={personPhraseLabelId}>
            {t("identityFlow.personJoin.phraseLabel")}
          </FieldLabel>
        </div>
        <PhraseEntryGrid
          cells={personWords}
          onCells={(next) => {
            setPersonError(null);
            setPersonWords(next.map((w) => w.replace(/\s+/g, "")));
          }}
          layout="field"
          testIdPrefix="identity-flow.person-join"
          cellTestId={(i) =>
            i === 0 ? "identity-flow.person-join-cell" : `identity-flow.person-join-cell-${i + 1}`
          }
          cellLabel={(i) => t("sync.enroll.wordAria", { number: i + 1 })}
          labelledBy={personPhraseLabelId}
          style={PHRASE_GRID_STYLE}
        />
        {personError ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {personError}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button
          onClick={() => void submitPersonPhrase()}
          disabled={personBusy || !personWords.every((word) => word.length > 0)}
          data-testid="identity-flow.person-join-submit"
        >
          {personBusy ? t("identityFlow.personJoin.working") : t("identityFlow.personJoin.cta")}
        </Button>
      </FooterBar>
      {personBusy && <BlockingOverlay title={t("identityFlow.personJoin.working")} />}
    </Screen>
  );

  /**
   * The pending screen: this device is admitted but not yet approved.
   *
   * It says what is happening and what the other device must do, because the
   * alternative is a spinner with no explanation, and the wait can be long (the
   * owner may not be holding their phone).
   */
  const renderPersonPending = () => (
    <Screen>
      <FlowHeader onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("common.waitingforapproval")}</Title>
        <Lead>{t("identityFlow.personJoin.pendingLead")}</Lead>
        <div style={{ marginTop: "var(--space-5)", display: "flex", justifyContent: "center" }}>
          <Spinner />
        </div>
        <div style={{ marginTop: "var(--space-4)" }} data-testid="identity-flow.person-join-pending">
          {t("identityFlow.personJoin.pendingHint")}
        </div>
        {personClaimNeedsPhrase ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {t("identityFlow.personJoin.sessionEnded")}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        {personClaimNeedsPhrase ? (
          <Button
            onClick={() => setStep("person-phrase")}
            data-testid="identity-flow.person-join-rephrase"
          >
            {t("identityFlow.personJoin.reenter")}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.person-join-cancel">
          {t("common.back")}
        </Button>
      </FooterBar>
    </Screen>
  );

  /**
   * The last step of a person join: the device is admitted, and its vault list is
   * being fetched (myne-md/myne#911 review).
   *
   * It exists so a failed `personListVaults` has somewhere to be visible. The
   * device is approved either way, so this is not an error screen: it says the
   * join worked, names the one thing that did not, and offers the retry. Nothing
   * else would run that call again.
   */
  const renderPersonFinishing = () => (
    <Screen>
      <FlowHeader onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.personJoin.finishingTitle")}</Title>
        <Lead>{t("identityFlow.personJoin.finishingLead")}</Lead>
        {personListError ? (
          <Banner
            kind="warning"
            style={{ marginTop: "var(--space-4)" }}
            testID="identity-flow.person-join-list-error"
          >
            {personListError}
          </Banner>
        ) : (
          <div style={{ marginTop: "var(--space-5)", display: "flex", justifyContent: "center" }}>
            <Spinner />
          </div>
        )}
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        {personListError ? (
          <Button
            onClick={finishPersonJoin}
            data-testid="identity-flow.person-join-list-retry"
          >
            {t("identityFlow.personJoin.listRetry")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={onCancel}
          data-testid="identity-flow.person-join-finish-cancel"
        >
          {t("common.back")}
        </Button>
      </FooterBar>
    </Screen>
  );

  /** What Save writes and what Copy puts on the clipboard: the same bytes, from
   *  the shared kit writer the vault flow uses, so a document saved on a phone is
   *  the one a person reads on a computer (myne-md/myne#468).
   *
   *  The second value in the document is the IDENTITY CODE, not an account
   *  number: an identity is vault-less by design (`decisions/protocol/0592`), and
   *  the code is the string an owner pastes to invite this person. It carries
   *  public material only, so a document holding it beside the phrase is not a
   *  second secret. */
  const phraseText = (): string =>
    recoveryKitText({
      vaultName: "",
      savedOn: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
        new Date(),
      ),
      phrase: (result?.phrase ?? "").split(" ").filter((w) => w.length > 0),
      accountNumber: result?.identity_code ?? "",
      labels: {
        title: t("identityFlow.phrase.title"),
        phraseHeading: t("vaultCreation.kit.phraseFor"),
        accountHeading: t("common.youridentitycode"),
      },
    });

  const copyPhrase = () => {
    void (async () => {
      const cancel = await copySecretToClipboard(phraseText(), {
        onSuccess: { kind: "inline", run: () => setActionMsg(t("createVault.phraseCopied")) },
        onFailure: { kind: "inline", run: () => setActionMsg(t("createVault.phraseCopyFailed")) },
      });
      if (cancel === null) return;
      clipboardCancelRef.current?.();
      clipboardCancelRef.current = cancel;
    })();
  };

  const savePhraseFile = () => {
    void (async () => {
      // `saveSecretToDocuments` is total: it logs and answers `null` rather than
      // rejecting, and `secretSaveMessage(null)` is the error sentence. The
      // `try` is here for the one thing outside it, `phraseText()`, so a throw
      // there still says something instead of leaving the button inert.
      try {
        const { key, params } = secretSaveMessage(
          await saveSecretToDocuments("myne-identity-phrase.txt", phraseText()),
        );
        setActionMsg(t(key, params));
      } catch {
        setActionMsg(t("createVault.saveFileError"));
      }
    })();
  };

  const renderPhrase = () => {
    const phrase = (result?.phrase ?? "").split(" ");
    return (
      <Screen>
        <FlowHeader />
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
          {/* Copy and Save, the two actions this screen was missing (issue #970
              item 20). Under the words rather than in the footer: the footer
              keeps ONE primary ("Continue"), and a pair of secondary buttons
              beside it on a phone reads as three equal choices. */}
          {revealed ? (
            <div style={{ marginTop: "var(--space-4)" }}>
              <div style={{ display: "flex", gap: "var(--space-3)" }}>
                {canCopyPhrase ? (
                  <Button
                    variant="secondary"
                    onClick={copyPhrase}
                    style={{ flex: 1 }}
                    data-testid="identity-flow.phrase-copy"
                  >
                    <Icon name="copy" size={16} color="var(--fg-2)" strokeWidth={1.5} />
                    {t("common.copy")}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={savePhraseFile}
                  style={{ flex: 1 }}
                  data-testid="identity-flow.phrase-save"
                >
                  <Icon name="download" size={16} color="var(--fg-2)" strokeWidth={1.5} />
                  {t("createVault.saveToFile")}
                </Button>
              </div>
              {actionMsg && (
                <p
                  role="status"
                  aria-live="polite"
                  style={{
                    margin: "var(--space-2) 0 0",
                    fontSize: "var(--text-sm)",
                    lineHeight: 1.5,
                    color: "var(--fg-3)",
                  }}
                >
                  {actionMsg}
                </p>
              )}
            </div>
          ) : null}
        </ScreenScroll>
        <FooterBar>
          {/* Revealed is the only gate here (myne-md/myne#869): the challenge
              moved to its own step, and until the words are on screen there is
              nothing to type back from. No back arrow and no dismissal either.
              The phrase is shown once and the ceremony holds until the type-back
              proves it was saved, which is the same block the desktop dialog
              enforces through `ModalShell.canDismiss`. */}
          <Button
            onClick={() => setStep("typeback")}
            disabled={!revealed}
            data-testid="identity-flow.phrase-continue"
          >
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  };

  const renderTypeback = () => {
    const phrase = (result?.phrase ?? "").split(" ");
    // The gate: all four words right. `revealed` is not re-checked because the
    // phrase is not on this screen, and back-returning to the phrase step keeps
    // `revealed` as it was, so the way to re-read the words is Back, not a
    // second reveal.
    const { matches: corrects, allCorrect } = phraseTypeBackMatches(phrase, challenge, answers);
    return (
      <Screen>
        <FlowHeader onBack={() => setStep("phrase")} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("common.confirmyourphrase")}</Title>
          <Lead>{t("identityFlow.phrase.typebackLead")}</Lead>
          <div style={{ marginTop: "var(--space-4)" }}>
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
          {serverConfigured ? (
            <div style={HINT_STYLE} data-testid="identity-flow.typeback-register-hint">
              {t("identityFlow.phrase.registerHint", { server: serverHost })}
            </div>
          ) : null}
        </ScreenScroll>
        {/* The ceremony's last act, and the words never leave it (myne-md/
            myne#1029). The register step used to ask for the same 24 words one
            screen later, and it is the act that mints the device id a binding row
            needs, so the friction sat on the one path that makes phrase-free sync
            possible. With a server configured the primary registers here, and
            "Later" keeps the old exit. Without one there is nothing to register
            WITH, so the single button stays "Continue" and the home's register
            block asks for the address first. */}
        {/* A refused registration is the one outcome this step can produce, and
            saying nothing is the worst shape on this branch: the button re-enables
            and sync stays as blocked as before while the user believes the device
            registered (myne-md/myne#1029 review). Same pair as the unlock and
            recover steps: the step's own banner, and a blocking overlay while the
            command runs. */}
        {error ? (
          <div style={{ padding: "0 22px" }}>
            <Banner kind="warning" testID="identity-flow.typeback-error">
              {error}
            </Banner>
          </div>
        ) : null}
        <FooterBar>
          {serverConfigured ? (
            <>
              <Button
                variant="secondary"
                onClick={finishPhrase}
                disabled={!allCorrect || busy}
                data-testid="identity-flow.typeback-later"
              >
                {t("identityFlow.phrase.registerLater")}
              </Button>
              <Button
                onClick={finishPhraseRegistering}
                disabled={!allCorrect || busy}
                data-testid="identity-flow.typeback-continue"
              >
                {t("identityFlow.phrase.registerCta")}
              </Button>
            </>
          ) : (
            <Button
              onClick={finishPhrase}
              disabled={!allCorrect}
              data-testid="identity-flow.typeback-continue"
            >
              {t("common.continue")}
            </Button>
          )}
        </FooterBar>
        {busy && <BlockingOverlay title={t("identityFlow.register.working")} />}
      </Screen>
    );
  };

  /**
   * The recover step: the 24-word phrase that brings an EXISTING identity onto
   * this device.
   *
   * It mirrors the join grid deliberately, down to the reused keys — the label
   * (`identityHome.joinPhraseLabel`), the hint (`sync.enroll.recoveryPhraseHint`),
   * the per-cell accessible name (`sync.enroll.wordAria`) and the cell testids'
   * shape. A user typing a phrase on either screen is doing the same thing, and a
   * second set of near-identical strings is how the two drift into saying
   * different things about the same words.
   *
   * There is no `StepProgress` here, and it is not an oversight: this step is one
   * screen with one decision, not a wizard. Adding a one-of-one counter would
   * promise a sequence that does not exist.
   */
  const renderRecover = () => (
    <Screen>
      <FlowHeader onBack={leaveRecover} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.recover.title")}</Title>
        <Lead>{t("identityFlow.recover.lead")}</Lead>

        <div
          id={recoverPhraseLabelId}
          data-testid="identity-flow.recover-phrase-label"
          style={{ marginTop: "var(--space-4)" }}
        >
          <FieldLabel>{t("identityHome.joinPhraseLabel")}</FieldLabel>
        </div>
        <div style={HINT_STYLE}>{t("sync.enroll.recoveryPhraseHint")}</div>
        <PhraseEntryGrid
          cells={recoverWords}
          onCells={(next) => {
            setError(null);
            setRecoverWords(next.map((w) => w.replace(/\s+/g, "")));
          }}
          testIdPrefix="identity-flow.recover-phrase"
          cellTestId={(i) =>
            i === 0 ? "identity-flow.recover-phrase" : `identity-flow.recover-phrase-cell-${i + 1}`
          }
          cellLabel={(i) => t("sync.enroll.wordAria", { number: i + 1 })}
          labelledBy={recoverPhraseLabelId}
          style={PHRASE_GRID_STYLE}
        />

        {/* The refusal belongs to THIS step, so its banner does. One message for
            every kind this call can refuse with, because a wrong phrase and a
            sealed identity this device cannot open arrive as the same kind: see
            `recoverIdentity`. */}
        {error ? (
          <Banner kind="danger" testID="identity-flow.recover-error" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button
          variant="secondary"
          full={false}
          onClick={leaveRecover}
          data-testid="identity-flow.recover-back"
        >
          {t("common.back")}
        </Button>
        <Button
          onClick={() => void recoverIdentity()}
          disabled={!recoverReady || busy}
          data-testid="identity-flow.recover-submit"
        >
          {busy ? t("identityFlow.recover.working") : t("identityFlow.recover.submit")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.recover.working")} />}
    </Screen>
  );

  /**
   * The identity unlock step. It exists because the create-vault action is
   * withheld while the identity is sealed: the alternative the phone shipped was a
   * button whose only possible answer was `PersonLocked`, with nothing on the
   * device that could clear it (`decisions/ui/0729`).
   */
  const renderUnlockIdentity = () => (
    <Screen>
      <FlowHeader
        onBack={() => {
          setError(null);
          setUnlockWords(Array(PHRASE_WORDS).fill(""));
          setStep("home");
        }}
      />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.unlock.title")}</Title>
        <Lead>{t("identityFlow.unlock.lead")}</Lead>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel id={unlockPhraseLabelId}>
            {t("identityHome.registerPhraseLabel")}
          </FieldLabel>
        </div>
        <PhraseEntryGrid
          cells={unlockWords}
          onCells={(next) => {
            setError(null);
            setUnlockWords(next.map((w) => w.replace(/\s+/g, "")));
          }}
          testIdPrefix="identity-flow.unlock"
          cellTestId={(i) =>
            i === 0 ? "identity-flow.unlock-cell" : `identity-flow.unlock-cell-${i + 1}`
          }
          cellLabel={(i) => t("sync.enroll.wordAria", { number: i + 1 })}
          labelledBy={unlockPhraseLabelId}
          style={PHRASE_GRID_STYLE}
        />
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button
          variant="secondary"
          full={false}
          onClick={() => {
            setError(null);
            setUnlockWords(Array(PHRASE_WORDS).fill(""));
            setStep("home");
          }}
        >
          {t("common.back")}
        </Button>
        <Button
          onClick={() => void unlockIdentity()}
          disabled={busy || !unlockWords.every((word) => word.length > 0)}
          data-testid="identity-flow.unlock-submit"
        >
          {busy ? t("identityFlow.unlock.working") : t("identityFlow.unlock.cta")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.unlock.working")} />}
    </Screen>
  );

  /**
   * The identity-unlock door on the home, in the one shape both states render.
   *
   * One control rather than two call sites (myne-md/myne#1029): the door used to
   * exist only inside the create block, so the state that needed it most (a device
   * with a vault whose sync is blocked on a sealed identity) rendered nothing. The
   * hint above it is the caller's, because the sentence differs (a withheld create
   * action, or the unlock step's own lead) while the control does not.
   */
  const unlockDoor = (hintKey: string, testId: string) => (
    <div style={{ marginTop: "var(--space-3)" }} data-testid={testId}>
      <div style={HINT_STYLE}>{t(hintKey)}</div>
      <Button
        variant="secondary"
        full={false}
        onClick={() => {
          setError(null);
          setStep("unlock-identity");
        }}
        style={{ marginTop: "var(--space-3)" }}
        data-testid="identity-flow.home-unlock-open"
      >
        {t("identityFlow.unlock.open")}
      </Button>
    </div>
  );

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
        <FlowHeader onBack={onCancel} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("common.youridentity")}</Title>
          <Lead>{t("identityFlow.home.lead")}</Lead>
          {/* What the account's vault listing answered (myne-md/myne#932 review).
              OUTSIDE the create block below, which is the half this moved out of:
              the create action belongs to the first-run door, while "my account is
              right and my vaults are missing" is a question a device asks on every
              entry, including the Settings one, which is offered no create action
              and so used to be offered no answer either. Three answers, because they
              have three remedies: retry here, publish from the device that holds the
              vault, or fetch the frame this device could not hold. */}
          {vaultIssue !== null ? (
            <div
              style={{ marginTop: "var(--space-4)" }}
              data-testid="identity-flow.home-vault-issue"
            >
              <Banner kind="warning">
                {vaultIssue === "failed"
                  ? t("identityFlow.personJoin.listFailed")
                  : vaultIssue === "empty"
                    ? t("identityFlow.personJoin.vaultsNoneOnServer")
                    : t("identityFlow.personJoin.vaultsNotHere", { count: vaultIssue })}
              </Banner>
            </div>
          ) : null}
          {/* **The action comes first** (myne-md/myne#970 item 22). This block
              used to sit fourth, under the account number, the identity code and
              the invitation list: a person who arrived here from onboarding
              scrolled past three blocks of material they had not asked for to
              reach the one thing the screen exists to offer. The material is
              still on the screen, and it is what makes this identity usable, but
              it is below, in the grouped cards the rest of the app uses. */}
          {/* **The unlock door does not depend on the create action**
              (myne-md/myne#1029). It used to live inside the `onCreateVault`
              block, and the shell passes that only on the first-run door: so a
              device that already held a vault, the one state a blocked sync
              row is in, rendered neither a create action nor a way to open its
              own identity, while `sync-status-view.ts` named exactly that act.
              It renders first, because on a sealed identity it is the one thing
              this screen exists to offer. */}
          {!identityUnlocked ? (
            <div style={{ marginTop: "var(--space-4)" }}>
              {unlockDoor(
                onCreateVault
                  ? "identityHome.createVaultLocked"
                  : "identityFlow.unlock.lead",
                onCreateVault
                  ? "identity-flow.home-create-vault-locked"
                  : "identity-flow.home-unlock-block",
              )}
            </div>
          ) : null}
          {onCreateVault ? (
            <div style={{ marginTop: "var(--space-4)" }}>
              <div data-testid="identity-flow.home-vault-hint" style={HINT_STYLE}>
                {t("identityFlow.home.vaultHint")}
              </div>
              {/* The action is WITHHELD while the identity is sealed, not shown
                  disabled: creating a vault signs its first member list with the
                  identity, so the sealed state makes the command answer
                  `PersonLocked`, and a button whose only outcome is a refusal is
                  a broken control (`decisions/ui/0729`). The door that clears it
                  is the block above, which every caller gets. */}
              {identityUnlocked ? (
                <Button
                  onClick={onCreateVault}
                  style={{ marginTop: "var(--space-3)" }}
                  data-testid="identity-flow.home-create-vault"
                >
                  {t("identityHome.createVaultCta")}
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* The identity material, as the grouped cards every other screen on
              this client uses (`ListGroup`: a header, an inset card, a footer).
              It used to be four consecutive `FieldLabel` + box + grey sentence
              stacks, which on a phone is one undifferentiated column where the
              least-used values take the most height. Same content, same
              testids, same hints: grouped, and below the action.

              The account number is rendered in its DISPLAY form, not the
              canonical body: the command answers the body on purpose
              (`core/src/plugins/sync/person_account.rs`) and the grouping lives
              in `@myne/client-core`, which is where the desktop takes it from.
              Rendering the raw 20 characters here showed the number without its
              `MY-` prefix or its dash groups (myne-md/myne#932). */}
          {accountNumber ? (
            <div style={{ marginTop: "var(--space-5)" }}>
              <ListGroup
                header={t("common.accountnumber")}
                footer={t("identityHome.accountNumberHint")}
              >
                <div style={{ padding: "14px 16px" }}>
                  <MonoBox
                    value={formatPersonAccountNumber(accountNumber)}
                    testId="identity-flow.home-account-number"
                  />
                </div>
              </ListGroup>
            </div>
          ) : null}

          {identityCode ? (
            <div style={{ marginTop: "var(--space-4)" }}>
              {/* What the code is, beside the code (myne-md/myne-ops#54). The
                  desktop identity home carried this sentence and the phone did
                  not, so a reader was shown a long string with a copy button and
                  nothing telling them whether sending it is safe. Same key as
                  the desktop: one sentence, one meaning. */}
              <ListGroup
                header={t("common.youridentitycode")}
                footer={t("identityHome.shareCodeHint")}
              >
                <div style={{ padding: "14px 16px" }}>
                  <MonoBox value={identityCode} testId="identity-flow.home-code" />
                </div>
              </ListGroup>
            </div>
          ) : null}

          <div style={{ marginTop: "var(--space-5)" }}>
            <FieldLabel>{t("identityFlow.home.invitesHeading")}</FieldLabel>
            {invites === null ? (
              <Spinner />
            ) : pending.length === 0 && claimed.length === 0 ? (
              <div style={HINT_STYLE} data-testid="identity-flow.home-empty">
                {t("common.noinvitationsyet")}
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


          {/* A `reserved` identity is one created with no server account: sealed,
              usable, and not reachable by anybody else. Registration is the act
              that makes it invitable, and it asks for the phrase because the
              phrase is the proof of possession. */}
          {/* Scanning a code from the identity home (myne-md/myne#932). This
              screen is where an invitee waits, and the scanner used to be
              reachable only through the welcome screen's join door: a device that
              already held the identity landed here and had nowhere to scan the
              code an owner had just shown it. Same handler the fork's code row
              uses, so there is one scanner rather than two. */}
          {onScanCode ? (
            <div style={{ marginTop: "var(--space-5)" }}>
              <Button
                variant="secondary"
                full={false}
                onClick={onScanCode}
                data-testid="identity-flow.home-scan"
              >
                {t("identityFlow.fork.code")}
              </Button>
            </div>
          ) : null}

          {accountState === "reserved" ? (
            <div style={{ marginTop: "var(--space-5)" }}>
              <FieldLabel>{t("identityFlow.home.registerHeading")}</FieldLabel>
              <div data-testid="identity-flow.home-register-hint" style={HINT_STYLE}>
                {t("identityFlow.home.registerHint")}
              </div>
              <Button
                variant="secondary"
                full={false}
                onClick={() => setStep("register")}
                style={{ marginTop: "var(--space-3)" }}
                data-testid="identity-flow.home-register-open"
              >
                {t("common.registerthisidentity")}
              </Button>
            </div>
          ) : null}

          {/* Forget this identity on this device (myne-md/myne#782). Device-local:
              the server account survives and is recoverable with the phrase.

              **The acknowledgement sits BEHIND the trigger** (myne-md/myne#932).
              It used to render permanently, with the destructive button disabled
              until it was ticked, so anyone merely visiting this screen was shown
              a statement about an act they had not started. The desktop puts the
              same checkbox inside the confirmation for the act
              (`MemberRosterPanel`'s `identityForget*`); this is that shape. */}
          <div style={{ marginTop: "var(--space-5)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--line-1)" }}>
            <FieldLabel>{t("common.thisdevice")}</FieldLabel>
            {error ? (
              <Banner kind="warning" style={{ marginBottom: "var(--space-3)" }}>
                {error}
              </Banner>
            ) : null}
            {forgetOpen ? (
              <div data-testid="identity-flow.home-forget-confirm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <AckRow
                  checked={forgetAck}
                  onToggle={() => setForgetAck((v) => !v)}
                  testId="identity-flow.home-forget-ack"
                >
                  {t("identityFlow.home.forgetCheckbox")}
                </AckRow>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <Button
                    variant="ghost"
                    disabled={!forgetAck || busy}
                    onClick={() => void forgetHeld()}
                    style={{ color: "var(--danger)" }}
                    data-testid="identity-flow.home-forget"
                  >
                    {t("common.forgetthisidentityonthisdevice")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setForgetOpen(false);
                      setForgetAck(false);
                    }}
                    data-testid="identity-flow.home-forget-cancel"
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                onClick={() => setForgetOpen(true)}
                style={{ color: "var(--danger)" }}
                data-testid="identity-flow.home-forget-open"
              >
                {t("common.forgetthisidentityonthisdevice")}
              </Button>
            )}
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

              {/* The accept refusal belongs to THIS step, so its banner does too. */}
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
                label={t("common.recoveryphrase")}
              />
              <Title>{t("identityHome.phraseHeading")}</Title>
              <div style={HINT_STYLE}>{t("identityHome.acceptPhraseHint")}</div>

              <div id={phraseLabelId} data-testid="identity-flow.accept-phrase-label" style={{ marginTop: "var(--space-4)" }}>
                <FieldLabel>{t("identityHome.acceptPhraseLabel")}</FieldLabel>
              </div>
              <div style={HINT_STYLE}>{t("sync.enroll.recoveryPhraseHint")}</div>
              <PhraseEntryGrid
          cells={acceptWords}
          onCells={(next) => {
            setError(null);
            setAcceptWords(next.map((w) => w.replace(/\s+/g, "")));
          }}
          testIdPrefix="identity-flow.accept-phrase"
          cellTestId={(i) =>
            i === 0 ? "identity-flow.accept-phrase" : `identity-flow.accept-phrase-cell-${i + 1}`
          }
          cellLabel={(i) => t("sync.enroll.wordAria", { number: i + 1 })}
          labelledBy={phraseLabelId}
          style={PHRASE_GRID_STYLE}
        />
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
                <FieldLabel>{t("common.masterpassword")}</FieldLabel>
              </div>
              <DevicePasswordField
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  setError(null);
                }}
                testId="identity-flow.accept.password-input"
                label={t("common.masterpassword")}
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
                {t("common.back")}
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
                label={t("common.recoveryphrase")}
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
              <PhraseEntryGrid
          cells={joinWords}
          onCells={(next) => {
            setJoinError(null);
            setJoinWords(next.map((w) => w.replace(/\s+/g, "")));
          }}
          testIdPrefix="identity-flow.join-phrase"
          cellTestId={(i) =>
            i === 0 ? "identity-flow.join-phrase" : `identity-flow.join-phrase-cell-${i + 1}`
          }
          cellLabel={(i) => t("sync.enroll.wordAria", { number: i + 1 })}
          labelledBy={joinPhraseLabelId}
          style={PHRASE_GRID_STYLE}
        />
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
                <FieldLabel>{t("common.masterpassword")}</FieldLabel>
              </div>
              <DevicePasswordField
                value={joinPassword}
                onChange={(v) => {
                  setJoinPassword(v);
                  setJoinError(null);
                }}
                testId="identity-flow.join.password-input"
                label={t("common.masterpassword")}
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
                {t("common.back")}
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
        <FlowHeader />
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
            {t("common.continue")}
          </Button>
        </FooterBar>
        {nameBusy && <BlockingOverlay title={t("common.continue")} />}
      </Screen>
    );
  };

  return (
    <Screen style={{ padding: 0 }}>
      {step === "gate" && renderGate()}
      {step === "join-fork" && renderJoinFork()}
      {step === "held" && renderHeld()}
      {step === "create" && renderCreate()}
      {step === "phrase" && renderPhrase()}
      {step === "typeback" && renderTypeback()}
      {step === "recover" && renderRecover()}
      {step === "home" && renderHome()}
      {step === "unlock-identity" && renderUnlockIdentity()}
      {step === "register" && renderRegisterServer()}
      {step === "register-phrase" && renderRegisterPhrase()}
      {step === "person-phrase" && renderPersonPhrase()}
      {step === "person-pending" && renderPersonPending()}
      {step === "person-finishing" && renderPersonFinishing()}
      {(step === "accept-owner" || step === "accept-phrase" || step === "accept-password") &&
        renderAccept()}
      {(step === "join-phrase" || step === "join-password") && renderJoin()}
      {step === "name" && renderName()}
    </Screen>
  );
}
