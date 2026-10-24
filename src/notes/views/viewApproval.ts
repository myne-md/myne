// Whether THIS DEVICE has approved the definition it holds (view-manifests).
//
// Approval is device-local and keyed by `(view id, version)`: a manifest that
// arrives by import or by sync is listed and refuses to open until the person at
// this device approves it, and because "approved" is an EQUALITY against the
// stored version, a version bump revokes the approval with no clear step and
// nothing to forget.
//
// This is the TypeScript mirror of the Rust authority
// (`protocol::view_manifest::is_view_approved`), and it exists only to decide
// what to RENDER. It is not an authority: the host re-checks approval on every
// write (`note_set_field` answers `NotApproved`), so a caller that lies to
// itself here can only cause a surface to render something the host will then
// refuse.
//
// An absent `version` reads as APPROVED, deliberately. Only a view authored
// before the field existed can lack one, because the import reader refuses a
// manifest without it, so absence means "this vault made it" and there is nobody
// to ask. Reading it the other way would put every pre-existing view behind an
// approval prompt on ship day.

import type { SavedView } from "../../lib/prefs";

export function isViewApproved(
  view: Pick<SavedView, "id" | "version">,
  approvals: Readonly<Record<string, number>>,
): boolean {
  if (view.version === undefined) return true;
  return approvals[view.id] === view.version;
}
