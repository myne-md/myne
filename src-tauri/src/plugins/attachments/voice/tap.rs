// SPDX-License-Identifier: AGPL-3.0
//! macOS system-audio capture via a CoreAudio process tap
//! (myne-md/myne#789).
//!
//! A microphone hears the user; it does not hear the other participants of an
//! online meeting unless they happen to be on a speaker in a quiet room. The
//! system's own audio output does, and on macOS 14.2 and later that is
//! reachable without asking the user to install a virtual audio driver, through
//! a **CoreAudio process tap**.
//!
//! The shape, in order, because each step is a place this can fail:
//!
//! 1. A `CATapDescription` describing a private, stereo, system-wide tap.
//! 2. `AudioHardwareCreateProcessTap` turns it into an `AudioObjectID`.
//! 3. A **private aggregate device** whose only input is that tap. This is what
//!    makes the tap readable like an ordinary input device; it never touches
//!    the user's default input or output.
//! 4. `AudioDeviceCreateIOProcID` installs the callback that receives frames,
//!    and `AudioDeviceStart` begins delivery.
//!
//! **Why the FFI is hand-written.** `coreaudio-sys` binds
//! `CoreAudio/CoreAudio.h`, and the tap API lives in
//! `CoreAudio/AudioHardwareTapping.h`, which `CoreAudio.h` does not include and
//! which is guarded by `#ifdef __OBJC__` besides. So the tap symbols are absent
//! from the bindings, and the aggregate-device dictionary needs CoreFoundation
//! directly. Everything below is declared against the SDK the build already
//! uses, over `objc2` (already a direct dependency on macOS) and CoreFoundation
//! (already linked by every macOS binary), so **no new direct dependency is
//! added**.
//!
//! **The failure mode this is built around.** A tap created without the
//! system-audio recording permission does not fail: macOS delivers buffers,
//! **zeroed**. There is no public API to preflight or request that permission.
//! So this module's job is to be honest about what it can and cannot tell, and
//! the session's answer is the rolling per-source silence detector next door
//! (`super::silence`), which asks the only question that is answerable from
//! inside the process: is this stream silent while the microphone is not?
//!
//! **Verification.** The construction path is exercised by a test on a macOS
//! machine: it builds the description, creates the tap, creates the aggregate
//! device and tears all three down, asserting an OSStatus at each step. A wrong
//! selector raises an Objective-C exception naming it, and a wrong dictionary
//! key returns a status, so both are caught without a meeting. What no test here
//! can answer is whether real audio flows, because that needs another party
//! speaking: it is a manual-test item, and it is the feature's graduation gate.

use std::ffi::c_void;
use std::os::raw::c_char;
use std::sync::{Arc, Mutex};

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};

use super::capture::{AudioSource, RecordError};

// --- CoreFoundation, the narrow slice this needs ---------------------------

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type CFNumberRef = *const c_void;
type CFMutableDictionaryRef = *mut c_void;
type CFIndex = isize;

/// `kCFStringEncodingUTF8`, from `CFString.h`.
const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// `kCFNumberSInt32Type`, from `CFNumber.h`.
const CF_NUMBER_SINT32_TYPE: i32 = 3;

extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;

    fn CFStringCreateWithCString(
        allocator: CFTypeRef,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFDictionaryCreateMutable(
        allocator: CFTypeRef,
        capacity: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFMutableDictionaryRef;
    fn CFDictionarySetValue(dict: CFMutableDictionaryRef, key: CFTypeRef, value: CFTypeRef);
    fn CFArrayCreate(
        allocator: CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        callbacks: *const c_void,
    ) -> CFArrayRef;
    fn CFNumberCreate(allocator: CFTypeRef, the_type: i32, value_ptr: *const c_void)
        -> CFNumberRef;
    fn CFRelease(cf: CFTypeRef);
}

/// A `CFString` from a `&str`, returning a +1 reference the CALLER owns.
///
/// Every call site releases what it creates, after the dictionary or array has
/// retained it. An earlier version of this comment claimed the strings were
/// "leaked on purpose" while the code released them, which is the kind of
/// disagreement that gets a `cf_release` deleted by a reader who believes the
/// prose: state the real contract, which is create, hand over, release.
fn cf_string(s: &str) -> CFStringRef {
    let c = std::ffi::CString::new(s).expect("aggregate-device keys are literals");
    // SAFETY: a NUL-terminated UTF-8 C string and the documented UTF-8
    // encoding constant; the allocator is the default one.
    unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), CF_STRING_ENCODING_UTF8) }
}

