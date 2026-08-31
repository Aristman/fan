# FIXTURE (TC-F-2.4-2)

Директория БЕЗ манифестов зависимостей: нет package.json / requirements.txt /
pyproject.toml / Cargo.toml. `scanDepAudits` обязан вернуть findings=[],
предупредить в stderr («no manifests») и дать exit-код 0 — это НЕ ошибка
(спека §3.3: «отсутствие манифестов/утилит → информативное сообщение, не падение»).

Единственный файл здесь намеренно НЕ манифест.
