// Mirrors tauri-plugin-deep-link 2.4.9's module (the known-good shape against
// the tauri 2.x android template), minus the test/material dependencies this
// module doesn't need. Same shape as tauri-plugin-screen-guard's module —
// **without AppCompat**, which the off-the-shelf notification plugin would have
// forced in (grill SYNC-44). Scheduling and posting a notification need
// `androidx.core` only.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "md.myne.reminders"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation(project(":tauri-android"))
}
