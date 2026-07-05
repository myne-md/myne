import { getHost, type EditorPrefs } from "../../host";
export type PrefsView = EditorPrefs;
export function prefsRead(): Promise<EditorPrefs> { return getHost().prefsRead(); }
