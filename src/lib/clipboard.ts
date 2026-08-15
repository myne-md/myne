// The one place a copy decides what the user is told.
//
// Before this module, eleven clipboard call sites across `src/`, `editor/` and
// `mobile/src/` each answered that question on their own, and four patterns
// emerged: a toast pair, a label swap that never reverted, an icon flip, and
// saying nothing at all (myne-md/myne#390 audits the desktop half,
// myne-md/myne#455 the mobile half). Two surfaces were silent on BOTH outcomes,
// which is the case that matters: a failed copy looks exactly like a successful
// one, so the user pastes the previous clipboard contents believing it is their
// note. On the recovery-phrase step, where the phrase is shown once and never
// again, "I pressed Copy" stops being evidence the phrase is anywhere.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: a confirmation names the OUTCOME,
// never the copied VALUE. A toast that renders the recovery phrase defeats the
// point of copying it carefully. That is why a {@link FeedbackArm}'s `run` takes
// no argument: the value is structurally out of its reach.
//
// The module holds POLICY. It holds no TRANSPORT, and it imports nothing at all
// so it can be source-consumed by every client, including two that could not
// otherwise take it:
//
//   - `editor/` is forbidden every `@tauri-apps/*` import by
//     `scripts/check-platform-seam.mjs`, so a helper that reached for a platform
//     module directly would be unusable there. It passes its host's clipboard
//     member instead.
//   - `mobile/src` is a separate tree that aliases this file as
//     `@myne/clipboard`. The alias is safe for the same reason the sibling
//     aliases in `mobile/vite.config.ts` are: after type erasure this module has
//     no imports, so it drags no second copy of anything across the tree
//     boundary.
//
// Everything environmental is injected: the write, the clear, and the error
// sink. What is NOT injected, and cannot be omitted, is the feedback pair.

/**
 * A platform's clipboard write. Rejects when the write did not happen.
 *
 * Desktop and web pass their platform seam; mobile passes its native
 * sensitive-pasteboard command; `editor/` passes whatever its host supplied.
 */
export type ClipboardWrite = (value: string) => Promise<void>;

/**
 * What the user is shown for one outcome.
 *
 * `silent` deliberately has no `run`. Silence is a decision here, not an
 * omission: an author who wants it has to name a reason, and a reviewer reading
 * the call site sees the reason rather than an absence they have to interpret.
 * Two surfaces legitimately want it, and both are documented at their call site.
 */
export type FeedbackArm =
  | { kind: "toast"; run: () => void }
  | { kind: "inline"; run: () => void }
  | { kind: "inline-icon"; run: () => void }
  | { kind: "silent"; reason: string };

// On the three non-silent arms: this module reads `kind` only to detect
// `silent`, and `toast` / `inline` / `inline-icon` take an identical path
// through {@link announce}. That is not an oversight and they are not dead.
//
// The module is import-free by construction, so it can never own the rendering
// that would make the distinction load-bearing HERE. What reads the discriminant
// is `scripts/check-clipboard-feedback.mjs`, statically: the per-surface verdict
// table this feature settles is a rule about which surface class gets which arm
// (a secret shown once gets a persistent inline confirmation, an ordinary
// content copy gets a toast), and a rule stated only in prose is one nobody
// re-checks. Collapsing these three into one arm would delete the thing the
// guard keys on.

/**
 * The success and failure verdicts, decided INDEPENDENTLY.
 *
 * A single verdict for both outcomes would not survive contact with the tree.
 * `src/components/FailClosedError.tsx` confirms inline when the copy lands and
 * stays deliberately quiet when it does not, because it is already the screen
 * the user is stuck on and the error code is readable on it regardless. Forcing
 * one verdict would make that call site surrender either its confirmation or its
 * silence.
 */
export interface Feedback {
  onSuccess: FeedbackArm;
  onFailure: FeedbackArm;
}

/**
 * How a secret leaves the clipboard again.
 *
 * `host` is the desktop shape: a delay, then a host-side command that compares
 * before clearing. The comparison runs host-side (myne#379) so the WebView never
 * needs an OS-clipboard READ grant, which is the more dangerous direction than
 * write: a write destroys the user's clipboard, a read harvests whatever they
 * last copied from a password manager.
 *
 * `os-managed` is the mobile shape: the pasteboard item carries its own expiry,
 * enforced by the OS. It is strictly better than a timer here, and not only for
 * tidiness. An OS expiry survives the app being killed, which a `setTimeout` does
 * not and which matters far more on a phone; it expires that ITEM, so it can
 * never destroy something the user copied afterwards; and it removes the closure
 * that would otherwise hold the secret in the JS heap for the whole window.
 */
