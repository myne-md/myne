# Myne Android Widgets (RemoteViews / AppWidget)

The Android mirror of [`ios-widgets/`](../ios-widgets/README.md): native widget
surfaces for the Myne mobile client. **Launchers only — no logic, no content.**
A committed `com.android.library` Gradle module kept outside the git-ignored
`src-tauri/gen/android` tree so it survives `tauri android init` regeneration.

## Design principle (load-bearing — with an Android caveat)

> The widget carries **no vault content** — no note titles, previews, counts,
> streaks, or timestamps. The set is launchers, one capture action, and a
> static "encrypted" badge. Richness here would be a leak.

On iOS this is a *structural* guarantee: the widget extension is a separate
sandboxed process that cannot reach the vault key. **Android has no separate
widget process** — RemoteViews are built by the app's own process and rendered
by the launcher — so here the same rule is enforced as *policy*: everything in
this module is a static layout bound to a `myne://` PendingIntent, nothing
touches vault state, and nothing refreshes on a timeline (`updatePeriodMillis`
is 0 everywhere). Keep it that way; recorded in the main repo
`docs/decisions.md` (2026-07-12, Android widget surfaces).

## Surface mapping (iOS → Android)

| iOS (`ios-widgets/`) | Here |
|---|---|
| WG-01 Open (systemSmall) | `OpenWidget` — 2×2, whole-tap → `myne://open` |
| WG-02 Quick capture S/M | `QuickCaptureWidget` — 2×2 small (whole-tap → `myne://capture`); resized ≥220dp swaps to the medium layout with per-view taps (`myne://capture` + `myne://capture?mode=voice`) |
| WG-03 Encrypted (systemSmall) | `EncryptedWidget` — 2×2 static badge |
| Lock-screen accessories + StandBy | No dedicated surface: the Android 16 QPR2 lock-screen hub hosts regular home widgets (we deliberately do NOT set `widgetCategory="not_keyguard"`) |
| Control Center control (iOS 18) | `NewNoteTileService` — Quick Settings tile → `myne://capture` |
| Action Button binding | Static app shortcuts (`res/xml/myne_shortcuts.xml`): launcher-icon long-press "New note" / "New voice note", pinnable |

The app-side half is identical to iOS: the URLs land in
`src/lib/deep-link.ts` (latch + `CAPTURE_EVENT`) and `EditorFlow` opens the
note / recording sheet after unlock. No JS changed for Android.

## Wiring — three layers, two of them automatic

1. **Deep-link intent-filter** — generated into the app manifest by the
   `plugins.deep-link.mobile` `scheme: ["myne"]` config in `tauri.conf.json`
   at `tauri android init` time. Nothing to re-apply.
2. **Manifest injections** — `src-tauri/build.rs` re-applies idempotently on
   every build (`tauri_utils::build::update_android_manifest`): the mic
   permissions block and the static-shortcuts `<meta-data>` on MainActivity
   (a library manifest cannot attach meta-data to the app's activity). The
   widget receivers + tile service need no injection: this module's own
   `AndroidManifest.xml` merges in via the Gradle manifest merger.

   That merge is also why this module carries **two non-widget attributes**:
   `android:dataExtractionRules` + `android:fullBackupContent` on `<application>`
   (with `res/xml/myne_backup_rules*.xml`), which keep the plaintext export
   directory out of Auto Backup and device transfer — myne-md/myne#491. They live
   here because `update_android_manifest` injects **child elements only** and
   cannot write an attribute, and because `src-tauri/gen/android` is git-ignored
   and re-clobbered by `tauri android init`. This module's manifest is the one
   committed, regeneration-surviving place an `<application>` attribute can come
   from. `scripts/check-mobile-export-backup.mjs` gates it.
3. **Gradle module wiring** — the ONLY re-apply step. `tauri android init`
   regenerates `settings.gradle` and `app/build.gradle.kts`, dropping the
   `myne-widgets` include + dependency. After a fresh init run:

   ```bash
   ./scripts/android-postinit.sh   # idempotent; safe to run any time
   ```

   Forgetting it fails the next build **loudly**: build.rs still injects the
   shortcuts `<meta-data>`, whose `@xml/myne_shortcuts` resource only exists
   when the module is wired — a deliberate fail-closed reminder, not a bug.

## Verification checklist (physical device)

Like the biometric quick-unlock checklist, the OS surface can only be verified
on a device; run after any change to this module:

1. All three widgets appear in the widget picker; light/dark follows the
   system theme (the `values-night` tokens).
2. Open widget, cold tap on a locked phone → app launches → unlock → no
   further action (launcher only).
3. Quick capture, cold tap → after unlock a fresh note opens (the latched
   intent replays on editor mount).
4. Quick capture, warm tap → a fresh note opens immediately (`CAPTURE_EVENT`).
5. Resize Quick capture wide → medium layout; mic button → fresh note + the
   recording sheet + the runtime mic permission prompt; the recording lands as
   an encrypted `audio/wav` attachment.
6. Quick Settings tile: add from the tile editor → tap → shade collapses,
   capture opens (keyguard first on a locked phone).
7. Launcher-icon long-press → both shortcuts fire (and survive pinning).
8. (Android 16 QPR2+) add a widget to the lock-screen hub; it renders and
   launches identically.

## Gotchas

- **RemoteViews view whitelist** — layouts here may only use RemoteViews-safe
  views. `Space` is NOT one of them; the empty `FrameLayout` spacers in the
  capture layouts are deliberate.
- **`android:tint`** (not `app:tint`) is the RemoteViews-safe way the icons
  are colored; the vectors' own fill/stroke is plain white as the tint base.
  The two shortcut icons hardcode light-ink instead — launchers rasterize
  shortcut icons once, so they cannot follow a theme.
- **Pre-31 pickers** ignore `previewLayout`/`targetCell*` and show the app
  icon as preview; harmless.
- **The QS tile on API < 34** uses the deprecated `startActivityAndCollapse(Intent)`
  overload — the PendingIntent variant does not exist below 34, and the Intent
  variant throws on 34+. Both branches are load-bearing.
