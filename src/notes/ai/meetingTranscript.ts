// Meeting AI: recover a meeting note's transcript from its body (meeting-ai
// follow-up).
//
// The one-shot offer after a meeting stop is not the only moment a user wants
// the pass. A re-run from the command palette reads the note that is already
// open, so it needs the transcript back out of the body the session wrote:
// strip the leading audio embeds, the transcript heading and its machine
// notice, and the AI block itself, leaving the spoken words.
//
// The extraction is deliberately tolerant rather than strict. A note the user
// has edited (a heading removed, a line reflowed) still yields the bulk of the
// transcript, which is what the pass needs; a strict grammar would refuse the
// note exactly when the user is most likely to want to re-run.

import { MEETING_AI_START } from "./meetingWrite";

/** Everything before the AI block, when one exists. */
function withoutAiBlock(body: string): string {
  const aiStart = body.indexOf(MEETING_AI_START);
  return aiStart === -1 ? body : body.slice(0, aiStart);
}

/**
 * Recover the transcript from a meeting note's body. Drops the `![[att:…]]`
 * audio embeds, any markdown heading, and a whole-line italic notice (the
 * machine-transcript line `_…_`), then returns the rest trimmed.
 */
export function extractMeetingTranscript(body: string): string {
  const kept = withoutAiBlock(body)
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim();
      if (text.startsWith("![[att:")) return false;
      if (text.startsWith("## ") || text.startsWith("# ")) return false;
      if (text.length >= 2 && text.startsWith("_") && text.endsWith("_")) {
        return false;
      }
      return true;
    });
  return kept.join("\n").trim();
}
