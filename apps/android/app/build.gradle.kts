plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing is opt-in: CI decodes the keystore from repository secrets into a
// properties file (see `.github/workflows/release.yml`) and points
// `PODGO_SIGNING_PROPERTIES` at it. The four `PODGO_SIGNING_*` environment
// variables still work for local builds. Without either, the release variant
// still builds, just unsigned.
data class SigningMaterial(
    val storeFile: String,
    val storePassword: String?,
    val keyAlias: String,
    val keyPassword: String?,
)

fun signingFromProperties(path: String): SigningMaterial? = try {
    val properties = java.util.Properties()
    File(path).inputStream().use(properties::load)
    val store = properties.getProperty("storeFile")
    val alias = properties.getProperty("keyAlias")
    if (store.isNullOrBlank() || alias.isNullOrBlank()) {
        null
    } else {
        SigningMaterial(
            storeFile = store,
            storePassword = properties.getProperty("storePassword"),
            keyAlias = alias,
            keyPassword = properties.getProperty("keyPassword"),
        )
    }
} catch (error: java.io.IOException) {
    logger.warn("PODGO_SIGNING_PROPERTIES is not readable (${error.message}); building unsigned.")
    null
}

fun signingFromEnvironment(): SigningMaterial? {
    val store = providers.environmentVariable("PODGO_SIGNING_STORE_FILE").orNull
    val alias = providers.environmentVariable("PODGO_SIGNING_KEY_ALIAS").orNull
    if (store == null || alias == null) {
        return null
    }
    return SigningMaterial(
        storeFile = store,
        storePassword = providers.environmentVariable("PODGO_SIGNING_STORE_PASSWORD").orNull,
        keyAlias = alias,
        keyPassword = providers.environmentVariable("PODGO_SIGNING_KEY_PASSWORD").orNull,
    )
}

val signing: SigningMaterial? =
    providers.environmentVariable("PODGO_SIGNING_PROPERTIES").orNull
        ?.let(::signingFromProperties)
        ?: signingFromEnvironment()
val canSign = signing != null

// Version comes from the release tag: `v1.2.3` → name 1.2.3, code 10203.
val tagName = providers.environmentVariable("PODGO_VERSION_NAME").orNull
    ?.takeIf { it.isNotBlank() }
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
        // Matches the GitHub repository (Ultchad/open-podgoedit). Hyphens are
        // not valid in an application ID, so they are dropped here. The
        // namespace stays `dev.openpodgo.edit`; only the installed package
        // name changes, which does not affect the signing key.
        applicationId = "io.github.ultchad.openpodgoedit"
        minSdk = 26
        targetSdk = 35
        versionCode = versionCodeValue.coerceAtLeast(1)
        versionName = versionNameValue
    }

    signingConfigs {
        if (canSign) {
            create("release") {
                storeFile = file(signing!!.storeFile)
                storePassword = signing.storePassword
                keyAlias = signing.keyAlias
                keyPassword = signing.keyPassword
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
