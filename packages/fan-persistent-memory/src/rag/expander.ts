// ──────────────────────────────────────────────
// Query expansion — synonym dictionary
// ──────────────────────────────────────────────
// Zero dependencies. JSON-based synonym map.
// Supports directional mapping and multi-word
// expansion. Extensible via config or code.
//
// Used by FTS engine to expand queries before
// MATCH. NOT used for vector search (embeddings
// are already semantically robust).
// ──────────────────────────────────────────────

import { detectLang, type Lang } from "./stemmer.js";

// ──────────────────────────────────────────────
// Synonym dictionary
// ──────────────────────────────────────────────
// Key = canonical form, value = array of synonyms.
// First element is always the key itself.
// Directional: "deploy" → ["deploy", "развертывание", "деплой"]
// but "деплой" also maps to the same group via lookup.

type SynonymGroup = string[];

interface SynonymEntry {
  canonical: string;
  synonyms: string[];
}

/**
 * Built-in synonym dictionary.
 * Organized by domain. ~80 pairs.
 *
 * Design:
 * - Keys are lowercase
 * - Synonyms include the key itself
 * - bidirectional: all forms in a group map to the same group
 * - Multi-word phrases supported (space-separated)
 */
const BUILTIN_SYNONYMS: Record<string, string[]> = {
  // ─── Deployment / Operations ────────────
  "deploy": ["deploy", "развертывание", "деплой", "деплоить", "deployment"],
  "build": ["build", "сборка", "билд", "компиляция"],
  "release": ["release", "релиз", "выпуск", "версия"],
  "ci/cd": ["ci/cd", "цитцд", "ci cd", "непрерывная интеграция"],
  "pipeline": ["pipeline", "пайплайн", "конвейер", "трубопровод"],

  // ─── Code / Development ─────────────────
  "code": ["code", "код", "исходный код", "source code"],
  "bug": ["bug", "баг", "ошибка", "defect", "дефект"],
  "refactor": ["refactor", "рефактор", "рефакторинг", "refactoring"],
  "debug": ["debug", "дебаг", "отладка", "debugging"],
  "feature": ["feature", "фича", "функциональность", "возможность"],
  "review": ["review", "ревью", "обзор кода", "code review"],
  "commit": ["commit", "коммит", "фиксация"],
  "branch": ["branch", "бранч", "ветка", "ветвь"],
  "merge": ["merge", "мерж", "слияние"],
  "test": ["test", "тест", "тестирование", "testing"],
  "mock": ["mock", "мок", "заглушка"],
  "legacy": ["legacy", "легаси", "унаследованный код"],
  "tech debt": ["tech debt", "технический долг", "technical debt"],

  // ─── Architecture ───────────────────────
  "api": ["api", "апи", "интерфейс", "endpoint"],
  "frontend": ["frontend", "фронтенд", "клиент", "front-end"],
  "backend": ["backend", "бэкенд", "сервер", "back-end"],
  "database": ["database", "бд", "база данных", "база"],
  "cache": ["cache", "кеш", "кэш"],
  "middleware": ["middleware", "мидлвар", "промежуточное по"],
  "microservice": ["microservice", "микросервис", "микросервисы"],
  "monolith": ["monolith", "монолит", "монолитный"],

  // ─── AI / ML ────────────────────────────
  "embedding": ["embedding", "ембеддинг", "векторное представление", "вектор"],
  "prompt": ["prompt", "промпт", "запрос", "prompt engineering"],
  "model": ["model", "модель", "нейросеть", "nn"],
  "rag": ["rag", "раг", "генерация с дополненной выборкой", "retrieval augmented generation"],
  "llm": ["llm", "ллм", "языковая модель", "large language model"],
  "token": ["token", "токен", "жетон"],

  // ─── pi-specific ────────────────────────
  "roadmap": ["roadmap", "роадмап", "дорожная карта", "план"],
  "session": ["session", "сессия", "сеанс"],
  "worker": ["worker", "воркер", "работник", "агент"],
  "extension": ["extension", "экстеншн", "расширение", "плагин"],
  "skill": ["skill", "скилл", "навык", "умение"],
  "orchestrator": ["orchestrator", "оркестратор", "координатор"],

  // ─── General tech ───────────────────────
  "server": ["server", "сервер"],
  "client": ["client", "клиент"],
  "log": ["log", "лог", "журнал", "логирование"],
  "config": ["config", "конфиг", "конфигурация", "настройки"],
  "dependency": ["dependency", "зависимость", "зависимости", "депенденси"],
  "package": ["package", "пакет", "пакедж"],
  "repository": ["repository", "репозиторий", "репа", "repo"],
  "framework": ["framework", "фреймворк", "каркас"],
  "library": ["library", "библиотека", "либа", "lib"],
  "docker": ["docker", "докер", "контейнер"],
  "kubernetes": ["kubernetes", "кубернетес", "k8s", "куба"],
  "linux": ["linux", "линукс"],
  "windows": ["windows", "винда", "виндовс"],
  "typescript": ["typescript", "тайпскрипт", "ts"],
  "javascript": ["javascript", "жаваскрипт", "js"],
  "python": ["python", "питон"],
  "rust": ["rust", "раст"],
  "kotlin": ["kotlin", "котлин"],
  "java": ["java", "жава"],
};

// ──────────────────────────────────────────────
// Lookup index (built from dictionary)
// ──────────────────────────────────────────────
// Maps every synonym (lowercase) → canonical key
// so we can do reverse lookups efficiently.

