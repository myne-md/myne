// Mirrors tauri-plugin-share-intent's module (itself the deep-link 2.4.9 shape),
// minus the test/material dependencies this bridge doesn't need. The dependency
// SET is that module's, unchanged, so the two plugins build against the same
// Android baseline; the picker itself goes through
// `Plugin.startActivityForResult` + `@ActivityCallback`, which are in the
// tauri-android API this module depends on.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "md.myne.savefile"
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
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation(project(":tauri-android"))
}
