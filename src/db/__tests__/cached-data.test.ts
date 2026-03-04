/**
 * Unit tests for src/db/cached-data.ts
 *
 * Strategy: mock better-sqlite3's Database interface with plain objects
 * whose `.prepare()` returns a statement stub. No actual SQLite DB is
 * opened, so these tests run instantly and in parallel without file I/O.
 */

import { describe, it, expect, vi } from "vitest";
import type { Database } from "better-sqlite3";
import {
  loadCachedGraphEdges,
  loadCachedFileIndex,
  checkCacheStaleness,
  type CachedGraphEdge,
  type CachedFileEntry,
} from "../cached-data.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Database stub whose prepare() delegates to the given fn. */
function makeDb(allFn: (...args: unknown[]) => unknown[]): Database {
  const stmt = { all: vi.fn((...args: unknown[]) => allFn(...args)) };
  return { prepare: vi.fn(() => stmt) } as unknown as Database;
}

/** Build a Database stub for checkCacheStaleness, whose prepare().get() returns a row. */
function makeGetDb(getFn: (...args: unknown[]) => unknown): Database {
  const stmt = { get: vi.fn((...args: unknown[]) => getFn(...args)) };
  return { prepare: vi.fn(() => stmt) } as unknown as Database;
}

// ---------------------------------------------------------------------------
// loadCachedGraphEdges
// ---------------------------------------------------------------------------

