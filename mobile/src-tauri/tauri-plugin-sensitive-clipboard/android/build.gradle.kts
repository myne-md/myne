// Mirrors the sibling in-repo plugins' module shape (screen-guard / share-intent
// / reminders), which in turn mirrors tauri-plugin-deep-link 2.4.9's known-good
// module against the tauri 2.x android template.
//
// `minSdk = 24` matches every sibling and is the constraint that shapes this
// plugin's Android half: the clipboard sensitivity hint is API 33, and the clear
// API is API 28, so this module has to answer for three OS eras rather than one.
// `compileSdk = 36` is what lets the API-33 call compile at all.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "md.myne.mobile.sensitiveclipboard"
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
