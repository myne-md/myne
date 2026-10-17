//! Reproducible-build hash-pins for the bundled dictionaries (MYND-263 t5).
//!
//! Every Hunspell file we ship is pinned to its exact SHA-256. The verification
//! test below recomputes the digest of each in-tree resource and asserts it
//! equals the pin — so a swapped, corrupted, or silently-updated dictionary (or
//! license) fails `cargo test`, the same gate CI + `pre-push` already run. This
//! is the dictionary arm of the reproducible-build posture: the bytes that ship
//! in the production bundle (`tauri.conf.json` `bundle.resources`) are exactly
//! the bytes recorded and reviewed here — no runtime download, no drift.
//!
//! Adding a language means adding its `index.aff` / `index.dic` / `license` rows
//! (and listing it in [`super::commands::BUNDLED_LANGUAGES`]); the cross-check
//! test fails if a bundled language has no pins, or a pin has no shipped file.

/// One pinned bundled-dictionary file.
pub struct PinnedDictFile {
    /// Language code; matches a [`super::commands::BUNDLED_LANGUAGES`] entry and
    /// the `resources/dictionaries/<lang>/` directory name.
    pub lang: &'static str,
    /// File name within the language directory (`index.aff`, `index.dic`, `license`).
    pub file: &'static str,
    /// Lowercase hex SHA-256 of the shipped file's bytes.
    pub sha256_hex: &'static str,
}