let lookupIndex: Map<string, string> | null = null;

function buildLookupIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [canonical, synonyms] of Object.entries(BUILTIN_SYNONYMS)) {
    const key = canonical.toLowerCase();
    idx.set(key, key);
    for (const syn of synonyms) {
      const s = syn.toLowerCase();
      if (s !== key) {
        idx.set(s, key);
      }
    }
  }
  return idx;
}

function getLookupIndex(): Map<string, string> {
  if (!lookupIndex) {
    lookupIndex = buildLookupIndex();
  }
  return lookupIndex;
}

// ──────────────────────────────────────────────
// Custom synonyms (user-extensible)
// ──────────────────────────────────────────────

const customSynonyms: Map<string, string[]> = new Map();

/**
 * Add a custom synonym mapping.
 * @param from — a word/phrase that should be expanded
 * @param to — synonyms to expand to (includes the canonical form)
 */
export function addSynonym(from: string, ...to: string[]): void {
  const key = from.toLowerCase();
  const group = [key, ...to.map((s) => s.toLowerCase())];
  customSynonyms.set(key, group);

  // Invalidate lookup cache
  lookupIndex = null;
}

/**
 * Load custom synonyms from a JSON file.
 * Format: { "word": ["synonym1", "synonym2"], ... }
 */
export function loadCustomSynonyms(
  json: Record<string, string[]>
): void {
  for (const [key, synonyms] of Object.entries(json)) {
    addSynonym(key, ...synonyms);
  }
}

// ──────────────────────────────────────────────
// Expansion
// ──────────────────────────────────────────────

export interface ExpansionResult {
  /** Original query tokens */
  original: string[];
  /** Each token expanded with its synonyms */
  expanded: Map<string, string[]>;
  /** Multi-word phrases found and expanded */
  multiWord: string[];
}

/**
 * Expand a query with synonyms.
 * Tokens are matched case-insensitively against the dictionary.
 * Multi-word phrases from the dictionary are also checked.
 *
 * @param query — raw query string
 * @param lang — 'ru', 'en', or 'auto' (default: auto-detect)
 * @returns expansion result with original tokens and their synonym groups
 */
export function expandQuery(
  query: string,
  lang?: Lang
): ExpansionResult {
  const detectedLang = lang ?? detectLang(query);
  const queryLower = query.toLowerCase();
  const tokens = queryLower.split(/\s+/).filter((t) => t.length > 0);
  const expanded = new Map<string, string[]>();
  const multiWord: string[] = [];

  const idx = getLookupIndex();

  // Check multi-word phrases first (longest first)
  const sortedMultiWord = Object.keys(BUILTIN_SYNONYMS)
    .filter((k) => k.includes(" "))
    .sort((a, b) => b.length - a.length);

  // Also check custom multi-word
  for (const [key] of customSynonyms) {
    if (key.includes(" ") && !sortedMultiWord.includes(key)) {
      sortedMultiWord.push(key);
    }
  }

  const consumedIndices = new Set<number>();

  for (const phrase of sortedMultiWord) {
    if (queryLower.includes(phrase)) {
      const group = getAllSynonyms(phrase, idx);
      multiWord.push(...group);
      // Mark consumed tokens
      const phraseTokens = phrase.split(/\s+/);
      for (const pt of phraseTokens) {
        const idx2 = tokens.indexOf(pt);
        if (idx2 !== -1) consumedIndices.add(idx2);
      }
    }
  }

  // Expand remaining single tokens
  for (let i = 0; i < tokens.length; i++) {
    if (consumedIndices.has(i)) continue;
    const token = tokens[i]!;
    const group = getAllSynonyms(token, idx);
    expanded.set(token, group);
  }

  return { original: tokens, expanded, multiWord };
}

/**
 * Get all synonyms for a single token, including the token itself.
 */
function getAllSynonyms(
  token: string,
  idx: Map<string, string>
): string[] {
  const canonical = idx.get(token.toLowerCase());
  if (!canonical) return [token];

  // Get from builtin
  let group = BUILTIN_SYNONYMS[canonical] ?? [canonical];

  // Merge with custom
  const custom = customSynonyms.get(canonical);
  if (custom) {
    const merged = new Set(group);
    for (const s of custom) merged.add(s);
    group = [...merged];
  }

  return group;
}

/**
 * Build an FTS-compatible expansion string.
 * Returns all unique synonym tokens joined with OR.
 * Useful for injection into FTS MATCH clause.
 */
export function expandToFTS(query: string, lang?: Lang): string {
  const result = expandQuery(query, lang);
  const allTerms = new Set<string>();

  // Add multi-word expansions
  for (const mw of result.multiWord) {
    // For FTS, split multi-word into quoted phrase
    if (mw.includes(" ")) {
      allTerms.add(`"${mw}"`);
    } else {
      allTerms.add(mw);
    }
  }

  // Add single-token expansions
  for (const [, synonyms] of result.expanded) {
    for (const syn of synonyms) {
      if (syn.includes(" ")) {
        allTerms.add(`"${syn}"`);
      } else {
        allTerms.add(syn);
      }
    }
  }

  // Deduplicate against original tokens to avoid noise
  return [...allTerms].join(" OR ");
}

/**
 * Get the raw synonym dictionary (for inspection/debugging).
 */
export function getSynonymDictionary(): Record<string, string[]> {
  return { ...BUILTIN_SYNONYMS };
}
