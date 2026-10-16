# F-Droid packaging for the Android client

Everything needed to get Myne into the F-Droid main repository, in one place.
Two artefacts live here and one lives above:

| What | Where |
|---|---|
| The fdroiddata build recipe | `mobile/fdroid/md.myne.mobile.yml` (draft) |
| The same build, locally, one ABI at a time | `mobile/scripts/fdroid-build.sh` |
| The store listing | `fastlane/metadata/android/en-US/` (repository root) |
| The guard that holds the three together | `scripts/check-fdroid-metadata.mjs` (`pre-commit` + CI `fdroid-metadata`, unfiltered) |

**The versionCode arithmetic is gated, not remembered.** F-Droid installs the
highest versionCode a device can run, so the four APKs have to carry four
different codes in a fixed order, and the changelog file names have to be those
exact numbers. Tauri derives the base from the semver in
`mobile/src-tauri/tauri.conf.json` (`major * 1000000 + minor * 1000 + patch`), so
`0.10.0` gives `10000` and the recipe's `* 10 + <ABI digit>` gives `100001` to
`100004`. Nothing else in the tree compares the three artefacts, and drift fails
nothing that compiles. `scripts/check-fdroid-metadata.mjs` does, in both
directions, and it fails **by name** on what has to move: bump the version and
its output is the list of changelog files to rename.

**Status: prepared, not submitted.** One thing blocks submission and it is not
technical: F-Droid clones the source itself, so `myne-md/myne` has to be
readable first. Nothing in this directory depends on that, which is why it is
all here now.

---

## Why the store listing sits at the repository root

`fastlane/metadata/android/<locale>/` at the **repository root** is the primary
location F-Droid documents, and it is the one that works whether or not the
build metadata sets a `subdir`. The recipe deliberately does not set `subdir`
either, so the two agree. This is not a guess: the only Tauri v2 app shipping on
F-Droid today keeps its listing at its repository root while its app lives in a
subdirectory, and F-Droid found it.

The changelog file names are the **final per-ABI versionCodes**, not the semver.
`0.10.0` derives Tauri's base `10000` (`major * 1000000 + minor * 1000 + patch`),
and the recipe's `prebuild` multiplies that by ten plus the ABI digit, so the
four APKs carry `100001` to `100004` and each has its own changelog file. The
four files are identical on purpose: F-Droid resolves the changelog per version
entry, and a missing file is invisible until the store page shows nothing.
`scripts/check-fdroid-metadata.mjs` is what keeps that true across a version bump.

The graphics are five phone screenshots (1320 × 2868) and five ten-inch ones
(2048 × 2732), rendered from the mobile app in the `myne-branding` companion. They
are the Myne Marks, not AGPL-3.0 or CC-BY-4.0 material, and `LICENSING.md` records
that: they are listing metadata, nothing in the directory is compiled into a
release, and the icon inside the `.apk` comes from `mobile/src-tauri/icons/`.
There is deliberately no `featureGraphic.png`: none exists in the branding repo,
and a promo banner is a designed asset rather than a crop of one.

---

## Verified against the inclusion policy, with the evidence

| F-Droid requires | Myne | Evidence |
|---|---|---|
| FLOSS licence | AGPL-3.0 | `LICENSING.md`; `protocol/` files carry an SPDX header |
| No non-free dependencies | none | no `com.google.android.gms`, `firebase`, `crashlytics` or analytics SDK anywhere in `mobile/` |
| No non-free build tools | none | Rust, Node, Gradle and the Android SDK, all of which the policy allows prebuilt |
| No telemetry or ads | none | a hard commitment in `mobile/README.md` and `mobile/AGENTS.md`; no SDK present |
| Assets legally distributable | yes | model weights are Apache-2.0 (PP-OCRv5) and Apache-2.0 (whisper-tiny), each with `MODEL-LICENSE` and a provenance README beside it; fonts are OFL/MIT/Apache |
| Nothing downloaded and executed at runtime without consent | nothing is | `mobile/` has no model-download path at all; the only outbound connections are sync (to a server the user runs) and a user-named AI provider, both opt-in |
| No self-update | none on Android | `tauri-plugin-updater` is a desktop-only dependency |
| Application ID from a domain the maintainer owns | `md.myne.mobile` | `myne.md` |

