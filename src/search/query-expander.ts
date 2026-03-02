/**
 * Query Expansion — LLM-based synonym / paraphrase generation for BM25.
 *
 * Natural language questions ("how does the billing flow work?") share little
 * vocabulary with card text. HyDE handles the SEMANTIC leg by generating a
 * hypothetical document and embedding it; this module handles the KEYWORD leg
 * by generating 2-3 alternative keyword-focused queries that BM25 can match.
 *
 * Results are cached in a 100-entry in-process LRU to avoid re-calling the
 * LLM for repeated identical queries (common in interactive MCP sessions).
 *
 * Falls back to an empty array (= no expansion, original query only) if:
 *   - The query is short or identifier-style (BM25 already handles those well)
 *   - The LLM is unavailable or not configured
 *   - The LLM call times out after 3 seconds
 */

import { createLLMProvider } from "../llm/provider.js";

const EXPAND_TIMEOUT_MS = 3000;
const CACHE_MAX_SIZE = 100;

/** Simple LRU: insertion-order Map + delete-then-re-insert on cache hit. */
const cache = new Map<string, string[]>();

/**
 * Heuristic: skip expansion for queries where BM25 already works well.
 *
 * Identifier queries ("useAlertGeneratedEvent", "pre_authorization") are precise
 * BM25 targets — expansion would only add noise. Short queries (<4 words) get
 * embedded directly; LLM overhead isn't worth the latency.
 */
function shouldSkipExpansion(query: string): boolean {
  const tokens = query.trim().split(/\s+/);
  if (tokens.length < 4) return true;
  return tokens.some(
    (t) => /^[A-Z][a-z]+[A-Z]/.test(t) || /^[a-z]{2,}_[a-z]/.test(t),
  );
}

/**
 * Expands a natural-language query into 0-3 alternative keyword-focused queries.
 *
 * The returned queries are intended for additional BM25 passes alongside the
 * original query. Results for all queries are merged, keeping the best rank
 * per card across all keyword searches.
 *
 * @returns Array of alternative queries (may be empty if expansion was skipped).
 */
export async function expandQuery(query: string): Promise<string[]> {
  if (shouldSkipExpansion(query)) return [];

  // LRU cache lookup — re-insert on hit to mark as recently used
  if (cache.has(query)) {
    const cached = cache.get(query)!;
    cache.delete(query);
    cache.set(query, cached);
    return cached;
  }

  const llm = createLLMProvider();
  if (!llm) return [];

  const prompt =
    `Generate 3 short keyword-focused search queries that could find the same ` +
    `code feature or concept as this developer question:\n"${query}"\n\n` +
    `Rules:\n` +
    `- Use different technical vocabulary than the question (synonyms, patterns, class types)\n` +
    `- 3-7 words each, no punctuation or explanations\n` +
    `- One query per line\n\n` +
    `Queries:`;

  try {
    const raw = await Promise.race([
      llm.generate(prompt, { maxTokens: 80, temperature: 0.2 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("expand timeout")), EXPAND_TIMEOUT_MS),
      ),
    ]);

    const queries = raw
      .split("\n")
      .map((l) => l.trim().replace(/^[-\d.)]\s*/, "").trim())
      .filter((l) => l.length > 3 && l.length < 120)
      .slice(0, 3);

    // LRU eviction: remove oldest entry when full
    if (cache.size >= CACHE_MAX_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(query, queries);

    return queries;
  } catch {
    // LLM unavailable, quota exceeded, or timeout — no expansion
    return [];
  }
}
