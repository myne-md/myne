// Bridge for the shared editor's `/record` slash command → the React
// RecordingSheet. The shared `@myne/editor` engine can't reach into the mobile
// app's React state, so the mobile EditorHost (`editor-host.ts`) implements its
// optional `voiceRecord` slot by dispatching this window event; `EditorFlow`
// listens and opens the RecordingSheet. Same decoupling pattern as the widget
// `CAPTURE_EVENT` (`deep-link.ts`) and `REVEAL_ATTACHMENT_EVENT`.

/** Fired on the window when the user runs `/record` in the shared editor. */
export const VOICE_RECORD_EVENT = "myne-voice-record-request";

/** Ask the editor surface to open the voice-recording sheet against the current
 *  note. Safe to call from outside React (the EditorHost seam). */
export function requestVoiceRecording(): void {
  window.dispatchEvent(new CustomEvent(VOICE_RECORD_EVENT));
}