### The one dependency worth naming out loud

`com.google.android.material:material` **is** in the Android build and **is**
load-bearing: `tauri android init` generates `Theme.myne_mobile` extending
`Theme.Material3.DayNight.NoActionBar`, so removing the library removes the app
theme. It is Apache-2.0 and served from Google Maven, which the inclusion policy
names as an allowed prebuilt source. This is recorded rather than removed,
because "unused Google library" and "the theme parent" are different claims and
only one of them is true.

### Two things a reviewer will ask about

1. **The APK carries 65 MB of model weights inside a 123 MiB download.**
   PaddleOCR PP-OCRv5 (21 MB) and quantized whisper-tiny (40 MB), bundled as
   Tauri resources; measured, the arm64 APK is 123 MiB of which the Rust library
   is 67 MiB. Licences and provenance are in place;
   the question is whether F-Droid wants machine-learning weights inside an APK
   at all. Ask before submitting, not during review.
2. **Sync points at a server the user runs.** No bundled service, no default
   endpoint, no first-party host. Read as no `NonFreeNet` anti-feature.

The exact text to post is at the bottom of this file.

---

## The build, and why each step exists

`mobile/scripts/fdroid-build.sh` is the recipe one ABI at a time in a dev
checkout, so a broken step is reproduced in minutes instead of in a build cycle.
The order is the same in both:

1. `pnpm install --frozen-lockfile` at the repository root. One lockfile covers
   every workspace member, and `mobile/` aliases roughly twenty-five `@myne/*`
   packages into the parent tree, so a partial install is not a thing.
2. `cargo tauri android init`, unless `gen/android` already exists. That whole
   tree is git-ignored and regenerated wholesale.
3. `bash scripts/android-postinit.sh`. **This is the one step nothing else
   re-applies.** `gen/android` cannot carry committed code, so the
   `:myne-widgets` gradle module is added by this script. `src-tauri/build.rs`
   injects a `<meta-data android:name="android.app.shortcuts"
   android:resource="@xml/myne_shortcuts" />` into the manifest on every Android
   build, and the resource it names ships in `mobile/android-widgets/`. Skip the
   script and the build fails at manifest merge. `mobile/AGENTS.md` says the
   same thing from the other side: forgetting it fails the build loudly by
   design.
4. The per-ABI `versionCode` patch on the generated gradle.
5. `cargo tauri android build --apk --split-per-abi --target <abi>`.

Three things are **not** in the recipe because they are unnecessary, and each
was checked rather than copied from another app's recipe:

- **No icon copy step.** `scripts/sync-icons.sh` already runs on every Android
  build through `beforeBuildCommand` in `mobile/src-tauri/tauri.conf.json`, so
  the committed icon set in `src-tauri/icons/android/` is applied by the build
  itself.
- **No signing-config strip.** The release signing block is appended by
  `android-postinit.sh` and is inert when `keystore.properties` is absent, which
  it is on a build server: the properties file drives both the `signingConfigs`
  entry and the `signingConfig =` assignment, and with it missing Gradle emits
  `app-<abi>-release-unsigned.apk`. F-Droid signs that itself.
- **No `pnpm-workspace.yaml` rewrite.** The repository has one already, correct.

---

### The permission set is six, not three

Measured off a real arm64 release APK. A reviewer reading the store page will ask
about every one of them, and the store listing does not enumerate them.

| Permission | Why it is there |
|---|---|
| `INTERNET` | sync, and the user-named AI provider. Nothing else uses it. |
| `RECORD_AUDIO` | voice notes and the WebView's `getUserMedia` capture path. |
| `MODIFY_AUDIO_SETTINGS` | required by wry's permission batch: `RustWebChromeClient` requests the pair together, and one undeclared normal-level permission fails the whole batch silently. |
| `POST_NOTIFICATIONS` | task reminders. Runtime-requested on Android 13+, not granted at install. |
| `RECEIVE_BOOT_COMPLETED` | the only way an app learns the platform threw its alarms away. Grants no access to anything. |
| `SCHEDULE_EXACT_ALARM` | reminders that arrive on time rather than approximately. Special app access, granted on a settings screen. |

