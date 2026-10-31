// Device-join QR block (MYND-466) — the trusted device shows a QR another device
// scans to join. Penpot skipped per the owner directive (same as
// DeviceManagementPanel); built against design tokens.
//
// TWO VARIANTS, one implementation (myne-md/myne). `account` is the owner's, and
// it needs the account number pasted in: the account# is an AS9 bearer token Myne
// never persists (account-number.md §8), so the user pastes it here to make the
// QR. `member` is a member's own second device, and it takes no input at all —
// the payload is built from the ACTIVE session (server address + this vault's
// account hash), and the other device is asked for the 24-word phrase there.
//
// The QR carries no secret in either variant, and the scanner supplies its own
// credential: SYNC-47. Ephemeral: regenerated before the backend TTL lapses so a
// photographed code can't be reused later (live co-presence — the basis for the
// scan replacing the cert eye-compare, SYNC-26).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import {
  generateDeviceJoinQr,
  generateMemberJoinQr,
  generatePersonJoinQr,
  deviceJoinQrErrorMessage,
  memberJoinQrErrorMessage,
  personJoinQrErrorMessage,
} from "../../lib/deviceJoinQr";
import { svgToObjectUrl } from "../../lib/noteImageCard";
import { HOVER_TRANSITION } from "../primitives/hoverSurface";
import { interactiveSurface } from "../primitives/interactiveSurface";

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
};

const HINT: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

// Input + "Make QR" share one line: the input grows, the button sits beside it
// at the input's height (align-items stretch), a small gap between.
const INPUT_ROW: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: "var(--space-2)",
};

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
};

const BTN: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  transition: HOVER_TRANSITION,
};

const QR_WRAP: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  // Paper-toned so the QR's own #fbfbfa quiet zone blends into the card with no
  // visible edge in light theme; the border delineates the card from the panel. In
  // dark theme --paper re-points dark, so the card is dark and the literal-light QR
  // shows as a light code on a dark card; the SVG carries its own #fbfbfa quiet zone
  // around the modules, so it stays scannable either way.
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

// The rendered SVG is self-contained and literal-coloured (theme-agnostic, never
// tinted) with the Myne mark in a centre knockout. Sized so the largest realistic
// payload (self-host URL + 64-hex pin, up to ~85 modules incl. quiet zone) clears the
// ~4 px/module a phone camera needs off a screen: 340 / 85 = 4.0. Smaller payloads
// render larger than needed, which never hurts scanning.
const QR_IMG: CSSProperties = { width: 340, height: 340 };

const SCAN_LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
};

const ERROR: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--danger)",
};

// Regenerate this many seconds before the backend TTL lapses, so the visible QR
// is always fresh (and scannable) while the panel is open.
const REFRESH_BUFFER_SECS = 15;

/** The member variant's three steps, as real list content rather than one
 *  paragraph: this is the ONLY place the member's own-device path is explained,
 *  and a reader has to be able to follow it one line at a time. */
const STEPS: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  margin: 0,
  paddingInlineStart: "var(--space-4)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: "var(--leading-normal)",
};

/**
 * Which join this block produces.
 *
 * `account` — the owner's device-join: the account number is pasted in (it is an
 * AS9 bearer token Myne never persists, so the user supplies it) and the scanning
 * device proves `{account# + password}`.
 *
 * `member` — a member's own second device: no input, because the payload is built
 * from the active session, and the scanning device proves the 24-word phrase.
 *
 * `person`, a device added to the identity itself (myne-md/myne#911 task 9): the
 * payload again comes from the session, and the scanning device types the identity
 * phrase and then waits for THIS device to approve it.
 */
export type DeviceJoinQrVariant = "account" | "member" | "person";