fn cf_i32(v: i32) -> CFNumberRef {
    // SAFETY: `kCFNumberSInt32Type` reads exactly four bytes from the pointer.
    unsafe {
        CFNumberCreate(
            std::ptr::null(),
            CF_NUMBER_SINT32_TYPE,
            (&v as *const i32).cast(),
        )
    }
}

/// Release a CoreFoundation object this module created. `None` is a no-op, so
/// teardown can call it unconditionally on a half-built tap.
///
/// # Safety
/// `cf` must be an object this module created and not already released.
unsafe fn cf_release(cf: CFTypeRef) {
    if !cf.is_null() {
        CFRelease(cf);
    }
}

// --- CoreAudio HAL, the tap slice ------------------------------------------

/// `AudioObjectID` and friends are `UInt32` in `CoreAudioTypes.h`.
type AudioObjectID = u32;
/// `kAudioObjectUnknown`.
const AUDIO_OBJECT_UNKNOWN: AudioObjectID = 0;
/// `kAudioObjectPropertyScopeGlobal` ('glob').
const AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = 0x676C_6F62;
/// `kAudioObjectPropertyElementMain`.
const AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
/// `kAudioTapPropertyFormat` ('tfmt'), from `AudioHardwareTapping.h`.
const AUDIO_TAP_PROPERTY_FORMAT: u32 = 0x7466_6D74;

/// `kAudioFormatLinearPCM` ('lpcm').
const AUDIO_FORMAT_LINEAR_PCM: u32 = 0x6C70_636D;
/// `kAudioFormatFlagIsFloat`. The only sample representation `tap_io_proc`
/// reads, which is why the format is checked at construction rather than
/// assumed.
const AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;

/// The aggregate-device dictionary keys, verbatim from `AudioHardware.h`.
const KEY_AGGREGATE_UID: &str = "uid";
const KEY_AGGREGATE_NAME: &str = "name";
const KEY_AGGREGATE_IS_PRIVATE: &str = "private";
const KEY_AGGREGATE_TAP_LIST: &str = "taps";
const KEY_AGGREGATE_TAP_AUTOSTART: &str = "tapautostart";
const KEY_SUBTAP_UID: &str = "uid";
const KEY_SUBTAP_DRIFT_COMPENSATION: &str = "drift";

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

/// `AudioBufferList` is a variable-length struct: `mBuffers` is an array whose
/// real length is `mNumberBuffers`. Declaring one element and walking past it by
/// pointer arithmetic is the documented idiom.
#[repr(C)]
struct AudioBufferList {
    number_buffers: u32,
    buffers: [AudioBuffer; 1],
}

/// `OSStatus` is `SInt32`; `noErr` is 0.
type OSStatus = i32;

type AudioDeviceIOProc = extern "C" fn(
    device: AudioObjectID,
    now: *const c_void,
    input_data: *const AudioBufferList,
    input_time: *const c_void,
    output_data: *mut AudioBufferList,
    output_time: *const c_void,
    client_data: *mut c_void,
) -> OSStatus;

