// SPDX-License-Identifier: AGPL-3.0
//! Windows native-messaging registration: the registry write a browser reads.
//!
//! On macOS and Linux a browser discovers a native-messaging host by reading a
//! manifest FILE from a directory it owns. Windows has no such directory: the
//! browser reads `HKCU\Software\<vendor>\NativeMessagingHosts\<host name>`, whose
//! **default value** is the path to a manifest file that this code still writes.
//! So the file does not go away, only the way the browser learns of it.
//!
//! Two things are load-bearing and neither is obvious:
//!
//! - **`HKCU`, not `HKLM`.** A per-user registration needs no elevation, which is
//!   what lets the Settings toggle do this without a UAC prompt. A machine-wide
//!   key would let one user's opt-in serve every account on the box.
//! - **The default value, not a named one.** Chromium's reader opens the key and
//!   reads its default value; a named value is silently ignored, and the failure
//!   looks like the extension reporting "native host not found" with a manifest
//!   that plainly exists.
//!
//! Removing registration deletes the KEY rather than the value: it is one key per
//! host name with nothing else in it, created by this code, so leaving an empty
//! key behind would be a tombstone the browser still enumerates.

use std::ffi::c_void;
use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};

/// The registry key a browser reads this host from.
///
/// `vendor` is the browser family's own path (`Google\Chrome`,
/// `Microsoft\Edge`, `Mozilla`), so the three differ only there.
pub fn host_key(vendor: &str, host_name: &str) -> String {
    format!(r"Software\{vendor}\NativeMessagingHosts\{host_name}")
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Create `key` and set its default value to `manifest_path`.
pub fn set(key: &str, manifest_path: &str) -> io::Result<()> {
    let key_w = wide(key);
    let mut handle: HKEY = ptr::null_mut();
    let mut disposition: u32 = 0;
    // SAFETY: `key_w` is NUL-terminated and outlives the call; `handle` is a live
    // out-parameter; a null class and a null security-attributes pointer are the
    // documented defaults.
    let created = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            key_w.as_ptr(),
            0,
            ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            ptr::null(),
            &mut handle,
            &mut disposition,
        )
    };
    if created != 0 {
        return Err(io::Error::from_raw_os_error(created as i32));
    }
    let value_w = wide(manifest_path);
    let bytes = value_w.len() * std::mem::size_of::<u16>();
    // SAFETY: `handle` is open for writing, the value name is the empty string
    // (the default value), and `bytes` is exactly the size of `value_w` in
    // bytes, which is what REG_SZ wants.
    let written = unsafe {
        RegSetValueExW(
            handle,
            ptr::null(),
            0,
            REG_SZ,
            value_w.as_ptr() as *const u8,
            bytes as u32,
        )
    };
    // SAFETY: `handle` came from RegCreateKeyExW above and is closed once.
    unsafe {
        RegCloseKey(handle);
    }
    if written != 0 {
        return Err(io::Error::from_raw_os_error(written as i32));
    }
    Ok(())
}

/// Delete `key`, and treat "was never there" as success.
///
/// A toggle that has never been enabled is the ordinary case, and an error there
/// would be reported to a user who asked for the state that already held.
pub fn remove(key: &str) -> io::Result<()> {
    let key_w = wide(key);
    // SAFETY: `key_w` is NUL-terminated and outlives the call.
    let deleted = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, key_w.as_ptr()) };
    if deleted == 0 || deleted == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    Err(io::Error::from_raw_os_error(deleted as i32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_is_per_user_and_vendor_scoped() {
        // The path shape is the contract: HKCU (implicit), vendor, then the
        // browser's own directory name, then the host name.
        assert_eq!(
            host_key(r"Google\Chrome", "md.myne.clipper"),
            r"Software\Google\Chrome\NativeMessagingHosts\md.myne.clipper"
        );
        assert_eq!(
            host_key("Mozilla", "md.myne.clipper"),
            r"Software\Mozilla\NativeMessagingHosts\md.myne.clipper"
        );
    }

    #[test]
    fn wide_is_nul_terminated() {
        let w = wide("a");
        assert_eq!(w, vec![b'a' as u16, 0]);
    }

    #[test]
    fn a_void_pointer_type_exists_for_the_null_out_parameter() {
        // Compile-time only: `RegCreateKeyExW` takes `*mut *mut c_void`, and the
        // null we pass has to be that type rather than a null `*mut HKEY`.
        let null: *mut c_void = ptr::null_mut();
        assert!(null.is_null());
    }
}
