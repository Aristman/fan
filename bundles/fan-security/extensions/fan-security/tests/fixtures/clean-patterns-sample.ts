/**
 * FIXTURE (TC-F-2.3-2) — чистый файл: только безопасные аналоги групп §4.
 * Обычный код: параметризованный запрос, execFile с массивом аргументов,
 * path.normalize, textContent, sha256, crypto.randomBytes, IV из randomBytes.
 * Math.random() — ВНЕ security-контекста (игральный кубик, тестовые данные):
 * CWE-338 срабатывает только для security-имён (token/secret/password/…).
 *
 * Ожидание сканера: 0 findings, exit 0 — без ложных срабатываний.
 */

import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

export function findUserById(db, id) {
	return db.query("SELECT * FROM users WHERE id = ?", [id]);
}

export function cleanBuild(targetDir) {
	execFile("rm", ["-rf", targetDir]);
}

export function assetFile(baseDir, name) {
	return path.join(baseDir, path.normalize(name));
}

export function renderLabel(node, text) {
	node.textContent = text;
}

export function fingerprint(payload) {
	return createHash("sha256").update(payload).digest("hex");
}

export function newRequestId() {
	return randomBytes(16).toString("hex");
}

export function encryptRecord(key, plaintext) {
	const iv = randomBytes(16);
	return createCipheriv("aes-256-cbc", key, iv).update(plaintext);
}

// Не security-контекст: бросок кубика для игры, не токен/пароль/nonce.
export function diceRoll() {
	return Math.floor(Math.random() * 6) + 1;
}
