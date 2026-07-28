// Web seam — `dialog` (phase3-web-client task 25).
//
// The interesting module, and the one where the browser genuinely differs.
// Task 25 states the split: "the browser has an *open* equivalent and none for
// arbitrary *save to a chosen path* — provide the former, omit the latter."

import { unsupported } from "../../../src/platform/unsupported";

/** What `open()` may be asked for. Mirrors the subset `src/` actually passes. */
interface OpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * Pick a file (or files, or a directory) to READ.
 *
 * The browser equivalent exists and is honest: `<input type="file">`, driven
 * programmatically. What it returns is **not** a path — the browser deliberately
 * never gives a page one — so this resolves the picked file's *name*, matching
 * the string shape Tauri's `open()` returns.
 *
 * That difference is load-bearing rather than cosmetic, and it is why this
 * returns a name rather than pretending: a caller that takes the result and
 * hands it to something expecting a real filesystem path is broken on web no
 * matter what this returns, and a name makes that visible at the call site
 * instead of at a failed read. Task 71 (the importer) is where files actually
 * need to reach the core, and it passes `File` objects into the Worker rather
 * than paths.
 *
 * Resolves `null` on cancel, exactly as Tauri does.
 */
export async function open(opts?: OpenOptions): Promise<string | string[] | null> {
  const options = opts ?? {};
  if (options.directory) {
    // A directory picker exists (`webkitdirectory`), but a directory has no
    // meaning to this client until the importer lands — and returning a folder
    // name that nothing can open would be the fake-path trap above.
    return unsupported("dialog.open");
  }

  return await new Promise<string | string[] | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple === true;
    if (options.filters?.length) {
      // Tauri filters are `{ name, extensions: ["md", "txt"] }`; `accept` wants
      // dotted extensions. The browser treats this as a HINT — a user can still
      // choose anything — so nothing downstream may rely on it.
      input.accept = options.filters
        .flatMap((f) => f.extensions.map((e) => `.${e.replace(/^\./, "")}`))
        .join(",");
    }
    // `change` fires on pick. Cancel has no reliable universal event, so the
    // promise stays pending on cancel in some browsers — `cancel` is used where
    // supported, and the picker is single-shot either way.
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }
      resolve(options.multiple === true ? files.map((f) => f.name) : files[0].name);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Save to a user-chosen path. **Absent on web, permanently.**
 *
 * There is no browser API for "let the user choose an arbitrary path and give me
 * that path". The download flow is the browser's answer and it is a different
 * shape — the page hands over bytes and the browser decides where they land —
 * which is task 48's job, not a substitute this function could return.
 *
 * Returning a fabricated path here would be the worst option: every caller would
 * proceed as if it had somewhere to write.
 */
export async function save(_opts?: unknown): Promise<string | null> {
  return unsupported("dialog.save");
}

/**
 * Confirm dialog.
 *
 * `window.confirm` is a real equivalent for the part that matters — modal,
 * boolean, blocking — so the *semantics* match Tauri exactly.
 *
 * **The presentation options do not survive**, and that is a genuine
 * degradation rather than an omission: Tauri's `{ title, kind, okLabel,
 * cancelLabel }` have no browser counterpart, because the browser owns its own
 * dialog chrome and deliberately does not let a page style or title it (an
 * anti-phishing decision, not an oversight). So a confirm that says "Myne" on
 * desktop shows the origin on web.
 *
 * Recorded here rather than silently dropped, and the seam contract asserts the
 * MESSAGE reaches the platform without asserting the chrome — see the note at
 * `dialog.confirm` in `tests/platform/seam-contract.ts`.
 */
export async function confirm(message: string, _opts?: unknown): Promise<boolean> {
  return window.confirm(message);
}

/** Message dialog. `window.alert` matches: modal, acknowledged, no return. */
export async function message(msg: string, _opts?: unknown): Promise<void> {
  window.alert(msg);
}