export function DeviceJoinQr({
  showTitle = true,
  variant = "account",
}: {
  showTitle?: boolean;
  variant?: DeviceJoinQrVariant;
} = {}) {
  const { t } = useTranslation();
  const isMember = variant === "member";
  const isPerson = variant === "person";
  // Both non-account variants mint from the ACTIVE session, so neither takes an
  // input: that IS the difference between them and `account`.
  const noInput = isMember || isPerson;
  const [account, setAccount] = useState("");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const generate = useCallback(
    async (accountNumber: string) => {
      setBusy(true);
      setError(null);
      try {
        // The member payload takes no argument: the vault is resolved from the
        // active session backend-side, so this call cannot name another vault.
        const res = isMember
          ? await generateMemberJoinQr()
          : isPerson
            ? await generatePersonJoinQr()
            : await generateDeviceJoinQr(accountNumber);
        setSvg(res.svg);
        clearTimer();
        const delay =
          Math.max(res.ttl_secs - REFRESH_BUFFER_SECS, REFRESH_BUFFER_SECS) *
          1000;
        timer.current = setTimeout(() => void generate(accountNumber), delay);
      } catch (e) {
        setSvg(null);
        clearTimer();
        setError(
          isMember
            ? memberJoinQrErrorMessage(e)
            : isPerson
              ? personJoinQrErrorMessage(e)
              : deviceJoinQrErrorMessage(e),
        );
      } finally {
        setBusy(false);
      }
    },
    [isMember, isPerson],
  );

  // Cancel any pending refresh on unmount.
  useEffect(() => clearTimer, []);

  // The member variant has nothing to paste — that IS the variant — so it mints
  // its code on mount. Latched through a ref rather than through `busy`/`svg`,
  // because StrictMode double-invokes an effect at MOUNT (`src/AGENTS.md`): both
  // invocations read the same mount-time values, so a state guard cannot see the
  // first call and the backend would be asked twice. The latch is the shape the
  // identity flow's the fromQr effect uses for the same reason.
  const mintedOnce = useRef(false);
  useEffect(() => {
    if (!noInput || mintedOnce.current) return;
    mintedOnce.current = true;
    void generate("");
    // `generate` carries the variant, and the mint is deliberately keyed on the
    // mount alone: the refresh timer owns every later mint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noInput]);

  const onInput = (raw: string) => {
    setAccount(formatAccountNumberInput(raw));
    setSvg(null);
    setError(null);
    clearTimer();
  };

  const canGenerate = account.trim().length > 0 && !busy;
  // An object URL rather than a `data:` URI (phase3-web-client task 97): this was
  // the second of the two call sites keeping `data:` in the web client's CSP.
  // Minted only when the SVG actually changes — and REVOKED when it changes
  // again or the panel unmounts, because an object URL is a GC root for its Blob
  // and a QR panel the user opens repeatedly would otherwise accumulate them.
  const [imgSrc, setImgSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!svg) {
      setImgSrc(undefined);
      return;
    }
    const url = svgToObjectUrl(svg);
    setImgSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [svg]);

  return (
    <div
      style={ROOT}
      data-testid={
        isMember
          ? "sync.member-join-qr"
          : isPerson
            ? "sync.person-join-qr"
            : "sync.device-join-qr"
      }
    >
      {/* The dialog supplies the title (myne-md/myne#831); the inline block
          keeps its own heading. */}
      {showTitle ? (
        <div style={LABEL}>
          {t(
            isMember
              ? "sync.memberJoinQr.title"
              : isPerson
                ? "sync.personJoinQr.title"
                : "sync.deviceJoinQr.title",
          )}
        </div>
      ) : null}
      {/* The person variant carries NO paragraph here: its four steps below say
          the same thing in order (paste the code, type your 24 words, approve
          here, the vaults appear), and the paragraph restated all four in one
          breath above them (myne-md/myne#945 item 03, owner report: "the text
          repeats itself"). The member variant keeps its line, which carries a
          claim the steps do not make: what the code does and does not contain. */}
      {isPerson ? null : (
        <div style={HINT}>
          {t(
            isMember
              ? "sync.memberJoinQr.hint"
              : "sync.deviceJoinQr.hint",
          )}
        </div>
      )}
      {noInput ? (
        // The path the code shortcuts, spelled out. Two DIFFERENT paths share
        // this arm, so they cannot share one list: a member's second device
        // holds no account number and joins through an invitation, while a
        // person's device holds no identity yet, types the identity phrase, and
        // waits for this device to approve it. Rendering the member copy under
        // the person testid told a user to look for invitations that do not
        // exist for an identity join (myne-md/myne#911 review).
        isPerson ? (
          <ol style={STEPS} data-testid="sync.person-join-qr.steps">
            <li>{t("sync.personJoinQr.stepCode")}</li>
            <li>{t("sync.personJoinQr.stepPhrase")}</li>
            <li>{t("sync.personJoinQr.stepApprove")}</li>
            <li>{t("sync.personJoinQr.stepVaults")}</li>
          </ol>
        ) : (
          <ol style={STEPS} data-testid="sync.member-join-qr.steps">
            <li>{t("sync.memberJoinQr.stepIdentity")}</li>
            <li>{t("sync.memberJoinQr.stepPhrase")}</li>
            <li>{t("sync.memberJoinQr.stepJoin")}</li>
          </ol>
        )
      ) : (
        <>
          <label style={LABEL} htmlFor="device-join-qr-account">
            {t("sync.deviceJoinQr.accountLabel")}
          </label>
          <div style={INPUT_ROW}>
            <input
              id="device-join-qr-account"
              style={INPUT}
              value={account}
              onChange={(e) => onInput(e.target.value)}
              placeholder={t("sync.deviceJoinQr.accountPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              data-testid="sync.device-join-qr.account-input"
            />
            <button
              type="button"
              style={{
                ...BTN,
                opacity: canGenerate ? 1 : 0.5,
                cursor: canGenerate ? "pointer" : "default",
              }}
              disabled={!canGenerate}
              {...interactiveSurface({
                restBg: "var(--bg-2)",
                hoverBg: "var(--paper-3)",
                disabled: !canGenerate,
              })}
              onClick={() => void generate(account.trim())}
              data-testid="sync.device-join-qr.generate"
            >
              {t("sync.deviceJoinQr.generate")}
            </button>
          </div>
        </>
      )}
      {error && (
        <div
          style={ERROR}
          data-testid={
            isMember
              ? "sync.member-join-qr.error"
              : isPerson
                ? "sync.person-join-qr.error"
                : "sync.device-join-qr.error"
          }
        >
          {error}
        </div>
      )}
      {svg && (
        <div
          style={QR_WRAP}
          data-testid={
            isMember
              ? "sync.member-join-qr.image"
              : isPerson
                ? "sync.person-join-qr.image"
                : "sync.device-join-qr.image"
          }
        >
          <img
            style={QR_IMG}
            src={imgSrc}
            alt={t(
            isMember
              ? "sync.memberJoinQr.title"
              : isPerson
                ? "sync.personJoinQr.title"
                : "sync.deviceJoinQr.title",
          )}
          />
          <div
            style={SCAN_LABEL}
            data-testid={
              isMember
                ? "sync.member-join-qr.scan-label"
                : "sync.device-join-qr.scan-label"
            }
          >
            {t(
              isMember
                ? "sync.memberJoinQr.scanWithApp"
                : "sync.deviceJoinQr.scanWithApp",
            )}
          </div>
        </div>
      )}
    </div>
  );
}
