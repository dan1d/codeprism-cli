/**
 * Helpers for loading cached graph data from the local codeprism.db
 * for incremental re-index (--repo flag with multi-repo workspace).
 *
 * When re-indexing a single repo, we load cached graph_edges and file_index
 * for the OTHER repos so cross-service card generation still sees all repos.
 */

import type Database from "better-sqlite3";

export interface CachedGraphEdge {
  source_file: string;
  target_file: string;
  relation: string;
  metadata: string;
  repo: string;
}

export interface CachedFileEntry {
  path: string;
  repo: string;
  branch: string;
  file_role: string;
  parsed_data: string;
  heat_score: number;
  updated_at: string | null;
}

/**
 * Load graph_edges for the given repos from the existing DB.
 * Returns edges whose `repo` column matches any of the provided repo names.
 */
export function loadCachedGraphEdges(
  db: Database.Database,
  repos: string[],
): CachedGraphEdge[] {
  if (repos.length === 0) return [];

  const placeholders = repos.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT source_file, target_file, relation, metadata, repo
       FROM graph_edges
       WHERE repo IN (${placeholders})`,
    )
    .all(...repos) as CachedGraphEdge[];
}

/**
 * Load file_index entries for the given repos from the existing DB.
 */
export function loadCachedFileIndex(
  db: Database.Database,
  repos: string[],
): CachedFileEntry[] {
  if (repos.length === 0) return [];

  const placeholders = repos.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT path, repo, branch, file_role, parsed_data, heat_score, updated_at
       FROM file_index
       WHERE repo IN (${placeholders})`,
    )
    .all(...repos) as CachedFileEntry[];
}

/**
 * Check if cached data for a set of repos is stale (older than maxAgeDays).
 * Returns repo names whose most recent file_index.updated_at is beyond the threshold.
 */
export function checkCacheStaleness(
  db: Database.Database,
  repos: string[],
  maxAgeDays = 30,
): string[] {
  if (repos.length === 0) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffIso = cutoff.toISOString();

  const stale: string[] = [];
  for (const repo of repos) {
    const row = db
      .prepare(
        `SELECT MAX(updated_at) AS latest FROM file_index WHERE repo = ?`,
      )
      .get(repo) as { latest: string | null } | undefined;

    if (!row?.latest || row.latest < cutoffIso) {
      stale.push(repo);
    }
  }
  return stale;
}
