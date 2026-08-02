// Views feature toggle (Settings → Editor).
//
// A DEVICE-LOCAL UI preference (localStorage, like the display language) that
// gates the sidebar "Views" entry. Default OFF for a fresh vault; back-compat:
// counted ON when the vault already has saved views (so an existing views user
// keeps them). The EFFECTIVE state is `storedPref ?? hasViews`, computed at the
// use site (which knows the view count) — nothing derived is persisted, so the
// back-compat default tracks the live view count until the user flips the
// toggle explicitly.
//
// (Promoting this to a synced encrypted `vault.prefs` field is a later
// cross-stack change; device-local keeps it off the fragile MYP1 byte codec.)

const VIEWS_KEY = "myne.viewsEnabled";

/** Fired after {@link writeViewsEnabled} so open surfaces (sidebar + settings)
 *  re-read without prop threading. */
export const VIEWS_ENABLED_EVENT = "myne:views-enabled-changed";

/** The stored preference: `true` / `false` when the user has toggled it, `null`
 *  when untouched (→ derive from whether the vault has views). */
export function readViewsEnabledPref(): boolean | null {
  try {
    const v = localStorage.getItem(VIEWS_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

/** Persist the toggle + notify open surfaces. */
export function writeViewsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(VIEWS_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode — just won't persist */
  }
  window.dispatchEvent(new Event(VIEWS_ENABLED_EVENT));
}

/** Effective enabled state: the stored pref if set, else the back-compat default
 *  (`hasViews`). */
export function viewsEnabled(hasViews: boolean): boolean {
  return readViewsEnabledPref() ?? hasViews;
}