/// Every shipped dictionary file, pinned to its SHA-256. v1: 22 languages
/// (en-US + 21 verified-loadable, AGPL-compatible wooorm dicts; TR/da/gl/uk/el/hr
/// excluded — see `commands::BUNDLED_LANGUAGES`). `index.dic` + `index.aff` are
/// the speller inputs; `license` is the in-tree provenance (font-license
/// precedent) and is pinned too so a license swap is also caught.
pub const PINNED_DICT_FILES: &[PinnedDictFile] = &[
    PinnedDictFile {
        lang: "en-US",
        file: "index.aff",
        sha256_hex: "8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b",
    },
    PinnedDictFile {
        lang: "en-US",
        file: "index.dic",
        sha256_hex: "f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647",
    },
    PinnedDictFile {
        lang: "en-US",
        file: "license",
        sha256_hex: "2a7e8d8ae9e8facc84818546ae2a8d83aec5e9c80a675ff789acd1c338b53b3d",
    },
    // German — wooorm/dictionaries `de` (igerman98); (GPL-2.0 OR GPL-3.0) → GPL-3.0.
    PinnedDictFile {
        lang: "de",
        file: "index.aff",
        sha256_hex: "57fdd1b16aac2131003c91e0cf2a488becb970382a402a9ce089307301cb3ef0",
    },
    PinnedDictFile {
        lang: "de",
        file: "index.dic",
        sha256_hex: "b5c781a0cf6f285fb6b9b8ab02fbea104b987104a1efdda8a835837e89e3ec77",
    },
    PinnedDictFile {
        lang: "de",
        file: "license",
        sha256_hex: "03abf202c6e207d41f054083cafccbb174a30f6b330ea8dba3aeef0a279cb83e",
    },
    // Spanish — wooorm/dictionaries `es` (RLA); (GPL-3.0 OR LGPL-3.0 OR MPL-1.1).
    PinnedDictFile {
        lang: "es",
        file: "index.aff",
        sha256_hex: "892039d59db11d747061b81c3a92a52d48ba0e055b5835af1943cbd3c2fba85b",
    },
    PinnedDictFile {
        lang: "es",
        file: "index.dic",
        sha256_hex: "907f786a8ceb3456722b20ad91dd4dbe99c5c16e45015ea63155e36f26b06d2c",
    },
    PinnedDictFile {
        lang: "es",
        file: "license",
        sha256_hex: "a21581497f07b5e550e438d26890ea2b1704492357de67740613bd589b1c652a",
    },
    // French — wooorm/dictionaries `fr` (Dicollecte); MPL-2.0.
    PinnedDictFile {
        lang: "fr",
        file: "index.aff",
        sha256_hex: "05a735d34c912e4e381ff08ee7c747923ccf5cf9dca81d8467982fa1ca51c2b7",
    },
    PinnedDictFile {
        lang: "fr",
        file: "index.dic",
        sha256_hex: "984e933237bc1224a48f42828233be9b03228260ef67aa8e2bdddcd03a26230d",
    },
    PinnedDictFile {
        lang: "fr",
        file: "license",
        sha256_hex: "0c785aebc7aae8aa00b8163e9b3219a8785a9900b71e85475204e48a5651ced4",
    },
    // Italian — wooorm/dictionaries `it` (Apache OpenOffice); GPL-3.0.
    PinnedDictFile {
        lang: "it",
        file: "index.aff",
        sha256_hex: "5770cd3e16d494c045b4a9a4a9fcd7962577e642d0384a7129c020a12cdd2c79",
    },
    PinnedDictFile {
        lang: "it",
        file: "index.dic",
        sha256_hex: "b1348fbdb6f441ea9dd7e33b2cfcb96ead39ccd5e48bf894972774cd5aa86abb",
    },
    PinnedDictFile {
        lang: "it",
        file: "license",
        sha256_hex: "e48a7f7b3ec37ebb2c0d625528a7a677818de039bbae43e8f2c1dce6fd2a13e6",
    },
    PinnedDictFile {
        lang: "bg",
        file: "index.aff",
        sha256_hex: "cb6bfc56d6b1e70c812061086d7ec5ad6aaf6d35acd927a035f1cee0188ea477",
    },
    PinnedDictFile {
        lang: "bg",
        file: "index.dic",
        sha256_hex: "44408b1ee50301e8f9a133b0ec92565bb8be49818c444d91821876d447f58906",
    },
    PinnedDictFile {
        lang: "bg",
        file: "license",
        sha256_hex: "49d7594ad2681a019e00c984dcb1faec29f60018e17c28097eb25c17f7243093",
    },
    PinnedDictFile {
        lang: "ca",
        file: "index.aff",
        sha256_hex: "bfc7d8412c9450ec63e00d13f2153191a11d04868b14d51cf6c50eace71efdb2",
    },
    PinnedDictFile {
        lang: "ca",
        file: "index.dic",
        sha256_hex: "e272aeff4b2d1a92b428a22b52c685292d04936e34dfe7786e27539175cbef2e",
    },
    PinnedDictFile {
        lang: "ca",
        file: "license",
        sha256_hex: "0287b97b6dc8932f58d8d91dc8364aa0be78d6800517875a76624af7cc92782b",
    },
    PinnedDictFile {
        lang: "en-GB",
        file: "index.aff",
        sha256_hex: "8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b",
    },
    PinnedDictFile {
        lang: "en-GB",
        file: "index.dic",
        sha256_hex: "869fe17ba4ee4b5401c60a666ee2d6a3dcc237f460b7294435df1cc6a799aa57",
    },
    PinnedDictFile {
        lang: "en-GB",
        file: "license",
        sha256_hex: "81b644347b40804c25811267efbea024a30b2bb1642fefa9c9c50f7b0bbcb67f",
    },
    PinnedDictFile {
        lang: "fa",
        file: "index.aff",
        sha256_hex: "dba0980816354ad969aa46dda0c040eeebda4a9381be331e17eae8647a2a1e1c",
    },
    PinnedDictFile {
        lang: "fa",
        file: "index.dic",
        sha256_hex: "314f31e059994f26e8016c834b14dfd10f74834b3f623a6040265b8f2a9dddab",
    },
    PinnedDictFile {
        lang: "fa",
        file: "license",
        sha256_hex: "7429736f069a84049bcfbee436e5cea3a3fd9b98348d880d9e43ebcf39721989",
    },
    PinnedDictFile {
        lang: "he",
        file: "index.aff",
        sha256_hex: "e115a0a5014d17a8e904f9d4a67d7992039b396c5fa031eb036a13bf63dfb037",
    },
    PinnedDictFile {
        lang: "he",
        file: "index.dic",
        sha256_hex: "9bd95042a927e13ab422231e355caa8a7018456e7c49b889f2e6c62ddb5a0552",
    },
    PinnedDictFile {
        lang: "he",
        file: "license",
        sha256_hex: "bb0a75c473e49224e0428b95c17ad90f1774a7f6cb97be921f9d6a93a3af80d7",
    },
    PinnedDictFile {
        lang: "hu",
        file: "index.aff",
        sha256_hex: "da5cecde3c1afb67990030f1ffe8fb9859983c9305fc207abeb5475f8f002237",
    },
    PinnedDictFile {
        lang: "hu",
        file: "index.dic",
        sha256_hex: "3ac7aa0a100cabadddb4ace6c72ea3dcd6a5535aef63c8bf94f14073a71decd5",
    },
    PinnedDictFile {
        lang: "hu",
        file: "license",
        sha256_hex: "28df62764d790d0b4dd322a517f5a468f952ba03b9ea6ff5c18a45d0f2faf2d9",
    },
    PinnedDictFile {
        lang: "ko",
        file: "index.aff",
        sha256_hex: "7b8930ce1357691591a3c38afc9cba787ec6dce0e30d0438bd156c4b4c94dbdf",
    },
    PinnedDictFile {
        lang: "ko",
        file: "index.dic",
        sha256_hex: "ea275b5fe256925a95f9192a173f7c3d3c2480fa748371c64b89d7e0cc531b1d",
    },
    PinnedDictFile {
        lang: "ko",
        file: "license",
        sha256_hex: "3e81dd90f6d8877ccb2ed2b262ce72ee8a6ccf3a21179a8949abf0d85ac7fda0",
    },
    PinnedDictFile {
        lang: "lt",
        file: "index.aff",
        sha256_hex: "79c6f8304490d1c8b27ec93e509b2f635d9bb21d45a2d41c15162b18c8ff897c",
    },
    PinnedDictFile {
        lang: "lt",
        file: "index.dic",
        sha256_hex: "a751750b040623cf408cf1a3b6f6336141b55ac9519e54068dbeaa52eb395ccd",
    },
    PinnedDictFile {
        lang: "lt",
        file: "license",
        sha256_hex: "c5c73b4e3743ed2b959c70e886c4acee20d8654002ccdabac0a51af977ee2a17",
    },
    PinnedDictFile {
        lang: "lv",
        file: "index.aff",
        sha256_hex: "a11f646c6905d6c96f3218ada4a6cf84129c9e6169720ac1a17f1707940a2890",
    },
    PinnedDictFile {
        lang: "lv",
        file: "index.dic",
        sha256_hex: "bf7d054e28bc5e44df19410f3ed9d5fd8d6a4d8c051676650388c4e8d65c3148",
    },
    PinnedDictFile {
        lang: "lv",
        file: "license",
        sha256_hex: "9bfd51d5240995d95fe159be73bd34369dd9b97efc501118fd675e46c6089bdb",
    },
    PinnedDictFile {
        lang: "nl",
        file: "index.aff",
        sha256_hex: "b430d9cf5f4170d9e5072397927e1402b34aa877d1f4c8fbc00dab6370d87312",
    },
    PinnedDictFile {
        lang: "nl",
        file: "index.dic",
        sha256_hex: "be192fdc36efd39dde0fb9a5a113143e0a906782e81ed68a74a710edced378d0",
    },
    PinnedDictFile {
        lang: "nl",
        file: "license",
        sha256_hex: "fd9e95c360245eab3c388885062820754785faa4123964994cfdecb950b71948",
    },
    PinnedDictFile {
        lang: "pl",
        file: "index.aff",
        sha256_hex: "de7b54a8fa37562d58b481cf3d87a63e3dcc2d74021f6403eb0e4f5df9ecc225",
    },
    PinnedDictFile {
        lang: "pl",
        file: "index.dic",
        sha256_hex: "74b6155391025419967c26913541b55b36d58e80b1028037d4a0b8ddcb18d0b7",
    },
    PinnedDictFile {
        lang: "pl",
        file: "license",
        sha256_hex: "8bb92c291eb431ffe32f7c42a719a0b54acf2851690fe12ca292e248a12a37e6",
    },
    PinnedDictFile {
        lang: "pt",
        file: "index.aff",
        sha256_hex: "a9f3621b94eb4d6838474bf9982027758e77dcb248815f49409b1a4a477dbd27",
    },
    PinnedDictFile {
        lang: "pt",
        file: "index.dic",
        sha256_hex: "32e2edd83541d58613bcc83ef731a79aadf85ed57e977a16c6b5f711a7a36cee",
    },
    PinnedDictFile {
        lang: "pt",
        file: "license",
        sha256_hex: "bb064f3db7ba5f5536da7d079773f692c5f928822e8aebc3d78259ff6cceb9e5",
    },
    PinnedDictFile {
        lang: "ro",
        file: "index.aff",
        sha256_hex: "3ee127a667bdec829faee546ae32033e8f10f7c63117f9b572ef03ad9df2b76b",
    },
    PinnedDictFile {
        lang: "ro",
        file: "index.dic",
        sha256_hex: "c26a9356f598a0ae89e7be650f6bdd9ba70acce66b41d7ab14c0c68639b6ed33",
    },
    PinnedDictFile {
        lang: "ro",
        file: "license",
        sha256_hex: "854c3b7e6575da37d066d5a09945af336a8ecc62c5e3c1049e97504dc67cbd81",
    },
    PinnedDictFile {
        lang: "ru",
        file: "index.aff",
        sha256_hex: "38ce7d4af78e211e9bafe4bf7e3d6a2c420591136cb738ec6648f8fdf6524cd7",
    },
    PinnedDictFile {
        lang: "ru",
        file: "index.dic",
        sha256_hex: "f6047416a0204adbecf3a451b874ec8a97ee37e2cbc714466ef04d8dbcc0d6fc",
    },
    PinnedDictFile {
        lang: "ru",
        file: "license",
        sha256_hex: "262af2f6ad70a61e5ee1332ff44fa8ee50edca819cf33207d8ad6ba6a0c9be52",
    },
    PinnedDictFile {
        lang: "sk",
        file: "index.aff",
        sha256_hex: "a79dc992b849aa2355db38eea9c4722239993639d77bc81c9c1aa79f213e723c",
    },
    PinnedDictFile {
        lang: "sk",
        file: "index.dic",
        sha256_hex: "b6cdb6fb512c44881cc91329aea0b179840f5f9a3e6cb024c2ab8547f96f5d94",
    },
    PinnedDictFile {
        lang: "sk",
        file: "license",
        sha256_hex: "04903300e57a64a9967f85cdc65038470165b56bd34843e161f89d1fb9bcc0cd",
    },
    PinnedDictFile {
        lang: "sl",
        file: "index.aff",
        sha256_hex: "511043a4f9c64a966599e3d53fa1f4e9a172a87de4a7a0c2cf327098a3a605d1",
    },
    PinnedDictFile {
        lang: "sl",
        file: "index.dic",
        sha256_hex: "5bac615dbd301ddbefbdaafdae242a89e46605916d77958df22778e770a95b9e",
    },
    PinnedDictFile {
        lang: "sl",
        file: "license",
        sha256_hex: "80e3fb8a78bf7c3cf1c76679ff1f11d4cb100440c9362553636b02edca005eb8",
    },
    PinnedDictFile {
        lang: "sv",
        file: "index.aff",
        sha256_hex: "ff8ddb979daa9f128e7489ece5edd666ada7af787933221543b7cecb2b3ed478",
    },
    PinnedDictFile {
        lang: "sv",
        file: "index.dic",
        sha256_hex: "540ff8d0d9b05aae66dd919625d3a0bd25026d1e157027e6602e5dd11a07b645",
    },
    PinnedDictFile {
        lang: "sv",
        file: "license",
        sha256_hex: "1314b6004bff32053ca25aca5fc419e905d75a6d49f9f9825baf4f02298af6d9",
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    use std::path::PathBuf;

    /// Lowercase hex of a byte slice (no `hex` crate dep for a test-only need).
    fn to_hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            // Write into the existing buffer — no per-byte String allocation.
            let _ = write!(s, "{b:02x}");
        }
        s
    }

    /// `resources/dictionaries/<lang>/<file>` relative to the crate root — the
    /// in-tree source of the bundled resource (the same root the real-dictionary
    /// engine test reads from).
    fn resource_path(lang: &str, file: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("dictionaries")
            .join(lang)
            .join(file)
    }

    #[test]
    fn bundled_dictionaries_match_pinned_hashes() {
        for pin in PINNED_DICT_FILES {
            let path = resource_path(pin.lang, pin.file);
            let bytes = std::fs::read(&path).unwrap_or_else(|e| {
                panic!("pinned dict file missing: {}/{} ({e})", pin.lang, pin.file)
            });
            let got = to_hex(&Sha256::digest(&bytes));
            assert_eq!(
                got, pin.sha256_hex,
                "SHA-256 mismatch for {}/{} — the shipped dictionary differs from its \
                 reproducible-build pin (update the pin only with a reviewed dict change)",
                pin.lang, pin.file
            );
        }
    }

    #[test]
    fn every_bundled_language_has_aff_dic_and_license_pinned() {
        for lang in super::super::commands::BUNDLED_LANGUAGES {
            for required in ["index.aff", "index.dic", "license"] {
                assert!(
                    PINNED_DICT_FILES
                        .iter()
                        .any(|p| p.lang == *lang && p.file == required),
                    "bundled language {lang} is missing a hash-pin for {required} \
                     (every shipped dict file must be pinned)"
                );
            }
        }
    }

    #[test]
    fn no_pin_references_an_unbundled_language() {
        for pin in PINNED_DICT_FILES {
            assert!(
                super::super::commands::BUNDLED_LANGUAGES.contains(&pin.lang),
                "pinned file references {} which is not in BUNDLED_LANGUAGES",
                pin.lang
            );
        }
    }
}
