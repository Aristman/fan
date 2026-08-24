// F-24: Аутентификация узлов super-orchestrator (FAN_NODE_TOKEN).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-24
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2
//
// Дочерний узел стартует с env FAN_NODE_TOKEN (auth включён, FAN_NO_AUTH=0)
// и сидит токен в свой ClientToken store. Родитель может отозвать токен
// узла через HTTP API узла (revokeNodeToken) перед kill/пересозданием.
//
//   • generateNodeToken() — 64 hex chars (32 байта randomBytes);
//   • buildSpawnEnv(token, extra?) — { FAN_NODE_TOKEN, FAN_NO_AUTH: "0", ...extra },
//     extra может переопределять базовые ключи, входной extra не мутируется;
//   • revokeNodeToken(baseUrl, adminToken, nodeName) — GET /api/tokens →
//     найти запись по name → DELETE /api/tokens/:id → true; не найден → false;
//     сетевые ошибки → false (не бросает).

import { randomBytes } from "node:crypto";

/** Сгенерировать токен узла: 64 hex-символа (32 байта). */
export function generateNodeToken(): string {
	return randomBytes(32).toString("hex");
}

/** Env для spawn дочернего узла: токен + включённая аутентификация.
 *  `extra` может переопределять FAN_NODE_TOKEN/FAN_NO_AUTH. Входной
 *  объект не мутируется. */
export function buildSpawnEnv(token: string, extra?: Record<string, string>): Record<string, string> {
	return {
		FAN_NODE_TOKEN: token,
		FAN_NO_AUTH: "0",
		...extra,
	};
}

interface ApiTokenRecord {
	id: string;
	name: string;
	createdAt?: string;
	lastUsed?: string | null;
}

/** Отозвать токен узла через его HTTP API.
 *  GET `${baseUrl}/api/tokens` (Bearer adminToken) → запись с name === nodeName
 *  → DELETE `${baseUrl}/api/tokens/:id` (Bearer) → true.
 *  Не найден → false; сетевые ошибки → false (не бросает). */
export async function revokeNodeToken(baseUrl: string, adminToken: string, nodeName: string): Promise<boolean> {
	try {
		const listRes = await fetch(`${baseUrl}/api/tokens`, {
			method: "GET",
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		const tokens = (await listRes.json()) as ApiTokenRecord[];
		const entry = tokens.find((t) => t.name === nodeName);
		if (!entry) {
			return false;
		}
		const deleteRes = await fetch(`${baseUrl}/api/tokens/${entry.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		return deleteRes.ok;
	} catch {
		return false;
	}
}
