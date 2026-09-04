---
stack: index
version: 1.0
---

# Review Rules Corpus

Static rule files for the FAN `code-review` worker (read-only reviewer). Six files, each ≤ 5000 bytes: the worker's context budget is 22500 chars, so rules stay compact and dense.

| File | Purpose |
|------|---------|
| `common.md` | Severity model (CRITICAL/MAJOR/MINOR/INFO), severity→verdict mapping (APPROVED / CHANGES_REQUESTED / NEEDS_DISCUSSION), cross-stack rules and typical bugs. |
| `typescript.md` | TS/JS detection hints, reviewer checklist, typical findings. |
| `python.md` | Python detection hints, reviewer checklist, typical findings. |
| `kotlin.md` | Kotlin/Java detection hints, reviewer checklist, typical findings. |
| `rust.md` | Rust detection hints, reviewer checklist, typical findings. |

## Loading order: common.md → <stack>.md → conventions.md

The worker loads `common.md` first, then exactly one stack file chosen by project manifest (`package.json`→typescript, `pyproject.toml`→python, `Cargo.toml`→rust, `build.gradle.kts`/`pom.xml`→kotlin), then the project-local `conventions.md` (`.fan/code-review/conventions.md`) if present. Rules are additive; `conventions.md` may override style-level (INFO/MINOR) items only.
