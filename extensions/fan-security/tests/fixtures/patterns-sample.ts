/**
 * FIXTURE (TC-F-2.3-1) — фейковый код с CWE-сигнатурами для scan-patterns (F-2.3).
 * Файл НЕ исполняется и НЕ компилируется тестами — это только текст для сканера.
 * Секретов здесь нет (это зона scan-secrets, F-2.2) — только CWE-сигнатуры кода.
 *
 * На каждую группу сигнатур (§4 спеки) — пара «уязвимая строка → безопасный аналог»;
 * ожидаемый CWE указан в комментарии-маркере. Сами токены сигнатур в комментариях
 * НЕ упоминаются, чтобы не создавать ложные срабатывания сканера.
 *
 * Тесты (tests/scan-patterns.test.mjs) ищут строки по подстрокам-маркерам, а не по
 * номерам: содержимое можно дополнять, но не переименовывать маркерные фрагменты.
 */

import { exec, execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

const db = { query: (sql, params) => [] };

// ── SQL injection: CWE-89 ────────────────────────────────────────────────────

// [CWE-89] VULN: запрос склеивается из переменных
const unsafeQuery = "SELECT * FROM users WHERE name = '" + userName + "'";

// [SAFE] параметризованный запрос — не сигнатура
db.query("SELECT * FROM users WHERE id = ?", [userId]);

// ── Command injection: CWE-78 ────────────────────────────────────────────────

// [CWE-78] VULN: команда собирается из пользовательского ввода
exec(`rm -rf ${userInput}`);

// [SAFE] запуск через массив аргументов — не сигнатура
execFile("rm", ["-rf", buildDir]);

// ── Path traversal: CWE-22 ───────────────────────────────────────────────────

// [CWE-22] VULN: пользовательский ввод попадает в путь без нормализации
const unsafePath = path.join(uploadDir, userInput);

// [SAFE] нормализация ввода перед сборкой пути — не сигнатура
const safePath = path.join(uploadDir, path.normalize(userInput));

// ── XSS: CWE-79 ──────────────────────────────────────────────────────────────

// [CWE-79] VULN: пользовательский ввод попадает в разметку страницы
document.getElementById("out").innerHTML = userInput;

// [SAFE] безопасное свойство для текста — не сигнатура
document.getElementById("out").textContent = userInput;

// ── Weak crypto: CWE-327 ─────────────────────────────────────────────────────

// [CWE-327] VULN: устаревший алгоритм хэширования №1
const weakHash = createHash("md5").update(password).digest("hex");

// [CWE-327] VULN: устаревший алгоритм хэширования №2
const legacyHash = createHash("sha1").update(token).digest("hex");

// [CWE-327] VULN: прямая функция устаревшего хэша
const checksum = md5(payload);

// [SAFE] современный алгоритм хэширования — не сигнатура
const strongHash = createHash("sha256").update(password).digest("hex");

// ── Weak randomness: CWE-338 ─────────────────────────────────────────────────

// [CWE-338] VULN: предсказуемая случайность для security-значения
const sessionToken = Math.random().toString(36).slice(2);

// [SAFE] криптостойкий источник случайности — не сигнатура
const sessionId = randomBytes(16).toString("hex");

// ── Hardcoded IV/nonce: CWE-329 ──────────────────────────────────────────────

// [CWE-329] VULN: фиксированный инициализирующий вектор-литерал
const cipher = createCipheriv("aes-256-cbc", key, "0123456789abcdef");

// [SAFE] вектор генерируется случайно на каждый вызов — не сигнатура
const randomIv = randomBytes(16);
const secureCipher = createCipheriv("aes-256-cbc", key, randomIv);
