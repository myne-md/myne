// SPDX-License-Identifier: AGPL-3.0-only
//! DPAPI, user-scoped, with the caller's entropy: the one implementation of the
//! Windows seal, used by both device-local key families.
//!
//! Two families keep a secret at rest on Windows and both need the same three
//! properties, so the seal exists once rather than twice: protection under the
//! current USER (never the machine, because a machine-scoped blob opens for every
//! account on the box), app entropy mixed in so another program running as the same
//! user cannot open it without knowing the string, and a plaintext that is wrapped in
//! `Zeroizing` before it can be copied anywhere else.
//!
//! **What differs per family is the entropy string, and that is the namespace.** The
//! device signing key and the label keys are different secrets with different
//! lifetimes, so a blob from one family must not open in the other even if it were
//! moved into the other's directory. Each caller passes its own constant; nothing
//! here decides it.
//!
//! Failure is a unit error rather than a taxonomy: DPAPI answers one bit (it worked
//! or it did not) and every caller reduces that to its own bounded backend variant.

/// Protect `plaintext` for the current user, with `entropy` mixed in.
pub fn protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ()> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(plaintext.len()).map_err(|_| ())?,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(entropy.len()).map_err(|_| ())?,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: both input blobs point at live slices for the duration of the call, the
    // output blob is a local, and no prompt struct is passed. `CRYPTPROTECT_LOCAL_MACHINE`
    // is deliberately absent so the protection is user-scoped.
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(),
            &entropy_blob,
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(());
    }
    // SAFETY: a successful call hands back a buffer DPAPI allocated with `LocalAlloc`,
    // which the caller owns and frees with `LocalFree`.
    let sealed = unsafe {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData.cast());
        bytes
    };
    Ok(sealed)
}

/// Unprotect a blob this user and this entropy sealed.
pub fn unprotect(sealed: &[u8], entropy: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, ()> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(sealed.len()).map_err(|_| ())?,
        pbData: sealed.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(entropy.len()).map_err(|_| ())?,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: as in `protect`.
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            &entropy_blob,
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(());
    }
    // SAFETY: as in `protect`. The plaintext is wrapped in `Zeroizing` before it can be
    // copied anywhere else, so the secret is not left in a dropped `Vec`.
    let plaintext = unsafe {
        let bytes = zeroize::Zeroizing::new(
            std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec(),
        );
        // DPAPI hands back a SECOND live plaintext buffer, and the allocator would free it
        // without clearing. Wipe it before handing the copy back. This line was carried by
        // the device-key store alone until the seal was shared, and losing it in the move
        // would have un-protected both families silently, since no lane here compiles DPAPI.
        std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
        LocalFree(out.pbData.cast());
        bytes
    };
    Ok(plaintext)
}
