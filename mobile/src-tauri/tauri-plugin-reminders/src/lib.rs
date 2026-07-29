// SPDX-License-Identifier: AGPL-3.0
//! In-repo local-notification scheduler for task reminders (MYND-619, task 1).
//!
//! **This crate is a transport, not a policy.** The decision about *which*
//! reminders should be registered right now is the pure TypeScript core
//! (`runReminderPass` / `targetReminders` / `diffReminders`, MYND-618 task 3);
//! this plugin only hands the operating system what that core computed and
//! reports back what the OS says it is holding. Keeping the policy above the
//! seam is what lets one model cover all four platforms.
//!
//! ## Surface
//!
//! Six WebView-facing commands. The first four mirror the desktop
//! `ReminderNotifier` interface one-for-one plus the cancel-all the lifecycle
//! table needs; the last two are the desktop `ReminderPermissionApi`, which
//! mobile has to satisfy because on iOS an unauthorized `add` succeeds and then
//! delivers nothing:
//!
//! | command             | purpose                                           |
//! |---------------------|---------------------------------------------------|
//! | `schedule`          | register one reminder at one instant              |
//! | `cancel`            | drop one registration by id                       |
//! | `cancel_all`        | drop every registration this app made             |
//! | `list_pending`      | what the OS reports as still pending              |
//! | `permission_status` | what the platform currently allows                |
//! | `request_permission`| show the platform dialog, once                    |
//!
//! ## What crosses the boundary — and what deliberately does not
//!
//! A registration is `{ id, at }` and **nothing else**. Everything placed here
//! is written into the platform's own persistence (and, on Android, into a
//! pending intent), which is plaintext storage outside the AEAD envelope
//! (`threat-model.md` §7). So no note identifier, no task text and no title
//! crosses this seam: the **body is content-free and is owned by the native
//! side**, which is the strongest available reading of that posture — task text
//! cannot reach the OS store through this plugin at all, and any future opt-in
//! that changes that has to be an explicit, reviewable change *here*.
//!
//! `at` is a **local wall-clock** instant, `YYYY-MM-DDTHH:MM`, passed through
//! verbatim: no UTC offset and no IANA zone identifier is ever stored, matching
//! `decisions.md` 2026-07-2x (task dates are local wall-clock; an offset keeps a
//! coarse geolocation datum out of a file that gets exported as plaintext). The
//! native half parses it into local calendar components; this crate does no
//! date arithmetic, so there is no second place for a timezone bug to live.
//!
//! ## Platform state
//!
//! **iOS is implemented** (task 2): `UNUserNotificationCenter`, one
//! `UNCalendarNotificationTrigger` per reminder, no repeating trigger, no push
//! service, no background refresh. **Android is still the skeleton** (task 3):
//! its methods answer [`Error::Unimplemented`] rather than a fake success, which
//! would be worse — the reconciliation pass would believe a registration exists.
//! Off iOS/Android (the macOS dev host) every command answers
//! [`Error::Unsupported`], so the crate still compiles and `cargo check`s
//! everywhere.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_reminders);

/// Java package of the committed Kotlin plugin class (its `class_name` is
/// `RemindersPlugin`). Distinct from the app id `md.myne.mobile`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "md.myne.reminders";

/// One reminder as it is handed to the operating system.
///
/// Deliberately two fields. See the module comment: everything here lands in
/// OS-owned plaintext, so `id` is opaque to this crate and `at` is a local
/// wall-clock instant with no zone attached.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReminderPayload {
    /// Opaque registration identifier. This crate never parses or interprets it.
    pub id: String,
    /// Local wall-clock instant, `YYYY-MM-DDTHH:MM`.
    pub at: String,
}

/// One reminder as the operating system reports it back.
///
/// Structurally identical to [`ReminderPayload`] on purpose: the reconciliation
/// diff compares the registered set against the target set field-for-field, so a
/// divergence between the two shapes would show up as permanent spurious churn.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PendingReminder {
    pub id: String,
    pub at: String,
}

/// `cancel` bridge argument.
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Serialize)]
struct CancelArgs {
    id: String,
}

/// `list_pending` bridge response. `#[serde(default)]` so a native side that
/// holds nothing may answer `{}` rather than `{"pending": []}`.
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Deserialize)]
struct ListPendingResponse {
    #[serde(default)]
    pending: Vec<PendingReminder>,
}

/// `setTapHandler` bridge argument — hands the native side the delivery channel
/// (the `tauri-plugin-deep-link` / `share-intent` `setEventHandler` precedent).
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetTapHandlerArgs {
    handler: tauri::ipc::Channel,
}

