// The web build's stand-in for the B2B member-roster panel (myne-md/myne#698).
//
// The panel prompts for the person's 24-word recovery phrase to unlock a member
// identity, and `docs/vision.md` commits that the phrase as a device-enrolment
// credential "is kept out of the served artefact by build-time substitution
// rather than by a runtime branch". A runtime capability gate on
// `SyncPanel.tsx` is not that: it hides the render while the phrase prompt, the
// five `sync_person_*`/`sync_*_member` invoke literals and the copy still ship
// in the bundle, which is exactly the shape `check-web-no-phrase.mjs`'s header
// records as already having failed once for the enrolment grid.
//
// So this renders nothing, and the phrase field, the invite form and the member
// rows never enter the bundle. The capability descriptor marks `memberSharing`
// absent for the same reason; the substitution is what makes the absence a
// property of the artefact rather than of the routing.

export function MemberRosterPanel() {
  return null;
}
