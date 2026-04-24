plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij.platform") version "2.2.1"
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.24"
}

group = "fan.idea"
version = "1.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create("IC", "2024.1")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
        instrumentationTools()
    }

    implementation("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines")
    }
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0") {
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines")
    }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.6.3") {
        exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines")
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
    }
    implementation("com.vladsch.flexmark:flexmark-all:0.64.8")
    implementation("org.jsoup:jsoup:1.18.1")

    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

tasks.withType<JavaCompile> {
    targetCompatibility = "17"
}

intellijPlatform {
    pluginVerification {
        ides {
            ide("IC", "2024.1")
        }
    }
}

tasks {
    runIde {
        jvmArgs("-Dide.browser.jcef.args=--no-sandbox --disable-gpu")
    }

    buildSearchableOptions {
        enabled = false
    }
}