/// One tapped reminder, as the native halves deliver it and as it is re-emitted
/// to the WebView.
///
/// **One field, and it is the opaque registration identifier.** There is no note
/// identifier or task text in a registration to begin with, so there is none
/// here — the payload cannot carry what was never put in it.
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Serialize, Deserialize, Clone)]
struct ReminderTapPayload {
    id: String,
}

/// Permission bridge response. The value is passed through as a plain string
/// rather than typed here: this crate is a transport, and the caller — the
/// desktop `requestReminderPermission` flow — already treats anything it does
/// not recognise as `unavailable`, which is the honest reading of an answer we
/// cannot interpret.
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Deserialize)]
struct PermissionResponse {
    status: String,
}

/// Failure surface for every command, serialized to the WebView.
///
/// The TypeScript notifier treats **every** failure the same way — it counts it
/// and lets the next pass retry, because the pass recomputes the target set
/// from scratch. So these variants exist for diagnosis, not for branching.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum Error {
    /// The host holds no scheduling surface at all (the macOS dev host). Not an
    /// error state for the user: the desktop client has its own adapters.
    #[error("scheduled reminders are not supported on this platform")]
    Unsupported,
    /// The platform half exists but its scheduling logic has not landed yet
    /// (MYND-619 tasks 2 and 3). Distinct from [`Error::Unsupported`] so a
    /// device log tells the two apart at a glance.
    #[error("the platform reminder scheduler is not implemented yet")]
    Unimplemented,
    /// The native scheduler refused the operation (permission revoked, the
    /// platform's pending-registration cap, a transient failure).
    #[error("reminder scheduling failed: {0}")]
    Plugin(String),
}

/// The managed plugin state. On iOS/Android it holds the native plugin handle;
/// elsewhere it is a zero-sized marker so every command can answer
/// [`Error::Unsupported`].
pub struct Reminders<R: Runtime> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    handle: tauri::plugin::PluginHandle<R>,
    // `fn() -> R` keeps `Reminders<R>: Send + Sync` regardless of R's own
    // auto-traits (a bare `PhantomData<R>` would demand `R: Send + Sync` at
    // `app.manage`).
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Reminders<R> {
    /// Register one reminder at one instant.
    pub fn schedule(&self, reminder: ReminderPayload) -> Result<(), Error> {
        self.bridge_unit("schedule", reminder)
    }

    /// Drop one registration by id. Cancelling something the OS is not holding
    /// is a no-op, never an error — the reconciliation pass cancels first and
    /// must survive a set that drifted underneath it.
    pub fn cancel(&self, id: String) -> Result<(), Error> {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            self.bridge_unit("cancel", CancelArgs { id })
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            let _ = id;
            Err(Error::Unsupported)
        }
    }

    /// Drop every registration this app made — the `setting-off`,
    /// `vault-delete` and `password-change` lifecycle action.
    pub fn cancel_all(&self) -> Result<(), Error> {
        self.bridge_unit("cancelAll", ())
    }

    /// What the OS reports as still pending.
    pub fn list_pending(&self) -> Result<Vec<PendingReminder>, Error> {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            self.handle
                .run_mobile_plugin::<ListPendingResponse>("listPending", ())
                .map(|r| r.pending)
                .map_err(|e| classify_bridge_error(e.to_string()))
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            Err(Error::Unsupported)
        }
    }

    /// How precisely this device will deliver a reminder right now.
    ///
    /// Android-only in substance: `"exact"` or `"approximate"` depending on the
    /// precise-alarm permission. Everywhere else the answer is
    /// **`"not-applicable"`** — not an error, because there is nothing missing:
    /// iOS delivers at the requested instant and has no such permission to hold.
    /// Answering `Unsupported` here would push a settings surface into showing an
    /// error where the honest content is "this does not apply to your phone".
    pub fn exact_alarm_status(&self) -> Result<String, Error> {
        #[cfg(target_os = "android")]
        {
            self.bridge_permission("exactAlarmStatus")
        }
        #[cfg(not(target_os = "android"))]
        {
            Ok(EXACTNESS_NOT_APPLICABLE.to_string())
        }
    }

    /// Open the platform's precise-alarm settings screen.
    ///
    /// A no-op off Android, and a no-op below Android 12 where an exact alarm
    /// needs no permission. **Nothing is consumed by calling it** — it opens a
    /// settings screen rather than a one-shot dialog — so there is no prompt to
    /// waste and nothing to re-prompt. The app never calls it on its own.
    pub fn request_exact_alarm(&self) -> Result<(), Error> {
        #[cfg(target_os = "android")]
        {
            self.bridge_unit("requestExactAlarm", ())
        }
        #[cfg(not(target_os = "android"))]
        {
            Ok(())
        }
    }

    /// What the platform currently allows. An unauthorized `add` on iOS
    /// SUCCEEDS and then delivers nothing, so this is not an optional nicety —
    /// without it "the reminder fires while the app is closed" fails silently.
    pub fn permission_status(&self) -> Result<String, Error> {
        self.bridge_permission("permissionStatus")
    }

    /// Show the platform dialog. The OS grants exactly one automatic prompt, so
    /// the *when* is decided above the seam (`requestReminderPermission`: at the
    /// first reminder, after an in-app explanation, marked before the ask).
    pub fn request_permission(&self) -> Result<String, Error> {
        self.bridge_permission("requestPermission")
    }

    #[allow(unused_variables)]
    fn bridge_permission(&self, method: &str) -> Result<String, Error> {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            self.handle
                .run_mobile_plugin::<PermissionResponse>(method, ())
                .map(|r| r.status)
                .map_err(|e| classify_bridge_error(e.to_string()))
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            Err(Error::Unsupported)
        }
    }

    /// One bridge call whose native side resolves with no payload.
    #[allow(unused_variables)]
    fn bridge_unit<A: Serialize>(&self, method: &str, args: A) -> Result<(), Error> {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            self.handle
                .run_mobile_plugin::<()>(method, args)
                .map_err(|e| classify_bridge_error(e.to_string()))
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            Err(Error::Unsupported)
        }
    }
}

