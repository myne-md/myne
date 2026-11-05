// The editor mounts the identity repair door (myne-md/myne#1029).
//
// **Why this is a SOURCE test rather than a behavioural one.** `EditorFlow` is the
// single state owner for the whole editor surface: rendering it in Vitest means
// standing up the stage machine, the prefs mirror, the note list and the CodeMirror
// engine. What is under test here is not what the door draws once it is mounted
// (that is `IdentityFlowUnlock.test.tsx`'s business): it is that the EDITOR mounts it
// at all, and where. Both facts are invisible to every compiler: an overlay that
// was never rendered, and one rendered at the shell instead, both typecheck.
//
// The second fact is the one worth pinning, and it is why the door does not live in
// `AppShell` beside the two scanned-code overlays: the shell returns an overlay
// INSTEAD of the editor, so mounting it there would unmount `EditorFlow` and drop
// `editing`, the note the user is reading, every time they opened the door. A
// future session that "tidies" it up to the shell would look like consistency and
// silently cost that. Same shape and same reason as
// `EditorFlow.lineNumbers.test.tsx`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const editorFlow: string = readFileSync(
  fileURLToPath(new URL("../../src/app/flows/EditorFlow.tsx", import.meta.url)),
  "utf8",
);

const appShell: string = readFileSync(
  fileURLToPath(new URL("../../src/app/AppShell.tsx", import.meta.url)),
  "utf8",
);

describe("EditorFlow mounts the identity repair door over the editor", () => {
  it("renders IdentityFlow itself, gated on its own state", () => {
    expect(editorFlow).toContain('import { IdentityFlow } from "./IdentityFlow"');
    expect(editorFlow).toContain("const [identityDoorOpen, setIdentityDoorOpen] = useState(false)");
    // The gate and the mount, together: a `setIdentityDoorOpen(true)` with nothing
    // rendered behind it is a callback that opens a door onto nothing.
    expect(editorFlow).toMatch(/\{identityDoorOpen && \(/);
    expect(editorFlow).toContain("<IdentityFlow");
    // `onUnlocked` is what makes this mount the REPAIR door rather than a second
    // copy of the identity home: the flow lands on the phrase grid and hands
    // control back instead of navigating to its own home.
    expect(editorFlow).toContain("onUnlocked={() => setIdentityDoorOpen(false)}");
  });

  it("wires the Settings sheet's row to it, and closes the sheet first", () => {
    // The props block of the JSX mount, not "the rest of the file": `indexOf`
    // finds the DOC COMMENT at the top of the module that names `<SettingsSheet>`,
    // and `setSettingsOpen(false)` also appears in the sheet's own `onClose` a few
    // lines further down, so a slice from the first hit asserts nothing (measured
    // by injection: removing the two setState calls from the callback left every
    // case in this file green).
    // A JSX OPEN TAG, so the doc comment that writes the component's name in
    // prose (`<SettingsSheet>`) is not a candidate: a real mount always has a prop
    // after the name.
    const mount = [...editorFlow.matchAll(/<SettingsSheet\s[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(mount, "no <SettingsSheet …/> JSX mount in EditorFlow").toHaveLength(1);
    const callback = mount[0].slice(mount[0].indexOf("onUnlockIdentity={() => {"));
    expect(callback).toContain("setSettingsOpen(false)");
    expect(callback).toContain("setIdentityDoorOpen(true)");
  });

  it("does NOT mount it at the shell, where the editor would unmount", () => {
    // The measured cost this guards: `StageSwitch` returns an overlay instead of
    // the editor, so `editing` (the open note) does not survive the round trip.
    const door = appShell.indexOf("identityDoorOpen");
    expect(door, "the identity door moved into AppShell; the open note no longer survives it").toBe(
      -1,
    );
  });
});
