import type { MemoryCategory, MemoryScope } from "../types.js";
import type { MemoryDatabase } from "../storage/database.js";

// ──────────────────────────────────────────────
// FTS4 full-text search
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
  // ──────────────────────────────────────────
  // Russian stop words
  // ──────────────────────────────────────────
  "в", "на", "с", "по", "из", "за", "от", "до", "к", "у", "о", "об", "при", "через",
  "для", "без", "про", "над", "под", "из-за",
  "и", "а", "но", "или", "что", "чтобы", "когда", "если", "как", "так",
  "не", "нет", "да", "уже", "ещё", "тоже", "также", "только", "даже",
  "это", "то", "всё", "он", "она", "оно", "они", "мы", "вы", "ты", "я",
  "его", "её", "их", "наш", "ваш", "мой", "свой", "себя",
  "сам", "такой", "этот", "тот", "который", "чей", "кто", "что",
  "быть", "есть", "был", "была", "было", "будет", "будут",
  "может", "могут", "мочь", "должен", "должны",
  "тот", "этот", "такой", "каждый", "другой", "иной",
  "же", "ли", "бы", "ведь", "вот", "вон", "мол", "дескать",
]);

export interface FTSSearchResult {
  id: string;
  rowid: number;
  rank: number;
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

  // Preprocess query: tokenize, remove stop words, build FTS query
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s\-_\/\.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return [];

  // Build FTS query: always use OR for better recall
  // Ranking will naturally prioritize better matches
  const ftsQuery = tokens.join(" OR ");

  let sql = `
    SELECT m.id, m.rowid, length(offsets(memories_fts)) AS rank
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
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

  sql += " ORDER BY rank DESC LIMIT ?";

  params.push(limit);

  try {
    return db.getDb().prepare(sql).all(...params) as FTSSearchResult[];
  } catch {
    // FTS4 can throw on malformed queries, return empty
    return [];
  }
}
