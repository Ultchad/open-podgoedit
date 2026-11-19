pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Plugin versions are pinned on the projects in `build.gradle.kts`; this file
// only declares where plugins and dependencies are resolved from.
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "podgo-editor"
include(":app")