(`md.myne.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` is also in the merged
manifest; androidx generates it for its own receivers and no user sees it.)

**The one to raise before a reviewer raises it.** `SCHEDULE_EXACT_ALARM` is
declared, and the in-app affordance that would ask for it is **gated off in every
build today**, because nothing on the Android client registers with the operating
system yet (`remindersReachTheOs()` returns a constant `false`). The app therefore
ships a declarable special access with no path to granting it. The full argument,
including why `USE_EXACT_ALARM` is refused outright (the platform reserves it for
alarm-clock and calendar-class apps, and claiming it would be a review gamble),
is the header comment of
`mobile/src-tauri/tauri-plugin-reminders/android/src/main/AndroidManifest.xml`.
Put a sentence about it in the submission and it is a note; let the reviewer find
it and it is a question about a permission the store page never mentioned.

---

## What the first local run measured

`mobile/scripts/fdroid-build.sh --abi arm64` on a macOS arm64 host, with JDK 21,
AGP 9.3.1, Gradle 9.6.1, SDK 37, NDK 29.0.14206865 and Rust 1.96.0. It built the
APK, and it read the answers off the artefact rather than trusting the config.

| Question | Answer |
|---|---|
| versionCode arithmetic | **Correct.** The APK reports `versionCode 100002`, `versionName 0.10.0`, `compileSdkVersion 37`. |
| Cleartext traffic | **Off.** `android:usesCleartextTraffic=false` in the shipped manifest. |
| Merged permissions | **Six, not the three the app manifest shows.** See the table above. |
| APK size, arm64 | **123 MiB.** `lib/arm64-v8a/libmyne_mobile_lib.so` 67 MiB, whisper 40 MiB, OCR models 21 MiB, everything else about 4 MiB. |
| Signing | Signed locally (`CN=Myne, O=Myne, C=DE`, SHA-256 `81a64fcd…`, matching `android-release-key-custody.md`). F-Droid's buildserver has no `keystore.properties` and emits the `-unsigned` name the recipe declares. |
| Zip timestamps | Every entry is stamped `1981-01-01 01:01`, so Gradle is already normalising them. |

**123 MiB is the number to decide about, and it has been decided: it stays.**
Measured on 2026-10-16; the models ship bundled and the four APKs carry their full
weight. The size is a known, accepted cost of the feature rather than an open
question, and the two levers below stay recorded as what changing it would take:
move whisper-tiny to an opt-in download (about 40 MiB, and it adds the consent
flow the policy requires), or ship without the local-inference feature (which
removes transcription outright).

## The reproducibility answer

**Two causes, both named. One is fixed and verified, one is not.**

### Cause 1, fixed: dependency paths inside the library

`grep -c -a` over the shipped `libmyne_mobile_lib.so` found **117 occurrences of
`$CARGO_HOME/registry/…`**, because dependency panic locations carry the registry
path of the machine that compiled them. Zero occurrences of the checkout path,
which is the other usual suspect.

`--remap-path-prefix` fixes it, and the fix is measured rather than assumed:

| | `$CARGO_HOME/registry` strings | `$HOME` strings |
|---|---|---|
| before | 117 | 27 |
| after `--remap-path-prefix=$HOME=/remap/home` | 0 | 0 |

And the consequence that matters: two builds of the same ABI **in two different
directories** produce a byte-identical library.

```
build A .so  sha256 4e782c7a3ed2cae58ffc351d53d91ccb3ffe4b206028b935d8e4a0a57a1e3843
build B .so  sha256 4e782c7a3ed2cae58ffc351d53d91ccb3ffe4b206028b935d8e4a0a57a1e3843
```