extern "C" {
    fn AudioHardwareCreateProcessTap(
        description: *mut AnyObject,
        out: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyProcessTap(tap: AudioObjectID) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(
        description: CFTypeRef,
        out: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(device: AudioObjectID) -> OSStatus;
    fn AudioObjectGetPropertyData(
        object: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_count: u32,
        qualifiers: *const c_void,
        io_size: *mut u32,
        out: *mut c_void,
    ) -> OSStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectID,
        proc: AudioDeviceIOProc,
        client_data: *mut c_void,
        out: *mut *mut c_void,
    ) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(device: AudioObjectID, proc_id: *mut c_void) -> OSStatus;
    fn AudioDeviceStart(device: AudioObjectID, proc_id: *mut c_void) -> OSStatus;
    fn AudioDeviceStop(device: AudioObjectID, proc_id: *mut c_void) -> OSStatus;
}

// --- the source -------------------------------------------------------------

/// System audio as an [`AudioSource`].
///
/// `!Send` like every source: it owns HAL object ids and a live IOProc, and it
/// is therefore built and driven inside the capture thread.
pub struct TapSource {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: *mut c_void,
    shared: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
}

/// Whether this machine can capture system audio at all.
///
/// macOS 14.2 is where `AudioHardwareCreateProcessTap` landed. The check is a
/// RUNTIME one on purpose: Myne does not adopt a new minimum macOS version for
/// one capture path, and an older machine runs the meeting session on the
/// microphone alone, which is the same shape Linux takes.
pub fn is_available() -> bool {
    // `operatingSystemVersionString` rather than `operatingSystemVersion`: the
    // latter returns a C struct, and returning one through `objc_msgSend`
    // requires an `Encode` impl this crate would have to hand-write and keep in
    // step with the platform ABI. The string is a plain object return, and the
    // value it carries is the same number.
    //
    // SAFETY: both are documented `NSProcessInfo` methods returning objects
    // this function does not retain.
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        if info.is_null() {
            return false;
        }
        let version: *mut AnyObject = msg_send![info, operatingSystemVersionString];
        if version.is_null() {
            return false;
        }
        let c: *const c_char = msg_send![version, UTF8String];
        if c.is_null() {
            return false;
        }
        parse_major_minor(&std::ffi::CStr::from_ptr(c).to_string_lossy())
    }
}

/// Parse the leading `major.minor` out of a version string such as
/// `"Version 14.2.1 (Build 23C64)"` and answer whether it reaches 14.2.
///
/// Separate from the Objective-C call so it is testable without a Mac, and
/// deliberately lenient: an unparseable string answers `false`, which is the
/// conservative direction, since a false `false` runs the session on the
/// microphone alone rather than offering a tap that cannot be created.
fn parse_major_minor(s: &str) -> bool {
    let mut parts = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty());
    let major: u32 = match parts.next().and_then(|p| p.parse().ok()) {
        Some(m) => m,
        None => return false,
    };
    let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    major > 14 || (major == 14 && minor >= 2)
}

impl TapSource {
    /// Create the tap, wrap it in a private aggregate device, and start
    /// delivery.
    pub fn start() -> Result<Self, RecordError> {
        if !is_available() {
            return Err(RecordError::CaptureFailed);
        }
        // SAFETY: every step is checked before the next depends on it, and the
        // partially built state is torn down on every failure path. The one
        // thing this cannot check is whether audio will actually arrive: a
        // denied permission yields a working tap that delivers silence, which
        // is what `super::silence` exists to notice.
        unsafe { Self::start_inner() }
    }

