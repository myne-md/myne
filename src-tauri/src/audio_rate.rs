// SPDX-License-Identifier: AGPL-3.0-only
// The sample-rate window a WAV must fall in, owned by NEITHER the decoder nor
// the recorder.
//
// It belongs to both and to neither, which is why it is a crate-level module
// rather than a `pub` in `plugins::local_inference::audio`. `parse_wav` refuses
// anything outside this window, and `CpalSource::start` refuses to record
// outside it, so the invariant `docs/threat-model.md` and
// `decisions/ai/0542` state as a construction -- no clip a Myne client
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
//
// THE TRADE THE RECORDER SIDE MAKES, decided rather than inherited. Review asked
// it directly, and the question is fair: refusing to record loses the TAKE,
// which is a larger loss than losing the transcript, and the two are not
// symmetric. Storing an untranscribable clip would keep the audio.
//
// The refusal stays, for three reasons in order of weight.
//
// It is the only thing that makes the invariant a construction. `0542` and
// `docs/threat-model.md` § 7 both state "no clip a Myne client records is
// refused by a Myne decoder" as something the code holds rather than something
// the format guarantees. The LENGTH clamp in `capture.rs` holds one half of it;
// this refusal holds the other. Record outside the window and the sentence is
// false, and the ceiling those two documents argue for stops being safe to state.
//
// The refusal cannot fire on hardware that exists. The window is wider than
// every real capture path in both directions, per the paragraph above, and the
// rate is reported by the OS rather than chosen by an attacker, so unlike the
// decoder's copy this one is not a defence against anything. It is a
// consistency check on a device that would have to be reporting nonsense.
//
// And the cost of it firing is now bounded by copy rather than by mystery.
// `RecordError::UnsupportedSampleRate` reaches the user through
// `VoiceRecordError::UnsupportedSampleRate` and its own sentence in both voice
// mappers, naming the device and the one setting that fixes it. Until those arms
// existed it landed on "Couldn't save the recording", which is what made this
// trade look worse than it is: a silent, unexplained loss rather than a stated
// refusal with a route out.
//
// The residual, stated: if a device ever does report outside the window, the take
// is lost rather than stored untranscribable. That is the choice, not an
// oversight.

/// Lowest sample rate `parse_wav` accepts and `CpalSource` will record at.
pub const MIN_SAMPLE_RATE_HZ: u32 = 4_000;

/// Highest sample rate `parse_wav` accepts and `CpalSource` will record at.
pub const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
