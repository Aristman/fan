# Filter Patterns

Паттерны для исключения файлов при анализе репозитория.

## Директории (исключаются полностью)

```
node_modules/
.git/
dist/
build/
.next/
.nuxt/
__pycache__/
target/
.gradle/
.idea/
.vscode/
vendor/
.venv/
venv/
env/
coverage/
.nyc_output/
.turbo/
.cache/
.parcel-cache/
.bazel/
out/
.output/
.vercel/
.netlify/
wp-content/
bower_components/
.mypy_cache/
.pytest_cache/
.ruff_cache/
.amber_cache/
.dart_tool/
.cargo/registry/
```

## Файлы по расширению (исключаются)

### Двоичные / медиа
```
.min.js
.min.css
.map
.png
.jpg
.jpeg
.gif
.ico
.webp
.svg
.bmp
.mp4
.mp3
.wav
.ogg
.flac
.ttf
.woff
.woff2
.eot
.otf
.wasm
.pdf
.doc
.docx
.xls
.xlsx
.ppt
.pptx
.zip
.tar
.gz
.rar
.7z
.dll
.so
.dylib
.o
.a
.lib
.exe
.bin
.dat
.db
.sqlite
.lock
```

### Генерируемые / артефакты
```
.log
.pyc
.class
.pyc
.tsbuildinfo
.d.ts (только в node_modules/@types/ или если рядом есть .js)
.snap
.generated.
```

## Файлы по имени (исключаются)

```
.gitignore
.gitattributes
.editorconfig
.DS_Store
Thumbs.db
.eslintcache
.prettierignore
npm-debug.log
yarn-error.log
yarn.lock
package-lock.json
pnpm-lock.yaml
composer.lock
Gemfile.lock
Cargo.lock
go.sum
```

## Исключения из исключений (НЕ фильтровать)

Эти файлы важны для анализа даже если их расширение обычно исключается:

- `package-lock.json` — НО извлеки только `dependencies`, не весь файл
- `yarn.lock` — НО только для определения точных версий
- `go.sum` — НЕ фильтровать (важен для Go)
- `*.d.ts` в корне проекта или `src/` — НЕ фильтровать (собственные типы)
- `*.generated.*` — зависит от контекста (GraphQL генерация, protobuf и т.д.)

## Применение

Фильтрация применяется через проверку пути файла:
1. Если путь содержит любую из исключающих директорий → исключить
2. Если расширение файла в списке исключений → исключить
3. Если имя файла в списке исключений → исключить
4. Если попадает в исключения из исключений → оставить