    unsafe fn start_inner() -> Result<Self, RecordError> {
        // 1. The description: a private, stereo, system-wide tap.
        let desc: *mut AnyObject = {
            let cls = class!(CATapDescription);
            let alloc: *mut AnyObject = msg_send![cls, alloc];
            if alloc.is_null() {
                return Err(RecordError::CaptureFailed);
            }
            let empty: *mut AnyObject = msg_send![class!(NSArray), array];
            let desc: *mut AnyObject =
                msg_send![alloc, initStereoGlobalTapButExcludeProcesses: empty];
            if desc.is_null() {
                return Err(RecordError::CaptureFailed);
            }
            // A tap other applications can see would be a system-wide audio
            // route they could enumerate. Private keeps it inside this process.
            //
            // The setter is `setPrivate:`, NOT `setPrivateTap:`, even though
            // the property is `privateTap`. `CATapDescription.h` declares it
            // `@property (atomic, readwrite, getter=isPrivate,
            // setter=setPrivate:) BOOL privateTap;`, and the first version of
            // this line guessed from the property name and aborted the process
            // with an unrecognized-selector exception. That is exactly what
            // `the_construction_path_reaches_the_hal` exists to catch.
            let _: () = msg_send![desc, setPrivate: true];
            desc
        };

        // 2. The tap itself.
        let mut tap: AudioObjectID = AUDIO_OBJECT_UNKNOWN;
        let status = AudioHardwareCreateProcessTap(desc, &mut tap);
        if status != 0 || tap == AUDIO_OBJECT_UNKNOWN {
            tracing::warn!(stage = "meeting_tap", status, "process tap creation failed");
            let _: () = msg_send![desc, release];
            return Err(RecordError::CaptureFailed);
        }

        // 3. The aggregate device, whose only input is the tap. Its UID must be
        // unique per tap, and the tap's own UUID is what ties the two together.
        let uuid: *mut AnyObject = msg_send![desc, UUID];
        let uuid_string: *mut AnyObject = msg_send![uuid, UUIDString];
        let uuid_c: *const c_char = msg_send![uuid_string, UTF8String];
        let uuid_rust = if uuid_c.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(uuid_c)
                .to_string_lossy()
                .into_owned()
        };
        let _: () = msg_send![desc, release];

        let aggregate = match Self::create_aggregate(&uuid_rust) {
            Ok(id) => id,
            Err(e) => {
                AudioHardwareDestroyProcessTap(tap);
                return Err(e);
            }
        };

        // 4. The stream format, so the callback can interpret the bytes.
        let mut format = AudioStreamBasicDescription::default();
        let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
        let address = AudioObjectPropertyAddress {
            selector: AUDIO_TAP_PROPERTY_FORMAT,
            scope: AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let status = AudioObjectGetPropertyData(
            tap,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut format as *mut AudioStreamBasicDescription).cast(),
        );
        if status != 0 || format.sample_rate <= 0.0 {
            tracing::warn!(stage = "meeting_tap", status, "tap format query failed");
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            return Err(RecordError::CaptureFailed);
        }
        if !format_is_supported(format.format_flags, format.format_id) {
            // The callback reads the buffer as `f32`. Anything else here would
            // be decoded as noise that sounds like a working tap.
            tracing::warn!(
                stage = "meeting_tap",
                format_id = format.format_id,
                format_flags = format.format_flags,
                "tap reports a format the callback cannot read"
            );
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            return Err(RecordError::CaptureFailed);
        }
        let sample_rate = format.sample_rate.round() as u32;
        // The same window the decoder accepts. A tap reporting outside it would
        // produce a clip this application refuses, which is the invariant
        // `capture.rs` states as a construction.
        if !(crate::audio_rate::MIN_SAMPLE_RATE_HZ..=crate::audio_rate::MAX_SAMPLE_RATE_HZ)
            .contains(&sample_rate)
        {
            tracing::warn!(
                stage = "meeting_tap",
                sample_rate,
                "tap reports a rate outside the decodable window"
            );
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            return Err(RecordError::UnsupportedSampleRate);
        }

        // 5. The callback, and start.
        let shared: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::as_ptr(&shared) as *mut c_void;
        let mut proc_id: *mut c_void = std::ptr::null_mut();
        let status = AudioDeviceCreateIOProcID(aggregate, tap_io_proc, client, &mut proc_id);
        if status != 0 || proc_id.is_null() {
            tracing::warn!(stage = "meeting_tap", status, "IOProc creation failed");
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            return Err(RecordError::CaptureFailed);
        }
        let status = AudioDeviceStart(aggregate, proc_id);
        if status != 0 {
            tracing::warn!(
                stage = "meeting_tap",
                status,
                "aggregate device start failed"
            );
            AudioDeviceDestroyIOProcID(aggregate, proc_id);
            AudioHardwareDestroyAggregateDevice(aggregate);
            AudioHardwareDestroyProcessTap(tap);
            return Err(RecordError::CaptureFailed);
        }