A single remap of `$HOME` covers everything: remapping the checkout separately
matched nothing, because the only leaking paths are `$HOME/.cargo` and
`$HOME/.rustup`. **It is not in the repository yet**, and it has to live there
rather than in an ad-hoc environment variable: F-Droid compares OUR build against
THEIRS, so both sides must remap to the same targets. A remap invalidates every
crate, so it is a deliberate rebuild and belongs with its own change.

### Cause 2, not fixed: Tauri's embedded config has a random key order

Comparing the two APKs entry by entry, **656 of 657 entries are identical**
(`unzip -v`, name plus CRC-32, signature entries excluded). The one that differs
is `assets/tauri.conf.json`, and the difference is this and nothing else:

```
"../../src-tauri/resources/models/ocr": "models/ocr",
"../../src-tauri/resources/models/whisper-tiny": "models/whisper"
```

versus the same two lines in the opposite order. Both files are 3013 bytes and
neither carries a machine path. The order is not a directory artefact: two builds
in the **same** directory with the **same** config file produced different orders,
which is `HashMap` iteration order seeded per process. `bundle.resources` is a
two-entry map, so it is a coin flip per build.

Two ways to close it, and neither is a one-line change:

1. **Upstream.** Tauri serialises that map through a `HashMap`, so every Tauri app
   with more than one `bundle.resources` entry has this. Reporting it is the
   honest fix.
2. **Here.** Make `bundle.resources` a **single** entry, so there is no order to
   randomise: move the two mobile model directories under one parent and map that
   parent once. It touches the resource layout, both clients' configs and the
   model provenance READMEs, so it is its own change.

### What this means for the signing decision

F-Droid's reproducibility flow wants a byte-identical APK. Cause 1 is a
`RUSTFLAGS` line away. Cause 2 is a Tauri serialisation order, so until one of the
two fixes lands, **F-Droid signs with its own key** and the migration warning
ships: an uninstall, and an uninstall deletes the vault. That is the answer to the
question `design-notes/ops/0698` left open.

## The NDK revision in the draft was a beta

`sdkmanager` resolves `29.0.13846066` to
**`android-ndk-r29-beta3-linux.zip`**, so the draft was pinning a pre-release of
r29 while the stable release of the same version was available. That is two
problems in one line: the inclusion policy restricts pre-release toolchains, and
the NDK's clang is what links the shipped `.so`, so the revision is part of the
build's identity rather than a neutral pin.

The draft now carries `29.0.14206865`, whose own `source.properties` reads
`Pkg.ReleaseName = r29` and which a local
`mobile/scripts/fdroid-build.sh --abi arm64` has already built an APK with.
`mobile/docs/dev/device-matrix.md` carried the same stale revision and has been
corrected in the same change.

### A local dry run has to run the `sudo:` block by hand

`fdroid build` refuses to run a build's `sudo:` commands off a dedicated build
server. It prints the list and says so:

```
WARNING: md.myne.mobile:100002 runs this on the buildserver with sudo: [...]
These commands were skipped because fdroid build is not running on a dedicated build server.
```

On F-Droid's own buildserver that block is the whole point of the field and it
runs. In the container above it does not, so the `init:` step dies on
`rustup: command not found` unless the same commands are run by hand in the same
container first. That is a property of the local harness, not of the recipe, and
it is worth knowing before the first attempt is misread as a broken recipe.

## Owed: the first dry run

The recipe was reasoned from a working Tauri v2 app on F-Droid plus this
repository's own pins. Items 3, 8 and 9 below are now answered by the local run
above; the rest still need the buildserver container, because they are questions
about ITS toolchain rather than about ours. What remains, in order:

1. Fill in `commit:` (currently a placeholder) and run `fdroid lint`, which
   refuses the placeholder by name.
2. `fdroid build` in the fdroiddata container against a **local** clone
   (`Repo: file:///…`), which needs no public hosting, then read the four APKs.
3. Do the four APKs carry `versionName 0.10.0` and `versionCode 100001` to
   `100004`? If the arithmetic Tauri uses has moved, this is where it surfaces.
