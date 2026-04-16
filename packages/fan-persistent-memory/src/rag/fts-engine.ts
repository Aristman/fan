import type { MemoryCategory, MemoryScope } from "../types.js";
import type { MemoryDatabase } from "../storage/database.js";
import { stemQuery, detectLang } from "./stemmer.js";
import { expandQuery, expandToFTS } from "./expander.js";

// ──────────────────────────────────────────────
// FTS5 full-text search
// ──────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "at", "of", "on", "in", "to", "for", "and", "or",
  "but", "not", "with", "as", "by", "from", "it", "this", "that", "are",
  "be", "was", "were", "has", "have", "had", "do", "does", "did", "can",
  "could", "will", "would", "should", "may", "might", "must", "shall",
  "i", "me", "my", "we", "you", "your", "he", "she", "they", "them",
  "what", "which", "who", "how", "when", "where", "why", "if", "then",
  "so", "no", "yes", "up", "out", "all", "any", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "than", "too", "very",
  "just", "about", "also", "only", "own", "same", "been", "being",

  // Russian stop words
  "и", "в", "на", "с", "по", "к", "из", "за", "от", "для", "о", "у", "не", "а", "но", "да", "как", "это", "он", "она", "они", "мы", "вы", "я", "ты", "что", "где", "когда", "почему", "кто", "чей", "какой", "какая", "какие", "каком", "бы", "был", "была", "были", "было", "будет", "будут", "мог", "могла", "могли", "можно", "нужно", "надо", "уже", "ещё", "еще", "тоже", "также", "ли", "только", "очень", "весь", "все", "всё", "свой", "своя", "свои", "мой", "моя", "мои", "наш", "наша", "наши", "этот", "эта", "эти", "тот", "та", "те", "им", "их", "ему", "её", "ей", "нам", "нас", "мне",
]);

export interface FTSSearchResult {
  id: string;
  rowid: number;
  rank: number;
  relaxed: boolean;  // true if query was relaxed
  strategy: "exact" | "expanded" | "topn";  // which strategy produced results
}

export function ftsSearch(
  query: string,
  db: MemoryDatabase,
  opts?: {
    scope?: MemoryScope | "both";
    category?: MemoryCategory;
    limit?: number;
  }
): FTSSearchResult[] {
  const limit = opts?.limit ?? 15;

  // Step 1: Detect language
  const lang = detectLang(query);

  // Step 2: Tokenize, remove stop words
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s\-_\/\.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return [];

  // Step 3: Stem tokens
  const stemmed = stemQuery(tokens.join(" "), lang)
    .map((p) => p.stemmed)
    .filter((s) => s.length > 0);

  // Deduplicate stemmed tokens while preserving order
  const uniqueStemmed = [...new Set(stemmed)];

  // Step 4: Expand via synonyms
  const expansion = expandQuery(tokens.join(" "), lang);
  const allExpandedTerms = new Set<string>();
  for (const [, synonyms] of expansion.expanded) {
    for (const syn of synonyms) {
      allExpandedTerms.add(syn.includes(" ") ? `"${syn}"` : syn);
    }
  }
  for (const mw of expansion.multiWord) {
    allExpandedTerms.add(mw.includes(" ") ? `"${mw}"` : mw);
  }

  // Helper: execute FTS query
  function executeFTS(ftsQuery: string): FTSSearchResult[] {
    let sql = `
      SELECT m.id, m.rowid, f.rank
      FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
        AND m.archived = 0
    `;

    const params: unknown[] = [ftsQuery];

    if (opts?.scope && opts.scope !== "both") {
      sql += " AND m.scope = ?";
      params.push(opts.scope);
    }

    if (opts?.category) {
      sql += " AND m.category = ?";
      params.push(opts.category);
    }

    sql += " ORDER BY f.rank LIMIT ?";

    params.push(limit);

    try {
      return db.getDb().prepare(sql).all(...params) as FTSSearchResult[];
    } catch {
      return [];
    }
  }

  function annotate(results: FTSSearchResult[], strategy: "exact" | "expanded" | "topn", relaxed: boolean): FTSSearchResult[] {
    return results.map((r) => ({ ...r, relaxed, strategy }));
  }

  // Strategy 1: AND of stemmed tokens + quoted original important tokens
  const importantTokens = tokens.filter((t) => t.length > 2);
  const exactParts: string[] = [...uniqueStemmed];
  if (importantTokens.length > 0 && importantTokens.length <= 4) {
    for (const t of importantTokens) {
      exactParts.push(`"${t}"`);
    }
  }
  const exactQuery = exactParts.join(" ");
  let results = executeFTS(exactQuery);
  if (results.length > 0) {
    return annotate(results, "exact", false);
  }

  // Strategy 2: OR of all expanded synonyms
  if (allExpandedTerms.size > 0) {
    const expandedQuery = [...allExpandedTerms].join(" OR ");
    results = executeFTS(expandedQuery);
    if (results.length > 0) {
      return annotate(results, "expanded", true);
    }
  }

  // Strategy 3: Top 2 stemmed tokens with OR
  const topTokens = uniqueStemmed.slice(0, 2);
  if (topTokens.length > 0) {
    const topQuery = topTokens.join(" OR ");
    results = executeFTS(topQuery);
    if (results.length > 0) {
      return annotate(results, "topn", true);
    }
  }

  return [];
}

// ──────────────────────────────────────────────
// Query preprocessing helpers
// ──────────────────────────────────────────────

export function preprocessQuery(query: string): {
  keywords: string[];
  stemmed: string[];
  expanded: Map<string, string[]>;
  ftsQuery: string;
} {
  const lang = detectLang(query);

  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s\-_\/\.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  // Stem tokens
  const stemmedPairs = stemQuery(tokens.join(" "), lang);
  const stemmed = [...new Set(stemmedPairs.map((p) => p.stemmed).filter((s) => s.length > 0))];

  // Expand via synonyms
  const expansion = expandQuery(tokens.join(" "), lang);
  const expanded = expansion.expanded;

  // Build FTS query (same logic as ftsSearch strategy 1)
  const importantTokens = tokens.filter((t) => t.length > 2);
  const ftsParts: string[] = [...stemmed];
  if (importantTokens.length > 0 && importantTokens.length <= 4) {
    for (const t of importantTokens) {
      ftsParts.push(`"${t}"`);
    }
  }
  const ftsQuery = ftsParts.join(" ");

  return { keywords: tokens, stemmed, expanded, ftsQuery };
}