        tracing::debug!(stage = "meeting_tap", event = "started");
        Ok(Self {
            tap,
            aggregate,
            proc_id,
            shared,
            sample_rate,
        })
    }

    /// Build and create the private aggregate device that carries the tap.
    ///
    /// The dictionary is CoreFoundation rather than `objc2-foundation`: these
    /// are plain CF types, the HAL reads them as CF, and bridging through
    /// Objective-C would add a conversion with no benefit.
    unsafe fn create_aggregate(tap_uuid: &str) -> Result<AudioObjectID, RecordError> {
        let dict = CFDictionaryCreateMutable(
            std::ptr::null(),
            0,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        );
        if dict.is_null() {
            return Err(RecordError::CaptureFailed);
        }
        // The sub-tap entry: which tap this aggregate carries, and whether to
        // compensate for drift between it and the device clock. Compensation is
        // on because a long meeting's tap and its host device WILL drift.
        let subtap = CFDictionaryCreateMutable(
            std::ptr::null(),
            0,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        );
        if subtap.is_null() {
            cf_release(dict);
            return Err(RecordError::CaptureFailed);
        }
        let subtap_uid_key = cf_string(KEY_SUBTAP_UID);
        let subtap_uid_value = cf_string(tap_uuid);
        let drift_key = cf_string(KEY_SUBTAP_DRIFT_COMPENSATION);
        let drift_value = cf_i32(1);
        CFDictionarySetValue(subtap, subtap_uid_key, subtap_uid_value);
        CFDictionarySetValue(subtap, drift_key, drift_value);
        cf_release(subtap_uid_key);
        cf_release(subtap_uid_value);
        cf_release(drift_key);
        cf_release(drift_value);

        let tap_list = CFArrayCreate(
            std::ptr::null(),
            (&subtap as *const CFMutableDictionaryRef).cast(),
            1,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        );
        cf_release(subtap);
        if tap_list.is_null() {
            cf_release(dict);
            return Err(RecordError::CaptureFailed);
        }

        let uid_key = cf_string(KEY_AGGREGATE_UID);
        let uid_value = cf_string(tap_uuid);
        let name_key = cf_string(KEY_AGGREGATE_NAME);
        let name_value = cf_string("Myne meeting tap");
        let private_key = cf_string(KEY_AGGREGATE_IS_PRIVATE);
        let autostart_key = cf_string(KEY_AGGREGATE_TAP_AUTOSTART);
        let tap_list_key = cf_string(KEY_AGGREGATE_TAP_LIST);

        CFDictionarySetValue(dict, uid_key, uid_value);
        CFDictionarySetValue(dict, name_key, name_value);
        CFDictionarySetValue(dict, private_key, kCFBooleanTrue);
        CFDictionarySetValue(dict, autostart_key, kCFBooleanTrue);
        CFDictionarySetValue(dict, tap_list_key, tap_list);

        for key in [
            uid_key,
            uid_value,
            name_key,
            name_value,
            private_key,
            autostart_key,
            tap_list_key,
            tap_list,
        ] {
            cf_release(key);
        }

        let mut device: AudioObjectID = AUDIO_OBJECT_UNKNOWN;
        let status = AudioHardwareCreateAggregateDevice(dict, &mut device);
        cf_release(dict);
        if status != 0 || device == AUDIO_OBJECT_UNKNOWN {
            tracing::warn!(
                stage = "meeting_tap",
                status,
                "aggregate device creation failed"
            );
            return Err(RecordError::CaptureFailed);
        }
        Ok(device)
    }
}