/// Map a native bridge failure's text onto [`Error`].
///
/// The native halves reject with the sentinel below until tasks 2 and 3 land;
/// it is re-typed here so the WebView sees "not implemented yet" rather than a
/// string that reads like a device fault. Takes the already-stringified message
/// rather than the bridge's error type, so this crate does not name a
/// `tauri::plugin::mobile` type that only exists on mobile targets.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn classify_bridge_error(text: String) -> Error {
    if text.contains(UNIMPLEMENTED_SENTINEL) {
        Error::Unimplemented
    } else {
        Error::Plugin(text)
    }
}

/// The exact string the iOS and Android skeletons reject with. Changing it
/// requires changing both native halves in the same edit — which is why it is
/// spelled out here rather than pattern-matched loosely.
#[cfg(any(target_os = "ios", target_os = "android"))]
const UNIMPLEMENTED_SENTINEL: &str = "myne.reminders.unimplemented";

/// Delivery precision on a platform that has no precise-alarm permission at all.
/// A fact, not a failure — see [`Reminders::exact_alarm_status`].
pub const EXACTNESS_NOT_APPLICABLE: &str = "not-applicable";

/// Extension trait so callers reach the plugin as `app.reminders()`.
pub trait RemindersExt<R: Runtime> {
    fn reminders(&self) -> &Reminders<R>;
}

impl<R: Runtime, T: Manager<R>> RemindersExt<R> for T {
    fn reminders(&self) -> &Reminders<R> {
        self.state::<Reminders<R>>().inner()
    }
}

// The four commands are `async` for a load-bearing reason on Android: a SYNC
// command runs on the Android MAIN thread, and `run_mobile_plugin` posts through
// the main pipe and parks on `recv` — calling it from the main thread deadlocks
// (the same contract `screen_guard::ScreenGuard::set_secure` documents). An
// `async` command is spawned on the async runtime instead, so the bridge call
// never originates on the thread that has to service it. Do not "simplify" these
// to sync commands.

#[tauri::command]
async fn schedule<R: Runtime>(app: AppHandle<R>, reminder: ReminderPayload) -> Result<(), Error> {
    app.reminders().schedule(reminder)
}

#[tauri::command]
async fn cancel<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), Error> {
    app.reminders().cancel(id)
}

#[tauri::command]
async fn cancel_all<R: Runtime>(app: AppHandle<R>) -> Result<(), Error> {
    app.reminders().cancel_all()
}

#[tauri::command]
async fn list_pending<R: Runtime>(app: AppHandle<R>) -> Result<Vec<PendingReminder>, Error> {
    app.reminders().list_pending()
}

#[tauri::command]
async fn permission_status<R: Runtime>(app: AppHandle<R>) -> Result<String, Error> {
    app.reminders().permission_status()
}

