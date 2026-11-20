plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing is opt-in: CI decodes the keystore from repository secrets and
// passes the four `PODGO_SIGNING_*` values. Without them the release variant
// still builds, just unsigned.
val signingStoreFile = providers.environmentVariable("PODGO_SIGNING_STORE_FILE").orNull
val signingStorePassword = providers.environmentVariable("PODGO_SIGNING_STORE_PASSWORD").orNull
val signingKeyAlias = providers.environmentVariable("PODGO_SIGNING_KEY_ALIAS").orNull
val signingKeyPassword = providers.environmentVariable("PODGO_SIGNING_KEY_PASSWORD").orNull
val canSign = listOf(
    signingStoreFile,
    signingStorePassword,
    signingKeyAlias,
    signingKeyPassword,
).all { it != null }

// Version comes from the release tag: `v1.2.3` → name 1.2.3, code 10203.
val tagName = providers.environmentVariable("PODGO_VERSION_NAME").orNull
    ?: "0.1.0"
val versionSegments = tagName.trimStart('v').split('.', '-').mapNotNull { it.toIntOrNull() }
val versionNameValue = tagName.trimStart('v')
val versionCodeValue = versionSegments
    .take(3)
    .fold(0) { acc, part -> acc * 100 + part.coerceIn(0, 99) }

android {
    namespace = "dev.openpodgo.edit"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.openpodgo.edit"
        minSdk = 26
        targetSdk = 35
        versionCode = versionCodeValue.coerceAtLeast(1)
        versionName = versionNameValue
    }

    signingConfigs {
        if (canSign) {
            create("release") {
                storeFile = file(signingStoreFile!!)
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (canSign) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    // The web bundle is pre-built and copied into `assets/www` by
    // `tools/sync-web-assets.mjs`; nothing is generated at compile time.
    androidResources {
        noCompress += listOf("wasm")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // WebViewAssetLoader serves the bundled assets under a secure HTTPS origin.
    implementation("androidx.webkit:webkit:1.12.1")
    // OnBackPressedCallback without rewriting the activity to a ComponentActivity.
    implementation("androidx.activity:activity:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
}

// Fail early with a readable message instead of shipping an empty shell.
val checkWebAssets = tasks.register("checkWebAssets") {
    val index = file("src/main/assets/www/index.html")
    inputs.file(index)
    doLast {
        if (!index.exists()) {
            throw GradleException(
                "Missing web bundle at ${index.path}. Run `node tools/sync-web-assets.mjs` first.",
            )
        }
    }
}

tasks.named("preBuild") {
    dependsOn(checkWebAssets)
}