describe("loadCachedGraphEdges", () => {
  it("returns empty array immediately when repos array is empty", () => {
    // Arrange: db should never be called
    const db = makeDb(() => []);

    // Act
    const result = loadCachedGraphEdges(db, []);

    // Assert
    expect(result).toEqual([]);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("queries with a single placeholder for a single repo", () => {
    // Arrange
    const edge: CachedGraphEdge = {
      source_file: "src/a.ts",
      target_file: "src/b.ts",
      relation: "import",
      metadata: "{}",
      repo: "my-repo",
    };
    const db = makeDb(() => [edge]);

    // Act
    const result = loadCachedGraphEdges(db, ["my-repo"]);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edge);

    // Verify the SQL contains exactly one placeholder
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE repo IN \(\?\)/);
  });

  it("generates a comma-separated placeholder list for multiple repos", () => {
    // Arrange
    const edges: CachedGraphEdge[] = [
      { source_file: "a.ts", target_file: "b.ts", relation: "import", metadata: "{}", repo: "repo-a" },
      { source_file: "c.ts", target_file: "d.ts", relation: "call",   metadata: "{}", repo: "repo-b" },
    ];
    const db = makeDb(() => edges);

    // Act
    const result = loadCachedGraphEdges(db, ["repo-a", "repo-b"]);

    // Assert
    expect(result).toHaveLength(2);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE repo IN \(\?, \?\)/);
  });

  it("passes repo names as positional args to .all()", () => {
    // Arrange
    const db = makeDb(() => []);
    const stmt = (db.prepare as ReturnType<typeof vi.fn>)();

    // Act
    loadCachedGraphEdges(db, ["repo-x", "repo-y"]);

    // Assert: the statement's .all() was called with the repo names spread
    expect(stmt.all).toHaveBeenCalledWith("repo-x", "repo-y");
  });

  it("returns an empty array when the query finds no matching rows", () => {
    // Arrange
    const db = makeDb(() => []);

    // Act
    const result = loadCachedGraphEdges(db, ["nonexistent-repo"]);

    // Assert
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadCachedFileIndex
// ---------------------------------------------------------------------------

describe("loadCachedFileIndex", () => {
  it("returns empty array immediately when repos array is empty", () => {
    // Arrange
    const db = makeDb(() => []);

    // Act
    const result = loadCachedFileIndex(db, []);

    // Assert
    expect(result).toEqual([]);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("returns file entries for a single repo", () => {
    // Arrange
    const entry: CachedFileEntry = {
      path: "src/index.ts",
      repo: "api",
      branch: "main",
      file_role: "entry",
      parsed_data: "{}",
      heat_score: 0.8,
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const db = makeDb(() => [entry]);

    // Act
    const result = loadCachedFileIndex(db, ["api"]);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
  });

  it("generates correct placeholder list for multiple repos", () => {
    // Arrange
    const db = makeDb(() => []);

    // Act
    loadCachedFileIndex(db, ["repo-1", "repo-2", "repo-3"]);

    // Assert
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE repo IN \(\?, \?, \?\)/);
  });

  it("passes all repo names as spread args to .all()", () => {
    // Arrange
    const db = makeDb(() => []);
    const stmt = (db.prepare as ReturnType<typeof vi.fn>)();

    // Act
    loadCachedFileIndex(db, ["alpha", "beta"]);

    // Assert
    expect(stmt.all).toHaveBeenCalledWith("alpha", "beta");
  });

  it("handles entries with null updated_at", () => {
    // Arrange
    const entry: CachedFileEntry = {
      path: "lib/util.ts",
      repo: "core",
      branch: "main",
      file_role: "util",
      parsed_data: "{}",
      heat_score: 0.0,
      updated_at: null,
    };
    const db = makeDb(() => [entry]);

    // Act
    const result = loadCachedFileIndex(db, ["core"]);

    // Assert
    expect(result[0]!.updated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkCacheStaleness
// ---------------------------------------------------------------------------

describe("checkCacheStaleness", () => {
  it("returns empty array immediately when repos array is empty", () => {
    // Arrange
    const db = makeGetDb(() => undefined);

    // Act
    const result = checkCacheStaleness(db, []);

    // Assert
    expect(result).toEqual([]);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("reports a repo as stale when updated_at is null", () => {
    // Arrange: db returns null latest for any repo
    const db = makeGetDb(() => ({ latest: null }));

    // Act
    const result = checkCacheStaleness(db, ["repo-a"]);

    // Assert
    expect(result).toContain("repo-a");
  });

  it("reports a repo as stale when updated_at is older than maxAgeDays", () => {
    // Arrange: last updated 60 days ago
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const db = makeGetDb(() => ({ latest: sixtyDaysAgo.toISOString() }));

    // Act — default maxAgeDays is 30
    const result = checkCacheStaleness(db, ["old-repo"]);

    // Assert
    expect(result).toContain("old-repo");
  });

  it("does not report a repo as stale when updated_at is within maxAgeDays", () => {
    // Arrange: last updated 5 days ago
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const db = makeGetDb(() => ({ latest: fiveDaysAgo.toISOString() }));

    // Act
    const result = checkCacheStaleness(db, ["fresh-repo"]);

    // Assert
    expect(result).not.toContain("fresh-repo");
  });

  it("respects a custom maxAgeDays threshold", () => {
    // Arrange: last updated 10 days ago — stale vs 7-day threshold, fresh vs 30-day
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const db = makeGetDb(() => ({ latest: tenDaysAgo.toISOString() }));

    // Act: with a strict 7-day threshold this repo is stale
    const stale = checkCacheStaleness(db, ["repo"], 7);
    // Act: with a generous 30-day threshold it is fresh
    const fresh = checkCacheStaleness(db, ["repo"], 30);

    // Assert
    expect(stale).toContain("repo");
    expect(fresh).not.toContain("repo");
  });

  it("independently evaluates each repo and returns only stale ones", () => {
    // Arrange: prepare is called once per repo — use a call counter to vary the response
    let callCount = 0;
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const freshDate = new Date();
    freshDate.setDate(freshDate.getDate() - 1);

    const stmt = {
      get: vi.fn(() => {
        callCount++;
        // First repo (stale), second repo (fresh)
        return callCount === 1
          ? { latest: tenDaysAgo.toISOString() }
          : { latest: freshDate.toISOString() };
      }),
    };
    const db = { prepare: vi.fn(() => stmt) } as unknown as Database;

    // Act
    const result = checkCacheStaleness(db, ["stale-repo", "fresh-repo"], 7);

    // Assert
    expect(result).toEqual(["stale-repo"]);
    expect(result).not.toContain("fresh-repo");
  });

  it("issues one prepare() call per repo", () => {
    // Arrange
    const db = makeGetDb(() => ({ latest: null }));

    // Act
    checkCacheStaleness(db, ["a", "b", "c"]);

    // Assert: prepare is called 3 times (once per repo)
    expect((db.prepare as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });
});
