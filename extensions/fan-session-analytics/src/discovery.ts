/**
 * Обнаружение установленных скилов и доступных моделей.
 * Используется в мастере init для интерактивного выбора.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Найденный скилл */
export interface DiscoveredSkill {
	/** Имя скилла (из frontmatter `name:` или имя каталога) */
	name: string;
	/** Откуда обнаружен */
	source: string;
}

/**
 * Загрузить список установленных скилов.
 * Источники:
 *   1. ~/.fan/agent/skills/ * /SKILL.md
 *   2. <cwd>/.fan/skills/ * /SKILL.md
 * Имя — из frontmatter `name:` (первая строка вида `name: xxx`) или fallback — имя каталога.
 */
export function discoverInstalledSkills(cwd: string): DiscoveredSkill[] {
	const seen = new Set<string>();
	const results: DiscoveredSkill[] = [];

	const scanDir = (baseDir: string, source: string) => {
		try {
			const entries = readdirSync(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const skillDir = join(baseDir, entry.name);
				const skillMd = join(skillDir, "SKILL.md");
				let name = entry.name; // fallback — имя каталога
				try {
					const raw = readFileSync(skillMd, "utf-8");
					const parsed = parseSkillName(raw);
					if (parsed) name = parsed;
				} catch {
					// нет SKILL.md — используем имя каталога
				}
				if (!seen.has(name)) {
					seen.add(name);
					results.push({ name, source });
				}
			}
		} catch {
			// каталог не существует или недоступен
		}
	};

	// 1. Глобальные скилы
	scanDir(join(homedir(), ".fan", "agent", "skills"), "global");

	// 2. Проектные скилы
	scanDir(join(cwd, ".fan", "skills"), "project");

	return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Распарсить имя скилла из содержимого SKILL.md.
 * Формат frontmatter:
 *   ---
 *   name: skill-name
 *   ...
 *   ---
 */
export function parseSkillName(content: string): string | null {
	const lines = content.split("\n");
	let inFrontmatter = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "---") {
			if (!inFrontmatter) {
				inFrontmatter = true;
				continue;
			}
			// конец frontmatter
			break;
		}
		if (inFrontmatter) {
			const match = /^name:\s*(.+)$/.exec(trimmed);
			if (match) {
				return match[1].trim().replace(/^["']|["']$/g, "");
			}
		}
	}
	return null;
}

/** Модель для выбора (упрощённое представление) */
export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
	costInput?: number;
}

/** Провайдер для выбора */
export interface ProviderChoice {
	provider: string;
	label: string;
	modelCount: number;
}

/**
 * Сгруппировать доступные модели по провайдерам.
 * Принимает массив Model-подобных объектов (getAvailable() результат).
 */
export function groupModelsByProvider(
	models: Array<{ provider: string; id: string; name: string; contextWindow?: number; cost?: { input: number } }>,
): { providers: ProviderChoice[]; modelsByProvider: Map<string, ModelChoice[]> } {
	const modelsByProvider = new Map<string, ModelChoice[]>();

	for (const m of models) {
		const list = modelsByProvider.get(m.provider) || [];
		list.push({
			provider: m.provider,
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			costInput: m.cost?.input,
		});
		modelsByProvider.set(m.provider, list);
	}

	const providers: ProviderChoice[] = [];
	for (const [provider, list] of modelsByProvider) {
		providers.push({
			provider,
			label: `${provider} (${list.length} ${pluralModel(list.length)})`,
			modelCount: list.length,
		});
	}
	providers.sort((a, b) => a.provider.localeCompare(b.provider));

	return { providers, modelsByProvider };
}

function pluralModel(n: number): string {
	const abs = Math.abs(n);
	const mod10 = abs % 10;
	const mod100 = abs % 100;

	if (mod10 === 1 && mod100 !== 11) return "модель";
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "модели";
	return "моделей";
}
