---
stack: rust
version: 1.0
---

# Review Rules: Rust

## Stack Detection Hints

Manifests: `Cargo.toml`, `Cargo.lock`; workspace `[workspace]` members reviewed per manifest.
File extensions: `.rs`; `build.rs` scripts reviewed too.
Tooling: cargo, clippy (`cargo clippy`), rustfmt, cargo-test, miri for unsafe code.

## Reviewer Checklist

1. No `unsafe` without a `// SAFETY:` comment proving the invariant; keep its scope minimal.
2. No `unwrap()`/`expect()` on external input, IO, parses, or lock acquisition in production paths — propagate with `?`.
3. Fallible results handled: no `let _ =` on a `Result` that can fail; error context via `thiserror`/`anyhow`.
4. Panics audited: indexing, slicing, and integer overflow on untrusted data use `checked_*`/`saturating_*`/`get`.
5. No blocking calls (std fs, `Mutex::lock`, heavy CPU) inside async contexts — use `spawn_blocking` or async equivalents.
6. No std::sync::Mutex guard held across an `.await` point (deadlock/`Send` hazard) — use tokio::sync::Mutex.
7. `Send`/`Sync` bounds of spawned tasks verified; no shared-state race via `Arc<Mutex>` misuse.
8. Lifetimes honest: no `&'static` lies, no `transmute`; borrows do not escape their scope.
9. RAII: cleanup in `Drop`; no accidental leaks (`mem::forget`, `Box::leak`, `into_raw`) without intent.
10. `clone()` justified in hot paths — prefer borrows; no clone-to-satisfy-the-borrow-checker in loops.
11. Unbounded channels/queues flagged for growth; select loops have timeout/default against hangs.
12. FFI/`libc` return codes checked; C strings valid and NUL-terminated.
13. Task cancellation tolerated: aborted tasks leave no half-committed state.
14. Public API does not leak internal concrete types unintentionally; errors implement `std::error::Error`.
15. No unconditional heavy dependency; `default-features = false` where sensible.

## Typical Severity Examples

- CRITICAL: `unsafe` pointer dereference without a valid invariant; path/command built from input without canonicalization.
- MAJOR: `unwrap()` on user-supplied JSON; mutex guard held across `.await`; unbounded channel growth.
- MINOR: needless per-iteration `clone()`; `pub` on internal items; TODO without an issue link.
- INFO: clippy pedantic-level lints; naming outside Rust API guidelines.

Severity → verdict mapping: see common.md.
