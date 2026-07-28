// Compile-time conformance of the web seam to the desktop seam
// (phase3-web-client task 7).
//
// The Vite plugin substitutes `src/platform/*` for `web/src/platform/*` at
// BUILD time, which TypeScript knows nothing about: `tsc` type-checks the
// shared tree against the desktop seam, so a web module could drift out of
// shape — a missing generic, a dropped export, a wrong return type — and every
// check would still pass, right up until a call site got the wrong thing at
// runtime.
//
// This file closes that hole the only way that survives refactors: assign each
// web module to the desktop module's type. It is imported by nothing, so it
// never reaches a bundle; its entire job is to fail `tsc` when the two sides
// stop matching.

import * as desktopAttachments from "../../../src/platform/attachments";
import * as desktopCapabilities from "../../../src/platform/capabilities";
import * as desktopClipboard from "../../../src/platform/clipboardManager";
import * as desktopCore from "../../../src/platform/core";
import * as desktopDeepLink from "../../../src/platform/deepLink";
import * as desktopDownload from "../../../src/platform/download";
import * as desktopEvent from "../../../src/platform/event";
import * as desktopExitSignals from "../../../src/platform/exit-signals";
import * as desktopHistory from "../../../src/platform/history";
import * as desktopKeyboard from "../../../src/platform/keyboard";
import * as desktopFilePicker from "../../../src/platform/filePicker";
import * as desktopOpener from "../../../src/platform/opener";
import * as desktopPath from "../../../src/platform/path";
import * as webAttachments from "./attachments";
import * as webCapabilities from "./capabilities";
import * as webClipboard from "./clipboardManager";
import * as webCore from "./core";
import * as webDeepLink from "./deepLink";
import * as webDownload from "./download";
import * as webEvent from "./event";
import * as webExitSignals from "./exit-signals";
import * as webHistory from "./history";
import * as webKeyboard from "./keyboard";
import * as webFilePicker from "./filePicker";
import * as webOpener from "./opener";
import * as webPath from "./path";

// Modules whose shape is fully shared. A drift here is a type error naming the
// exact export that moved.
const _attachments: typeof desktopAttachments = webAttachments;
const _capabilities: typeof desktopCapabilities = webCapabilities;
const _clipboard: typeof desktopClipboard = webClipboard;
const _deepLink: typeof desktopDeepLink = webDeepLink;
const _opener: typeof desktopOpener = webOpener;
const _path: typeof desktopPath = webPath;
const _listen: typeof desktopEvent.listen = webEvent.listen;
// The two seams that answer a HOST question rather than wrapping a transport
// (tasks 64 + 66): where the client was opened, and which chords the host keeps
// for itself. Whole-module for the `filePicker` reason — the types are ours, and
// the desktop arm's "nothing is reserved / nothing is addressable" is a real
// answer that must stay the same SHAPE as the browser's real one.
const _exitSignals: typeof desktopExitSignals = webExitSignals;
const _history: typeof desktopHistory = webHistory;
const _keyboard: typeof desktopKeyboard = webKeyboard;
// Whole-module, like `filePicker` and for the same reason: the types are ours,
// not Tauri's, and both arms must agree on the signature even though only one
// of them does anything.
const _download: typeof desktopDownload = webDownload;
// The picker seam (task 76). Worth a WHOLE-MODULE check rather than a
// per-export one, unlike `core`: its types are ours, not Tauri's, and the whole
// point of the module is that both sides return the SAME opaque handle type. A
// web arm that quietly widened `PickedFile` — say, adding a `path` field the
// desktop never sets — would be the exact drift the seam exists to prevent, and
// this assignment is what names it.
const _filePicker: typeof desktopFilePicker = webFilePicker;

// `core.invoke` is checked per-export rather than whole-module (task 11). This
// is the one that matters most — it is the call shape every backend interaction
// in `src/` goes through — and it is checkable now that the web side is real:
// the web signature takes `(cmd, args?)` where Tauri's takes
// `(cmd, args?, options?)`, and a function accepting fewer parameters is
// assignable to one accepting more, so this assignment pins argument and return
// types without the web seam having to reimplement `InvokeOptions`.
const _invoke: typeof desktopCore.invoke = webCore.invoke;

// `core.Channel`, `dialog`, `window` and `webviewWindow` are deliberately NOT
// checked whole-module: their desktop types are Tauri's own (`Channel`'s
// internal callback id, `Window`'s ~40 methods, `open`'s overload set), and
// matching those exactly would mean the web seam reimplementing Tauri's surface
// rather than the surface `src/` actually calls.
//
// **This note used to say task 25 would replace that with a whole-module check.
// Task 25 has landed and did NOT** — deliberately. The right pin for those four
// turned out to be the `SeamModules` interface in `tests/platform/seam-contract.ts`,
// which both implementations are now driven against (`web-seam.test.ts`,
// `tauri-seam.test.ts`). Behaviour is what needed pinning there, not type
// identity with Tauri's surface; a `tsc` assignment would have forced the web
// seam to grow members no call site uses.

export {};
void _attachments;
void _capabilities;
void _clipboard;
void _deepLink;
void _opener;
void _path;
void _listen;
void _exitSignals;
void _history;
void _keyboard;
void _download;
void _filePicker;
void _invoke;