#[tauri::command]
async fn request_permission<R: Runtime>(app: AppHandle<R>) -> Result<String, Error> {
    app.reminders().request_permission()
}

#[tauri::command]
async fn exact_alarm_status<R: Runtime>(app: AppHandle<R>) -> Result<String, Error> {
    app.reminders().exact_alarm_status()
}

#[tauri::command]
async fn request_exact_alarm<R: Runtime>(app: AppHandle<R>) -> Result<(), Error> {
    app.reminders().request_exact_alarm()
}

/// Register the plugin. On iOS/Android it binds the native `RemindersPlugin`;
/// elsewhere it registers the command surface with an unsupported-returning
/// state, so `lib.rs` stays free of per-target `cfg`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("reminders")
        .invoke_handler(tauri::generate_handler![
            schedule,
            cancel,
            cancel_all,
            list_pending,
            permission_status,
            request_permission,
            exact_alarm_status,
            request_exact_alarm
        ])
        .setup(|app, api| {
            let state = build_state(&api)?;
            #[cfg(any(target_os = "ios", target_os = "android"))]
            wire_tap_channel(app, &state)?;
            app.manage(state);
            Ok(())
        })
        .build()
}

/// Bridge the native tap channel to a global `reminder-tap` event.
///
/// The deep-link pattern verbatim: `setTapHandler` only stores the channel and
/// resolves immediately — no main-thread work — so calling it from `setup` is
/// safe on both platforms.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn wire_tap_channel<R: Runtime>(
    app: &AppHandle<R>,
    state: &Reminders<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        ipc::{Channel, InvokeResponseBody},
        Emitter,
    };

    let app_handle = app.clone();
    state.handle.run_mobile_plugin::<()>(
        "setTapHandler",
        SetTapHandlerArgs {
            handler: Channel::new(move |event| {
                if let InvokeResponseBody::Json(payload) = event {
                    if let Ok(tap) = serde_json::from_str::<ReminderTapPayload>(&payload) {
                        let _ = app_handle.emit("reminder-tap", tap);
                    }
                }
                Ok(())
            }),
        },
    )?;
    Ok(())
}

#[cfg(target_os = "ios")]
fn build_state<R: Runtime>(
    api: &PluginApi<R, ()>,
) -> Result<Reminders<R>, Box<dyn std::error::Error>> {
    let handle = api.register_ios_plugin(init_plugin_reminders)?;
    Ok(Reminders { handle })
}

#[cfg(target_os = "android")]
fn build_state<R: Runtime>(
    api: &PluginApi<R, ()>,
) -> Result<Reminders<R>, Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "RemindersPlugin")?;
    Ok(Reminders { handle })
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn build_state<R: Runtime>(
    _api: &PluginApi<R, ()>,
) -> Result<Reminders<R>, Box<dyn std::error::Error>> {
    Ok(Reminders {
        _marker: std::marker::PhantomData,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The two shapes are compared field-for-field by the reconciliation diff, so
    // a divergence would surface as permanent spurious churn rather than as a
    // compile error. Pin the wire form of both.
    #[test]
    fn payload_and_pending_share_one_wire_shape() {
        let payload = ReminderPayload {
            id: "r-1".into(),
            at: "2026-08-01T09:00".into(),
        };
        let pending = PendingReminder {
            id: "r-1".into(),
            at: "2026-08-01T09:00".into(),
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            serde_json::to_string(&pending).unwrap(),
        );
    }

    // Everything in a registration lands in OS-owned plaintext, so the wire form
    // is a privacy property: exactly two keys, no title, no body, no note id.
    // Pinned as the whole serialization rather than as a key-set check, so an
    // added field fails here instead of passing a laxer assertion.
    #[test]
    fn a_registration_carries_nothing_but_id_and_instant() {
        let payload = ReminderPayload {
            id: "r-1".into(),
            at: "2026-08-01T09:00".into(),
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            r#"{"id":"r-1","at":"2026-08-01T09:00"}"#,
        );
    }

    // Off iOS/Android there is no scheduling surface, and saying so is the point:
    // a silent `Ok(())` would let the reconciliation pass believe a registration
    // exists. `Unsupported` and `Unimplemented` are distinct so a device log
    // tells "wrong platform" from "task 2/3 has not landed".
    #[test]
    fn the_two_absence_errors_are_distinguishable() {
        assert_ne!(Error::Unsupported.to_string(), Error::Unimplemented.to_string());
    }
}