impl Drop for TapSource {
    fn drop(&mut self) {
        // Reverse order of construction, and best-effort throughout: a failure
        // here means a HAL object outlives the session, which is exactly what
        // the teardown path exists to prevent, so it is worth a log line.
        // SAFETY: the ids are this struct's own and are released exactly once.
        unsafe {
            let status = AudioDeviceStop(self.aggregate, self.proc_id);
            if status != 0 {
                tracing::warn!(stage = "meeting_tap", status, "device stop failed");
            }
            AudioDeviceDestroyIOProcID(self.aggregate, self.proc_id);
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            AudioHardwareDestroyProcessTap(self.tap);
        }
        tracing::debug!(stage = "meeting_tap", event = "stopped");
    }
}

impl AudioSource for TapSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn poll(&mut self) -> Vec<i16> {
        // `append` rather than `mem::take`: the IOProc is a realtime callback,
        // and `take` replaced the shared buffer with a fresh empty `Vec`, so the
        // next callback's `push` re-allocated on the audio thread. Appending
        // leaves the producer's capacity alone.
        let mut out = Vec::new();
        match self.shared.lock() {
            Ok(mut buf) => out.append(&mut buf),
            // A poisoned lock means the callback panicked, which it cannot do:
            // every operation in it is a read plus a push. Recovering the inner
            // value rather than propagating keeps a meeting recording instead
            // of ending it.
            Err(poisoned) => out.append(&mut poisoned.into_inner()),
        }
        out
    }

    // No `tap_level` override, deliberately. `SourceFactory::Meeting` always
    // wraps this in a `MixSource`, which records the tap's peak from the RAW
    // poll and reports it, and `run_session` asks only the top-level source. An
    // override here would be unreachable, and if it ever were reached it would
    // answer `Some(0.0)`: `poll` has already drained the buffer by then, so the
    // silence detector would warn about a perfectly working tap after twenty
    // seconds of speech.
}

