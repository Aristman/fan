---
stack: python
version: 1.0
---

# Review Rules: Python

## Stack Detection Hints

Manifests: `pyproject.toml`; also `setup.py`/`setup.cfg`, `requirements.txt`, `Pipfile`, `poetry.lock`, `uv.lock`.
File extensions: `.py`, `.pyi` (stubs); `.ipynb` notebooks usually out of diff-review scope.
Tooling: ruff, mypy/pyright, pytest, black/ruff-format, poetry/uv/pip.

## Reviewer Checklist

1. Type hints on public functions; no bare `dict`/`list` — use `dict[str, X]`, `X | None`.
2. `except Exception:` or bare `except:` must rethrow, wrap, or log — never silent swallow.
3. No mutable default arguments (`def f(x=[])`) — use a `None` sentinel instead.
4. Resources via context managers (`with open(...)`, `with session`), not manual `close()`.
5. No blocking calls (`time.sleep`, sync IO, heavy CPU) inside `async def` — use `asyncio.sleep`/async libs.
6. No `eval`/`exec`/`pickle.loads` on untrusted input; `yaml.safe_load`, never `yaml.load`.
7. SQL/shell/paths never built by f-string from user input — parameterized queries, `shlex.quote`.
8. Comparison to `None`/`True`/`False` uses `is`, not `==`.
9. Minimal module-level side effects and global mutable state.
10. Large streams processed lazily (generators/comprehensions), not materialized into lists needlessly.
11. Shared state guarded by `threading.Lock`/`asyncio.Lock`; check-then-act races flagged.
12. Custom exception types over generic `Exception`; `raise ... from err` keeps the chain.
13. Structured data crossing boundaries uses dataclasses/TypedDict, not ad-hoc dicts.
14. Tests avoid `time.sleep` waiting — use fixtures, events, or time mocking.
15. Requirements pinned in a lockfile; no unpinned `*` or floating git deps.

## Typical Severity Examples

- CRITICAL: `subprocess.run(cmd, shell=True)` with f-string user input; `pickle.loads` on a request body.
- MAJOR: bare `except: pass` hiding failures; mutable default arg leaking state between calls; blocking call in an async handler.
- MINOR: `from x import *`; `print` instead of logging; missing docstring on public API.
- INFO: camelCase functions (PEP8 violation); unsorted imports.

Severity → verdict mapping: see common.md.