4. Do the APKs contain real model weights? Unzip the APK and check the size of
   the bundled `models/whisper/model.gguf`; anything near 130 bytes means the
   LFS fetch failed. `fdroidserver` has no `lfs` handling at all (checked in
   `scanner.py`, `build.py` and `common.py`), which is why the recipe installs
   `git-lfs` and runs `git lfs pull` itself.
5. Does the buildserver's JDK satisfy AGP 9.3.1 and Gradle 9.6.1, and does its
   SDK carry `platforms;android-37`? If not, the SDK installs in `sudo:` via
   `sdkmanager`, or `compileSdk`/`targetSdk` come down. Neither is decided here.
6. ~~Does `ndk: 29.0.13846066` install?~~ **Answered, and the revision was
   wrong.** It installs (`sdkmanager` resolves it), but it resolves to
   `android-ndk-r29-beta3-linux.zip`, so the draft was pinning a beta of r29. The
   draft and the device matrix now carry the stable `29.0.14206865`. See "The NDK
   revision in the draft was a beta" above.
7. **Break the postinit step and watch it fail.** Remove that one line, rebuild,
   and confirm the failure is the manifest-merge error named above. A step
   described as "fails loudly by design" is a claim, and this is the cheap
   minute that turns it into evidence.
8. Measure the per-ABI APK size and write it here.
9. Check the release manifest for `android:usesCleartextTraffic="false"`.
10. Confirm `fdroid lint` accepts `License: AGPL-3.0-only`. If its licence list
    predates SPDX identifiers, the field becomes `AGPL-3.0`, which is the same
    licence under a different spelling.

---

## Auto-update: the decision, and why

The recipe deliberately carries **no `UpdateCheckMode`**, so each release adds
four build blocks by hand rather than F-Droid's checker finding the new version.

The reason is mechanical. Tauri derives the Android `versionCode` from the
semver in `mobile/src-tauri/tauri.conf.json`, and `UpdateCheckData` is four
fields of regular expression with no arithmetic, so there is no `versionCode=`
line anywhere for it to read. There are two ways out, and both cost something
this change did not want to spend silently:

1. Set `bundle.android.versionCode` explicitly in `tauri.conf.json` (the key
   exists in the config schema; the default formula is only a default). Then
   `UpdateCheckData` can read both fields out of that one file, with no second
   source of truth. The cost is a new hand-maintained number, in a repository
   whose release process already bumps **eight** version fields per release
   (`operations/runbooks/release-checklist.md`).
2. Add a committed `version.properties` holding `versionCode=` and
   `versionName=`, and `sed` it into `tauri.conf.json` during `init`. This is
   what the shipping Tauri app on F-Droid does. The cost is a ninth version
   source, and the drift risk that comes with it.

Option 1 is the better shape and is the one to take if automatic updates are
wanted. It is a one-line config change plus `UpdateCheckData` and
`VercodeOperation` in the recipe. Until then, a maintainer adds the block, which
for a pre-alpha project with infrequent releases is not the bottleneck.

---

## The migration warning, which must ship with the release

F-Droid signs with its own key. That makes a third signing identity for
`md.myne.mobile`, alongside the one on the currently published `.apk`:

- A device with the sideloaded `.apk` installed **cannot** install the F-Droid
  build over it. Android refuses with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
- The only way through is an uninstall, and an uninstall deletes the app's
  private storage, which is where the on-device vault lives.

This is not hypothetical: `operations/runbooks/android-release-key-custody.md`
records that the same break already happened twice here, at v0.1.0 to v0.2.0 and
again at v0.9.0, and that local-only notes were lost both times.

So the announcement, the user guide and the store listing all have to say
"export your notes first". The store listing already does (see
`fastlane/metadata/android/en-US/full_description.txt` and the changelog). The
user guide lives in `myne-website` and this is a follow-up there.

If the reproducible-build spike below succeeds, this whole section becomes moot:
F-Droid would sign with Myne's own key and the two builds would be
interchangeable.

---

## The reproducible-build spike