/// The HAL callback. Runs on a realtime thread, so it does as little as
/// possible: downmix to mono `i16`, push into the shared buffer, return.
///
/// No allocation happens outside the push, no lock is held across anything but
/// the push, and nothing is logged: a realtime callback that blocks is a
/// dropped-audio bug that reads as "the tap is silent", which is the one
/// symptom this feature must not manufacture.
extern "C" fn tap_io_proc(
    _device: AudioObjectID,
    _now: *const c_void,
    input_data: *const AudioBufferList,
    _input_time: *const c_void,
    _output_data: *mut AudioBufferList,
    _output_time: *const c_void,
    client_data: *mut c_void,
) -> OSStatus {
    if input_data.is_null() || client_data.is_null() {
        return 0;
    }
    // SAFETY: the HAL hands us a well-formed `AudioBufferList` for the tap's
    // declared format, and `client_data` is the `Arc<Mutex<Vec<i16>>>` the
    // caller leaked a pointer to and keeps alive for the IOProc's lifetime.
    unsafe {
        let shared = &*(client_data as *const Mutex<Vec<i16>>);
        let list = &*input_data;
        let buffers = list.buffers.as_ptr();
        let mut ok = shared.try_lock();
        let Ok(buf) = ok.as_deref_mut() else {
            // Never block the realtime thread on the consumer. Dropping this
            // callback's frames is better than stalling the audio device.
            return 0;
        };
        for i in 0..list.number_buffers as usize {
            let b = &*buffers.add(i);
            if b.data.is_null() || b.data_byte_size == 0 {
                continue;
            }
            // The tap is created stereo-mixdown but the HAL may hand us either
            // layout, so the channel count decides: one buffer per channel is
            // non-interleaved, one buffer with N channels is interleaved.
            let channels = b.number_channels.max(1) as usize;
            let frames = b.data_byte_size as usize / (channels * 4);
            let samples = b.data as *const f32;
            for frame in 0..frames {
                let mut sum = 0.0f32;
                for ch in 0..channels {
                    sum += *samples.add(frame * channels + ch);
                }
                let mono = sum / channels as f32;
                buf.push((mono.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16);
            }
        }
    }
    0
}

/// Whether the tap's declared format is one `tap_io_proc` can read.
///
/// `tap_io_proc` reinterprets the buffer as `f32`, so this is not a nicety: a
/// tap that ever reported integer PCM would be read as floats and produce
/// noise that sounds exactly like a working microphone. Checked at
/// construction so the refusal is typed and loud.
fn format_is_supported(format_flags: u32, format_id: u32) -> bool {
    format_id == AUDIO_FORMAT_LINEAR_PCM && (format_flags & AUDIO_FORMAT_FLAG_IS_FLOAT) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_availability_check_answers_for_this_machine() {
        // Not an assertion about the machine: an assertion that the check RUNS
        // and returns, which is what a wrong `NSProcessInfo` selector would
        // turn into an Objective-C exception instead. The cross-check against
        // `sw_vers` is what makes it an assertion rather than a smoke test.
        let available = is_available();
        let expected = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| parse_major_minor(s.trim()));
        if let Some(expected) = expected {
            assert_eq!(
                available, expected,
                "the runtime check disagrees with sw_vers about macOS 14.2"
            );
        }
    }

    #[test]
    fn the_version_parser_reads_the_shapes_apple_actually_returns() {
        // The real string carries a prefix and a build suffix.
        assert!(parse_major_minor("Version 14.2.1 (Build 23C64)"));
        assert!(parse_major_minor("Version 15.0 (Build 24A335)"));
        assert!(!parse_major_minor("Version 14.1 (Build 23B74)"));
        assert!(!parse_major_minor("Version 13.6.7"));
        // A bare number, which `sw_vers -productVersion` returns.
        assert!(parse_major_minor("14.2"));
        assert!(!parse_major_minor("14"));
        // Unparseable is conservative: no tap offered rather than a tap that
        // cannot be created.
        assert!(!parse_major_minor(""));
        assert!(!parse_major_minor("unknown"));
    }

    /// The construction path against the real HAL.
    ///
    /// This is the validation the tap can have on a developer's machine: it
    /// builds the `CATapDescription`, creates the tap, creates the private
    /// aggregate device, queries the format, installs the IOProc and starts
    /// delivery, then tears all of it down. A wrong Objective-C selector raises
    /// an exception naming it, and a wrong aggregate-device key returns an
    /// OSStatus, so both are caught here without a meeting.
    ///
    /// `#[ignore]` because it is a deliberate exemption rather than a deferral:
    /// it is not waiting on a fix, it is waiting on a machine. Running it opens
    /// a real audio tap and, the first time, raises the system-audio recording
    /// permission prompt attributed to whatever launched the test. Run it by
    /// hand with `cargo test -p myne-desktop --lib tap -- --ignored`.
    #[test]
    #[ignore = "needs a real audio device and raises the system-audio permission prompt"]
    fn the_construction_path_reaches_the_hal() {
        if !is_available() {
            // Pre-14.2: there is nothing to reach, and the session runs on the
            // microphone alone by design.
            return;
        }
        match TapSource::start() {
            Ok(source) => {
                assert!(source.sample_rate() > 0, "a tap must declare a rate");
                // Dropping runs the full teardown: stop, destroy the IOProc,
                // destroy the aggregate device, destroy the tap.
                drop(source);
            }
            Err(e) => {
                // A refused tap is a legitimate outcome (no output device, or
                // the HAL declining without the permission). What would not be
                // legitimate is a panic, an unrecognized selector, or a hang,
                // and all three fail the test rather than reaching this arm.
                eprintln!("tap refused: {e:?}");
            }
        }
    }

    #[test]
    fn the_format_predicate_refuses_what_the_callback_cannot_read() {
        assert!(format_is_supported(
            AUDIO_FORMAT_FLAG_IS_FLOAT,
            AUDIO_FORMAT_LINEAR_PCM
        ));
        // Linear PCM but integer samples: the callback would read them as
        // floats and produce noise, which is the case this exists to refuse.
        assert!(!format_is_supported(0, AUDIO_FORMAT_LINEAR_PCM));
        // A compressed format entirely.
        assert!(!format_is_supported(
            AUDIO_FORMAT_FLAG_IS_FLOAT,
            0x6161_6320 // 'aac '
        ));
    }
}
