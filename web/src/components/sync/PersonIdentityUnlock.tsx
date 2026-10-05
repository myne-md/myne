// The web build's stand-in for the person-identity session unlock
// (myne-md/myne#831). The recovery-phrase prompt must stay out of the served
// bundle by build-time substitution, not a runtime gate, so this renders
// nothing; `memberSharing` is absent on web for the same reason.
export function PersonIdentityUnlock() {
  return null;
}
