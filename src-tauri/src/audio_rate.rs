// The sample-rate window a WAV must fall in, owned by NEITHER the decoder nor
// the recorder.
//
// It belongs to both and to neither, which is why it is a crate-level module
// rather than a `pub` in `plugins::local_inference::audio`. `parse_wav` refuses
// anything outside this window, and `CpalSource::start` refuses to record
// outside it, so the invariant `docs/threat-model.md` and
// `docs/decisions/ai/0541` state as a construction -- no clip a Myne client
// records is refused by a Myne decoder -- is held by two sites reading ONE pair
// of constants rather than by two copies that agree today.
//
// Why not simply `pub` the decoder's copy, which was the first attempt: the
// whole `local_inference` module is behind a default feature, and the AI-free
// audit build (`cargo clippy -p myne-desktop --all-targets
// --no-default-features -- -D warnings`, CI step `desktop-ai-free`) compiles it
// out. The recorder is NOT feature-gated -- an AI-free build still records voice
// notes, and those clips sync to a device that does transcribe them, which is
// the same reasoning the per-rate length clamp already rests on. So the
// recorder cannot reach into the decoder, and a private copy on the recorder
// side would be the drift this module exists to make impossible.
//
// The values themselves: 4 kHz is below every real capture path including
// telephony and Bluetooth HFP/SCO at 8 kHz, and 384 kHz is above every
// professional interface. They are a sanity window on a header field an
// attacker controls, not a statement about hardware.

/// Lowest sample rate `parse_wav` accepts and `CpalSource` will record at.
pub const MIN_SAMPLE_RATE_HZ: u32 = 4_000;

/// Highest sample rate `parse_wav` accepts and `CpalSource` will record at.
pub const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
