// Scene ⇄ note-body transforms for drawing notes (drawing-notes SF2, MYND-499;
// SYNC-8).
//
// A drawing note body is `<frontmatter>\n\n```excalidraw\n<sceneJson>\n```\n`
// (+ a trailing `![[att:<id>]]` ref block once SF3 lands). These pure functions
// extract the scene JSON for the canvas's `initialData` and splice an updated
// scene back in on autosave, leaving the frontmatter and anything AFTER the fence
// (the SF3 att-ref block) byte-untouched. Pure + unit-tested; the canvas ↔
// autosave wiring that calls them lives in the PaneView render branch.

const FENCE_RE = /(```excalidraw\n)([\s\S]*?)(\n```)/;

/** The scene JSON inside the ```excalidraw fence, or null if the body has none. */
export function extractSceneJson(content: string): string | null {
  const m = FENCE_RE.exec(content);
  return m ? (m[2] ?? null) : null;
}

/**
 * Replace the scene JSON inside the ```excalidraw fence, preserving frontmatter
 * and any trailing content (SF3 att-ref block) exactly. If no fence exists yet
 * (malformed / legacy), append one after the existing body. Uses a replace
 * callback so `$` sequences in the JSON are never interpreted.
 */
export function writeSceneJson(content: string, sceneJson: string): string {
  if (FENCE_RE.test(content)) {
    return content.replace(
      FENCE_RE,
      (_match, open: string, _old: string, close: string) =>
        `${open}${sceneJson}${close}`,
    );
  }
  const sep = content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}\`\`\`excalidraw\n${sceneJson}\n\`\`\`\n`;
}

/**
 * Re-inject `appState.theme` into a serialized scene. Excalidraw marks `theme` as
 * `export: false`, so `serializeAsJSON(…, "local")` DROPS it — without this a
 * per-drawing light/dark choice is never written to the note body and resets on
 * every remount (a note switch). Only `"light"` / `"dark"` are persisted; any
 * other value (or malformed JSON) returns the input untouched. Pure + unit-tested.
 */
export function withPersistedTheme(sceneJson: string, theme: unknown): string {
  if (theme !== "light" && theme !== "dark") return sceneJson;
  try {
    const scene = JSON.parse(sceneJson) as { appState?: Record<string, unknown> };
    scene.appState = { ...(scene.appState ?? {}), theme };
    return JSON.stringify(scene);
  } catch {
    return sceneJson;
  }
}
