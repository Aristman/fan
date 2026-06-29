import type { Fact, FactCategory, FactSignificance, UserSectionName } from "./types.js";

interface ExtractableMessage {
	role: string;
	content: string | Array<{ type?: string; text?: string }>;
}

interface Pattern {
	triggers: RegExp[];
	category: FactCategory;
	section: UserSectionName;
}

const PATTERNS: Pattern[] = [
	{
		triggers: [
			/я предпочитаю/i, /использую/i, /люблю (использовать|писать|кодить)/i,
			/всегда использую/i, /обычно/i, /как правило/i,
			/I prefer/i, /I use /i, /I like (to |using )/i,
			/I always/i, /I usually/i, /I typically/i,
		],
		category: "preference",
		section: "preferences",
	},
	{
		triggers: [
			/выбрал/i, /решил/i, /остановился на/i, /перешёл на/i,
			/выбрала/i, /решила/i,
			/chose /i, /decided /i, /went with /i, /picked /i,
			/switched to /i,
		],
		category: "decision",
		section: "projects",
	},
	{
		triggers: [
			/всегда делай/i, /никогда не/i, /не делай/i,
			/обязательно/i, /важно:/i, /помни/i, /правило:/i,
			/не забывай/i, /учти/i,
			/always /i, /never /i, /don't /i, /do not /i,
			/make sure /i, /remember to /i, /rule:/i,
		],
		category: "instruction",
		section: "preferences",
	},
	{
		triggers: [
			/работаю с/i, /мой стек/i, /технологии/i,
			/над проектом/i, /занимаюсь/i, /проект —/i,
			/I work with/i, /my stack/i, /currently using/i,
			/I'm working on/i, /technologies/i,
		],
		category: "context",
		section: "context",
	},
];

const SENSITIVE_PATTERNS = [
	/password/i, /api[_-]?key/i, /secret/i, /token:\s*\S+/i,
	/sk-[a-zA-Z0-9]{20,}/, /Bearer\s+[^\s]+/i, /credentials/i,
];

const TECH_KEYWORDS = [
	"react", "vue", "angular", "node", "python", "typescript", "javascript",
	"sql", "postgres", "mysql", "mongodb", "redis", "docker", "kubernetes",
	"git", "github", "linux", "windows", "vscode", "vim", "jest", "vitest",
	"webpack", "vite", "eslint", "prettier", "pnpm", "npm", "yarn",
	"prisma", "drizzle", "express", "fastify", "next", "nuxt",
	"redux", "zustand", "mobx", "tailwind", "sass", "css",
	"kotlin", "java", "rust", "go", "swift", "dart", "flutter",
	"compose", "gradle", "maven", "spring", "ktor",
	"claude", "openai", "anthropic", "gemini", "ollama",
];

function extractText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((p) => p.type !== "image" && p.text)
		.map((p) => p.text!)
		.join("\n");
}

export class Extractor {
	analyze(messages: ExtractableMessage[]): Fact[] {
		const facts: Fact[] = [];
		const seen = new Set<string>();

		for (const msg of messages) {
			if (msg.role !== "user") continue;
			const text = extractText(msg.content);
			if (text.length < 10) continue;
			if (this.hasSensitiveContent(text)) continue;

			const fact = this.extractFact(text);
			if (!fact) continue;

			const normalized = fact.content.trim().toLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);

			facts.push(fact);
		}

		return facts;
	}

	private extractFact(text: string): Fact | null {
		for (const pattern of PATTERNS) {
			for (const trigger of pattern.triggers) {
				const match = text.match(trigger);
				if (!match) continue;

				// Extract the fact — take the sentence containing the match
				const sentenceStart = Math.max(0, match.index! - 80);
				const sentenceEnd = Math.min(text.length, match.index! + match[0].length + 120);
				let factText = text.slice(sentenceStart, sentenceEnd).trim();

				// Clean up boundaries
				if (sentenceStart > 0 && !/^[-–—.,;!?\s]/.test(factText)) {
					const dotIdx = factText.indexOf(". ");
					if (dotIdx > 0) factText = factText.slice(dotIdx + 2);
				}
				if (sentenceEnd < text.length && !/[-–—.,;!?\s]$/.test(factText)) {
					const dotIdx = factText.lastIndexOf(". ");
					if (dotIdx > 0) factText = factText.slice(0, dotIdx + 1);
				}

				factText = factText.replace(/\s+/g, " ").trim();
				if (factText.length < 15) continue;

				return {
					content: factText,
					category: pattern.category,
					tags: this.extractTags(factText),
					section: pattern.section,
				};
			}
		}

		return null;
	}

	classifyFact(fact: Fact): FactSignificance {
		if (fact.category === "decision" || fact.category === "instruction") return "substantial";
		if (fact.content.length > 150) return "substantial";
		if (fact.section === "projects") return "substantial";
		return "trivial";
	}

	mapToSection(category: FactCategory): UserSectionName {
		const map: Record<FactCategory, UserSectionName> = {
			preference: "preferences",
			decision: "projects",
			instruction: "preferences",
			context: "context",
		};
		return map[category];
	}

	hasSensitiveContent(text: string): boolean {
		return SENSITIVE_PATTERNS.some((p) => p.test(text));
	}

	private extractTags(text: string): string[] {
		const lower = text.toLowerCase();
		return TECH_KEYWORDS.filter((kw) => lower.includes(kw)).slice(0, 5);
	}
}