Worth doing because it cannot be done later. Android refuses an update signed by
a different key, so switching to a reproducible build after users have installed
the F-Droid build would mean another uninstall-and-lose-the-vault. The F-Droid
guidance says so explicitly: attempt it before the first release, not after.

Procedure:

1. Build the same ABI twice in the same container, and compare the SHA-256 of
   the two unsigned APKs.
2. If they match: add `Binaries:` (a URL to the APK we publish) and
   `AllowedAPKSigningKeys:` (the release certificate's SHA-256 fingerprint,
   recorded in `operations/runbooks/android-release-key-custody.md`) to the
   recipe. F-Droid then verifies our build against source and signs with our
   key.
3. If they differ: name the source before concluding anything. The usual ones
   are paths embedded in the Rust binary, Gradle's archive ordering and
   timestamps, and generated build metadata. `--remap-path-prefix` and
   `SOURCE_DATE_EPOCH` are the first levers.
4. Either way, write the result into `design-notes/` with the entry that lands
   this work. A negative result is a result: desktop builds are not reproducible
   either (`docs/threat-model.md` section 6), while the wasm bundle is, and the
   difference is worth recording.

---

## Question to post before submitting

Post this on the F-Droid forum submission queue. Its purpose is to spend one day
asking instead of two weeks being told during review.

> **Myne (md.myne.mobile): pre-submission check on bundled model weights and a self-hosted sync server**
>
> Hello,
>
> I am preparing Myne, an end-to-end encrypted markdown notes app (AGPL-3.0,
> Tauri 2 + React), for inclusion in the main repository, and I would like to
> sanity-check four things first so I do not spend a review cycle on them.
>
> 1. **Bundled machine-learning weights.** The APK bundles two model files as
>    application resources: PaddleOCR PP-OCRv5 (Apache-2.0) and a quantized
>    whisper-tiny (Apache-2.0), together 65 MB inside a 123 MiB download. Each
>    directory carries its licence text and a provenance README naming the
>    upstream revision. They are data rather than code, and nothing is downloaded
>    at runtime. Is bundling FLOSS-licensed prebuilt weights acceptable, or does
>    the policy require them out of the APK?
> 2. **Self-hosted sync.** Sync is optional and points at a server the user runs
>    themselves. There is no first-party service the app depends on and no
>    default endpoint. I read that as no `NonFreeNet` anti-feature; could you
>    confirm?
> 3. **A user-named remote AI provider.** Off by default, configured by the
>    user. Same question.
> 4. **`SCHEDULE_EXACT_ALARM`, declared but not yet reachable.** The manifest
>    declares it for task reminders, and the in-app affordance that would ask for
>    it is gated off in the current build because nothing on the client registers
>    with the operating system yet. The declaration is deliberate: the Kotlin
>    behind it is complete and removing the line means re-adding it, in a
>    Play-reviewed file, in the change that flips the predicate. I would rather
>    raise it than have it turn up as a question about a permission the store page
>    never mentions. `USE_EXACT_ALARM` is not declared and will not be.
>
> I am happy to change the build before submitting, for example by moving the
> transcription model to an opt-in download, if any of this is a problem.
>
> Thanks.

---

## Deliberately not here

- **No `.fdroid.yml` or in-repo repo index.** Myne is not publishing its own
  F-Droid repository; it is asking to be in the main one.
- **No `FUNDING.yml`.** F-Droid verifies donation links, and this project has no
  funding channel. Adding one to satisfy a field would be inventing it.
- **No feature graphic.** None exists in the branding repo, and a promo banner is
  a designed asset rather than a crop of one.
- **No companion-repo work in this directory.** The runbook is
  `operations/runbooks/fdroid-release.md`, the per-release checklist row is in
  `operations/runbooks/release-checklist.md`, and the user-facing migration warning
  is in `myne-website`'s
  `src/content/user-guide/getting-started/install.md`. All three are separate
  pull requests against their own repositories; none of them is committed through
  the main one.
- **No decision entry here.** The channel, the private-source blocker and the
  reproducibility precondition are `design-notes/ops/0698`.
