---
stack: kotlin
version: 1.0
---

# Review Rules: Kotlin

## Stack Detection Hints

Manifests: `build.gradle.kts` or `build.gradle`; also `settings.gradle.kts`, `gradle/libs.versions.toml`, `pom.xml`.
File extensions: `.kt`, `.kts` (Gradle scripts); `.java` in mixed projects — apply both rule sets.
Tooling: Gradle/Maven, ktlint, detekt, kotlinc, JUnit, kotlinx.coroutines.

## Reviewer Checklist

1. Null-safety: no `!!` without a proven invariant; prefer `?.`, `?:`, `requireNotNull` with message.
2. `val` over `var`; no mutable shared state without confinement or synchronization.
3. Structured concurrency: no `GlobalScope.launch`; scopes tied to lifecycle (`viewModelScope`, cancelled scopes).
4. Coroutine failures handled: `try` around `await`/`awaitAll`, `CoroutineExceptionHandler`; no silently dead children.
5. `runBlocking` only in tests/`main`, never in production or suspend context.
6. Blocking IO wrapped in `withContext(Dispatchers.IO)`; never Default dispatcher for blocking calls.
7. Resources closed via `use { }` (streams, channels, cursors); Flows collected in a cancellable scope.
8. No `lateinit var` for values that can legitimately be absent — nullable or `lazy` instead.
9. Public API does not leak mutable collections or builders — return read-only views.
10. `==` vs `===` intentional; `data class` equals/hashCode consistent with usage in sets/maps.
11. Java platform types null-checked before use; no blind smart-cast assumptions.
12. `companion object`/`object` singletons hold no mutable config; static state thread-safe.
13. No empty catch; `require`/`check` for precondition/invariant failures with messages.
14. Hot-path collections use `Sequence` for large data; avoid repeated `map`/`filter` materialization.
15. Opt-in experimental APIs (`@Experimental*`) documented; no unjustified new dependency.

## Typical Severity Examples

- CRITICAL: user input passed into `Runtime.exec` or raw SQL; credentials logged.
- MAJOR: `GlobalScope.launch` leaking work past screen death; `!!` NPE on a production path; Flow collected without cancellation.
- MINOR: `!!` in test setup; long `apply` chains with hidden side effects.
- INFO: naming outside Kotlin conventions; inconsistent expression vs block body.

Severity → verdict mapping: see common.md.
