// Myne Android widgets — a com.android.library module kept OUTSIDE the
// git-ignored src-tauri/gen/android tree so it survives `tauri android init`
// regeneration (the Android mirror of ios-widgets/). Wired in by
// scripts/android-postinit.sh; see android-widgets/README.md.
//
// Deliberately ZERO external dependencies (no Glance/Compose): the widgets are
// static launchers built on framework RemoteViews, and adding a dependency is
// a security decision (main repo AGENTS.md).
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 36
    namespace = "md.myne.mobile.widgets"
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}
