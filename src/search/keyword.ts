import { getDb } from "../db/connection.js";

export interface KeywordResult {
  cardId: string;
  rank: number;
}

/**
 * FTS5 operators that must be excluded to prevent query injection.
 * Tokens are left unquoted so the Porter stemmer can apply its stemming rules
 * (quoted tokens in FTS5 bypass tokenizers and do exact-match only).
 */
const FTS5_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

/**
 * Tokenizes a raw query into safe FTS5 tokens:
 * - Splits CamelCase identifiers
 * - Strips URLs and special characters
 * - Filters FTS5 boolean operators (injection prevention)
 *
 * Tokens are intentionally NOT quoted so the Porter stemmer configured in
 * migration v15 can stem them — "authorization" will match "authorized",
 * "authorizes", etc.
 */
function tokenizeFts5(raw: string): string[] {
  const camelSplit = raw.replace(/([a-z])([A-Z])/g, "$1 $2");
  const cleaned = camelSplit
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-zA-Z0-9_\s]/g, " ");
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS5_OPERATORS.has(t.toUpperCase()))
    .slice(0, 30);
}

/**
 * Builds an AND query (space-separated tokens, implicit AND in FTS5).
 * High precision — requires all tokens to appear in a card.
 */
export function buildAndQuery(tokens: string[]): string {
  return tokens.join(" ");
}

/**
 * Builds an OR query (tokens joined with OR).
 * High recall — any token match qualifies.
 */
export function buildOrQuery(tokens: string[]): string {
  return tokens.join(" OR ");
}

/**
 * Sanitizes raw text into a safe FTS5 query (OR mode, for backward compat).
 * Used by tests and callers that explicitly want OR semantics.
 */
export function sanitizeFts5Query(raw: string): string {
  const tokens = tokenizeFts5(raw);
  return tokens.length === 0 ? "" : buildOrQuery(tokens);
}

export { FTS5_OPERATORS };

const BM25_WEIGHTS = "bm25(cards_fts, 3.0, 1.0, 2.0, 2.0, 1.5, 2.0)";
const FTS_SELECT = `SELECT rowid, ${BM25_WEIGHTS} as rank FROM cards_fts WHERE cards_fts MATCH ? ORDER BY rank LIMIT ?`;

/**
 * Performs full-text search against the `cards_fts` FTS5 virtual table.
 *
 * Strategy: AND-first, then OR fallback.
 * - AND pass: requires ALL tokens to appear in a card (high precision).
 *   e.g. "inactive patient authorization" → only cards that mention all three.
 * - OR fallback: if AND returns nothing, retries with any-token match (high recall).
 *   Prevents zero results for multi-word queries where tokens are spread across fields.
 *
 * Column weights: title(3.0), content(1.0), flow(2.0), source_repos(2.0), tags(1.5), identifiers(2.0)
 */
export function keywordSearch(query: string, limit = 10): KeywordResult[] {
  const tokens = tokenizeFts5(query);
  if (tokens.length === 0) return [];

  const db = getDb();

  function runFts(ftsQuery: string): { rowid: number; rank: number }[] {
    try {
      return db.prepare(FTS_SELECT).all(ftsQuery, limit) as { rowid: number; rank: number }[];
    } catch {
      return [];
    }
  }

  // AND pass — try all tokens required
  let rows = runFts(buildAndQuery(tokens));

  // OR fallback — broaden to any-token match when AND returns nothing
  if (rows.length === 0 && tokens.length > 1) {
    rows = runFts(buildOrQuery(tokens));
  }

  if (rows.length === 0) return [];

  // Resolve all rowids in a single query instead of N individual lookups
  const placeholders = rows.map(() => "?").join(",");
  const cardRows = db
    .prepare(`SELECT id, rowid FROM cards WHERE rowid IN (${placeholders})`)
    .all(...rows.map((r) => r.rowid)) as { id: string; rowid: number }[];

  const rowidToId = new Map(cardRows.map((c) => [c.rowid, c.id]));

  return rows.flatMap((row) => {
    const cardId = rowidToId.get(row.rowid);
    return cardId ? [{ cardId, rank: row.rank }] : [];
  });
}
