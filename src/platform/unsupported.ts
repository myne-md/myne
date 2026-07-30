// Platform seam — the one typed "this cannot exist here" outcome.
//
// A seam operation is either implemented on the running platform or it is not.
// The failure mode this type exists to prevent is the second case arriving as
// an untyped rejection: a `TypeError: x is not a function` from a stubbed
// module, or a Rust `Error` string that happens to say "unsupported" and is
// matched on by prose. Both are unhandled states wearing an error's clothes.
//
// So: exactly one class, carrying the seam operation that was refused. The UI
// never renders this error — a capability the platform lacks is OMITTED from
// the interface, not shown and broken (`prd.md` story 19). It exists for the
// paths gating cannot reach: a stale deep link, a keyboard shortcut bound to a
// removed affordance, a command replayed from workspace state.
//
// The seam contract test (`tests/platform/seam-contract.ts`) asserts that every
// operation an implementation declares unsupported rejects with exactly this
// and nothing else, which is what keeps "absent" from silently becoming
// "throws something".

/**
 * An IPC command name in Tauri's `plugin:<plugin>|<command>` form.
 *
 * Admitted alongside the seam-module operations below because refusal happens at
 * **two granularities**, and collapsing them would lose the useful half.
 * `core.invoke` is supported on the web client — it is a specific *command*
 * (`plugin:backup|vault_export_backup`) that cannot exist there, and a caller
 * inspecting `.operation` needs to know which. `web/wasm/src/capability.rs`
 * holds the classification; the Worker transport raises this error for every
 * command it classifies as decided-absent.
 *
 * A template-literal type rather than `string`: it admits the IPC shape and
 * nothing else, so a typo like `"corex.invoke"` is still a compile error.
 */
export type IpcCommandName = `plugin:${string}|${string}`;

/** Seam operations, named `<module>.<export>`, that an implementation may refuse. */
export type SeamOperation =
  | IpcCommandName
  | "core.invoke"
  | "core.Channel"
  | "event.listen"
  | "dialog.open"
  | "dialog.save"
  | "dialog.confirm"
  | "opener.openUrl"
  | "opener.openPath"
  | "opener.revealItemInDir"
  | "path.appDataDir"
  | "path.join"
  | "window.destroy"
  | "window.isFullscreen"
  // MYND-628 — reveal a window that idle auto-lock hid. Refused on WEB: a page
  // has no hidden window, because web auto-lock re-renders the locked surface in
  // the same tab rather than taking one away.
  | "window.show"
  | "webviewWindow.listen"
  | "clipboard.writeText"
  | "clipboard.readText"
  | "clipboard.clear"
  | "deepLink.onOpenUrl"
  // phase3-web-client task 48 — the download flow's counterpart. Refused on
  // DESKTOP, which is the only direction of refusal in this union that runs that
  // way: every other member is a thing a browser cannot do. Here it is the
  // desktop that declines, because it has the stronger affordance (a native
  // Save-As naming a real path, with the plaintext staying in Rust) and two ways
  // to deliver one file is one too many.
  | "download.deliverFile"
  // phase3-web-client task 71 — the second desktop-side refusal, and for the
  // same class of reason. Reading a picked handle's text is what the WEB
  // importer does, because a browser has no host to ask. Desktop declines
  // because it has the stronger affordance: the root-confined `importer:` read
  // seam, which canonicalises and checks within-root before any I/O. Answering
  // here too would be a second, WIDER path to the same bytes — an opaque handle
  // read with no within-root check — which is precisely what that seam exists to
  // withhold from the WebView.
  | "filePicker.readPickedText";

/**
 * Thrown by a seam implementation for an operation the platform cannot provide.
 *
 * `name` is pinned to the literal `"PlatformUnsupportedError"` so the guard
 * below survives the class-identity loss that happens across a bundle
 * boundary (the Worker and the page each get their own module instance).
 */
export class PlatformUnsupportedError extends Error {
  readonly operation: SeamOperation;

  constructor(operation: SeamOperation) {
    super(`platform seam: ${operation} is not supported on this platform`);
    this.name = "PlatformUnsupportedError";
    this.operation = operation;
  }
}

/** `true` when `e` is a {@link PlatformUnsupportedError}, across bundle boundaries. */
export function isPlatformUnsupported(e: unknown): e is PlatformUnsupportedError {
  return (
    e instanceof Error &&
    e.name === "PlatformUnsupportedError" &&
    typeof (e as PlatformUnsupportedError).operation === "string"
  );
}

/** Reject with the typed outcome. Written as a helper so no implementation hand-rolls the shape. */
export function unsupported(operation: SeamOperation): never {
  throw new PlatformUnsupportedError(operation);
}