export type ClearStrategy =
  | { kind: "host"; clear: (value: string) => Promise<void>; delayMs: number }
  | { kind: "os-managed" };

/** Cancels a pending clear. Callers MUST invoke it on unmount when one is pending. */
export type CancelClear = () => void;

/** Shared no-op cancel. Module scope on purpose: see the note in {@link copySecret}. */
const NOOP_CANCEL: CancelClear = () => {};

export interface CopyOptions {
  /**
   * Where a rejection goes. Injected rather than imported so this module keeps
   * its empty import list, and because the right log prefix differs by caller:
   * the vault-creation flow has its own discipline, a code block does not.
   */
  onError?: (e: unknown) => void;
}

function announce(arm: FeedbackArm): void {
  // `silent` carries a reason and no `run`; there is deliberately nothing to do.
  if (arm.kind === "silent") return;
  arm.run();
}

function report(options: CopyOptions | undefined, e: unknown): void {
  options?.onError?.(e);
}

/**
 * Copy non-secret text, and tell the user which way it went.
 *
 * Resolves `true` when the write landed. Never rejects: a refused clipboard is
 * something to report, not something to crash a render on, and the caller
 * already said what reporting means for this surface.
 */
export async function copyText(
  write: ClipboardWrite,
  value: string,
  feedback: Feedback,
  options?: CopyOptions,
): Promise<boolean> {
  try {
    await write(value);
  } catch (e) {
    report(options, e);
    announce(feedback.onFailure);
    return false;
  }
  announce(feedback.onSuccess);
  return true;
}

/**
 * Copy a secret, and arrange for it to leave the clipboard again.
 *
 * Resolves to a cancel function when the write landed, or `null` when it did
 * not. The `null` is the same shape the vault-creation steps already check, so
 * migrating them onto this module changes no call-site logic.
 *
 * A FAILED write schedules NOTHING, and that is the property worth stating
 * loudest. A clear scheduled after a failed write would fire against whatever
 * the user actually had on the clipboard and wipe it, turning a surface that was
 * only supposed to report a failure into one that destroys data.
 */
export async function copySecret(
  write: ClipboardWrite,
  value: string,
  feedback: Feedback,
  strategy: ClearStrategy,
  options?: CopyOptions,
): Promise<CancelClear | null> {
  if (!(await copyText(write, value, feedback, options))) return null;

  // Module-level constant, NOT a fresh `() => {}`. A closure created inside this
  // function shares one context object with everything else in it, so an inline
  // no-op would transitively pin `value` for as long as the caller held the
  // cancel function it was handed. On the OS-managed path the caller typically
  // parks that in a ref until unmount, so the inline version would retain the
  // secret LONGER than the desktop path's bounded window, which is the opposite
  // of what this arm exists to do.
  if (strategy.kind === "os-managed") return NOOP_CANCEL;

  const { clear, delayMs } = strategy;

  // `pending` rather than capturing the parameter, so `value` is released on
  // BOTH exits: when the clear fires, and when the caller cancels. Capturing the
  // parameter directly is what `src/lib/secret-export.ts` does today, and its
  // docstring's claim that cancelling bounds the secret's lifetime to the window
  // was never true for exactly this reason: the cancel closure and the timer body
  // are siblings in one scope, so a held cancel kept the secret reachable after
  // the timer had already run. Same for the error sink, which on a React call
  // site closes over component state and would otherwise be pinned for the whole
  // delay.
  let pending: string | null = value;
  let sink = options?.onError;

  const timer = setTimeout(() => {
    const secret = pending;
    pending = null;
    const report = sink;
    sink = undefined;
    if (secret === null) return;
    void clear(secret).catch((e) => {
      // The window has passed and the user has moved on. Surfacing this would
      // put an error on whatever screen they are looking at now, which is not
      // the one they copied from.
      report?.(e);
    });
  }, delayMs);

  return () => {
    pending = null;
    sink = undefined;
    clearTimeout(timer);
  };
}
