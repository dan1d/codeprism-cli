/**
 * E2E integration tests: codeprism init → push flow
 *
 * Coverage:
 *   1. runInit() creates .codeprism/config.json with the correct structure,
 *      writes .gitignore, rules.json, and stores selected repos
 *   1b. runInit() single-repo path (no checkbox prompt fired)
 *   2. loadWorkspaceConfig() priority: .codeprism/config.json > codeprism.config.json > auto-discover
 *   3. runPush() auto-fills engineUrl/apiKey from .codeprism/config.json
 *   4. Parent-config detection in runInit(): child-repo init defers to parent workspace
 *   5. Incremental re-index helpers: loadCachedGraphEdges / loadCachedFileIndex / checkCacheStaleness
 *   6. discoverRepos() correctly identifies git-repo subdirectories
 *
 * Isolation strategy:
 *   - @inquirer/prompts (checkbox, input, password, select, confirm) → vi.mock (hoisted)
 *   - fetch → vi.stubGlobal on the global fetchMock, reset per-test
 *   - better-sqlite3 → real in-memory DB for Test 5 (no disk I/O)
 *   - Temp directories on disk created via mkdtempSync, deleted in afterEach
 *   - process.cwd() → vi.spyOn().mockReturnValue() where push's loadInitConfig needs it
 *   - process.exit → vi.spyOn to prevent suite exit in guard-clause tests
 *
 * Design decisions:
 *   - runInit() calls detectEditors(cwd) which reads real home-dir files at test time.
 *     Rather than suppress this, we pre-load BOTH paths (checkbox for detected editors,
 *     select for no editors) via mockCheckbox/mockSelect so the test is robust regardless
 *     of which editors happen to exist on the CI machine.
 *   - Tests use `mockResolvedValueOnce` in order so prompt calls are consumed in the
 *     exact sequence they appear inside runInit's control flow.
 *   - The "validation failure → confirm proceed" path is exercised because fetch is mocked
 *     to reject, which mirrors the real production guard for bad API keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Module mocks — vi.mock() calls are hoisted above all imports by vitest.
// These MUST appear before any import that transitively pulls in the mocked
// module, even though TypeScript linting may complain about ordering.
// ---------------------------------------------------------------------------

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Source modules under test (imported AFTER vi.mock declarations are in place)
// ---------------------------------------------------------------------------

import { runInit } from "../../cli/init.js";
import { runPush } from "../../cli/push.js";
import { loadWorkspaceConfig, discoverRepos } from "../../config/workspace-config.js";
import {
  loadCachedGraphEdges,
  loadCachedFileIndex,
  checkCacheStaleness,
} from "../../db/cached-data.js";

// Typed aliases for mocked prompt functions
import { checkbox, input, password, select, confirm } from "@inquirer/prompts";

const mockCheckbox = checkbox as MockedFunction<typeof checkbox>;
const mockInput    = input    as MockedFunction<typeof input>;
const mockPassword = password as MockedFunction<typeof password>;
const mockSelect   = select   as MockedFunction<typeof select>;
const mockConfirm  = confirm  as MockedFunction<typeof confirm>;

// ---------------------------------------------------------------------------
// Global fetch stub — replaced with test-specific behaviour in each suite
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

// ---------------------------------------------------------------------------
// Shared test utilities
// ---------------------------------------------------------------------------

/** Create a unique temp directory under the OS temp root. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "codeprism-e2e-"));
}

/**
 * Create a minimal git repository by placing a `.git/` directory.
 * Returns the absolute path to the new repo directory.
 */
function makeGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(join(repoPath, ".git"), { recursive: true });
  return repoPath;
}

/** Read and JSON-parse a file from disk. */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

/** Write value as pretty-printed JSON, creating parent directories as needed. */
function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/**
 * Set up the complete sequence of mocked prompt answers for a successful
 * runInit() call.  runInit's prompt sequence is:
 *
 *   IF parentConfig detected  → select: "what to do?"
 *   IF existing .codeprism/   → confirm: "re-initialize?"
 *   discovered > 1 repos      → checkbox: repo selection
 *   always                    → input: engineUrl
 *   always                    → password: apiKey
 *   if validation fails       → confirm: "proceed anyway?"
 *   if fetchDevEmail returns ""→ input: dev email
 *   if editors detected       → checkbox: install MCP for which editors?
 *   if NO editors detected    → select: install MCP for which editor? (skip)
 *   always                    → select: LLM provider
 *
 * Because detectEditors() reads real home-dir paths at runtime we arm BOTH
 * the checkbox path AND the select path.  Only one will be consumed.
 */
function setupInitPrompts(overrides: {
  repos?: Array<{ name: string; path: string }>;
  engineUrl?: string;
  apiKey?: string;
  devEmail?: string;
} = {}): void {
  const {
    repos      = [],
    engineUrl  = "https://test.codeprism.dev",
    apiKey     = "sk_test_key_abc",
    devEmail   = "dev@test.com",
  } = overrides;

  // Repo selection (only fired when > 1 repo discovered)
  if (repos.length > 0) {
    mockCheckbox.mockResolvedValueOnce(repos as never);
  }

  // Engine URL
  mockInput.mockResolvedValueOnce(engineUrl);

  // API key
  mockPassword.mockResolvedValueOnce(apiKey);

  // fetch is mocked to reject → validation fails → confirm "proceed anyway?"
  mockConfirm.mockResolvedValueOnce(true as never);

  // fetchDevEmail fails → prompt for email
  mockInput.mockResolvedValueOnce(devEmail);

  // Editors detected path → checkbox (select none to install)
  mockCheckbox.mockResolvedValueOnce([] as never);

  // No editors detected path → select "skip"
  mockSelect.mockResolvedValueOnce("skip" as never);

  // LLM provider → skip
  mockSelect.mockResolvedValueOnce("skip" as never);
}

// ---------------------------------------------------------------------------
// Test 1: runInit() creates the correct workspace files (multi-repo)
// ---------------------------------------------------------------------------

describe("Test 1: runInit() creates correct workspace config (multi-repo)", () => {
  let tmpDir: string;
  let repoA: string;
  let repoB: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    repoA  = makeGitRepo(tmpDir, "service-alpha");
    repoB  = makeGitRepo(tmpDir, "service-beta");

    // fetch always fails so validateApiKey and fetchTeamRules return error/empty
    fetchMock.mockRejectedValue(new Error("network error"));

    // Arrange prompts: checkbox returns both repos
    setupInitPrompts({
      repos: [
        { name: "service-alpha", path: repoA },
        { name: "service-beta",  path: repoB  },
      ],
      engineUrl: "https://acme.codeprism.dev",
      apiKey:    "sk_test_abc123",
      devEmail:  "dev@acme.com",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it("creates .codeprism/config.json with engineUrl, apiKey, and repos", async () => {
    // Act
    await runInit(tmpDir);

    // Assert — file must exist
    const configPath = join(tmpDir, ".codeprism", "config.json");
    expect(existsSync(configPath), "config.json must exist").toBe(true);

    // Assert — content is correct
    const cfg = readJson(configPath);
    expect(cfg.engineUrl).toBe("https://acme.codeprism.dev");
    expect(cfg.apiKey).toBe("sk_test_abc123");
    expect(Array.isArray(cfg.repos)).toBe(true);

    const repos = cfg.repos as Array<{ name: string; path: string }>;
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name).sort()).toEqual(["service-alpha", "service-beta"]);
  });

  it("stores relative paths for repos inside config.repos", async () => {
    await runInit(tmpDir);

    const cfg  = readJson(join(tmpDir, ".codeprism", "config.json"));
    const repos = cfg.repos as Array<{ path: string }>;
    // runInit converts absolute repo paths to relative using path.relative(cwd, abs)
    expect(repos.map((r) => r.path).sort()).toEqual(["service-alpha", "service-beta"]);
  });

  it("creates .codeprism/.gitignore containing 'config.json'", async () => {
    await runInit(tmpDir);

    const gitignorePath = join(tmpDir, ".codeprism", ".gitignore");
    expect(existsSync(gitignorePath), ".gitignore must exist").toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toContain("config.json");
  });

  it("creates .codeprism/rules.json (empty array when fetch fails)", async () => {
    await runInit(tmpDir);

    const rulesPath = join(tmpDir, ".codeprism", "rules.json");
    expect(existsSync(rulesPath), "rules.json must exist").toBe(true);
    const rules = JSON.parse(readFileSync(rulesPath, "utf-8"));
    expect(Array.isArray(rules)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 1b: runInit() single-repo workspace — no checkbox prompt for repo selection
// ---------------------------------------------------------------------------

describe("Test 1b: runInit() with a single discovered repo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    makeGitRepo(tmpDir, "only-repo");

    fetchMock.mockRejectedValue(new Error("network error"));

    // Single-repo discovered → NO checkbox for repo selection
    setupInitPrompts({ engineUrl: "https://solo.codeprism.dev", apiKey: "sk_solo" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it("creates config.json naming the single repo without invoking the repo checkbox", async () => {
    await runInit(tmpDir);

    const cfg   = readJson(join(tmpDir, ".codeprism", "config.json"));
    const repos = cfg.repos as Array<{ name: string }>;
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe("only-repo");

    // The checkbox mock should NOT have been called with the repo-selection message
    const repoCheckboxCall = mockCheckbox.mock.calls.find(
      ([arg]) => (arg as { message?: string }).message?.includes("Select repositories"),
    );
    expect(repoCheckboxCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: loadWorkspaceConfig() config resolution priority
// ---------------------------------------------------------------------------

describe("Test 2: loadWorkspaceConfig() respects config priority", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads repos, engineUrl, and apiKey from .codeprism/config.json when present", () => {
    // Arrange
    writeJson(join(tmpDir, ".codeprism", "config.json"), {
      engineUrl: "https://engine.example.com",
      apiKey:    "sk_test_key",
      repos:     [{ path: ".", name: "my-service" }],
      exclude:   [],
    });

    // Act
    const loaded = loadWorkspaceConfig(tmpDir);

    // Assert
    expect(loaded.source).toBe("file");
    expect(loaded.engineUrl).toBe("https://engine.example.com");
    expect(loaded.apiKey).toBe("sk_test_key");
    expect(loaded.repos).toHaveLength(1);
    expect(loaded.repos[0]!.name).toBe("my-service");
  });

  it(".codeprism/config.json takes precedence over codeprism.config.json", () => {
    // Arrange: both files present with different repo names
    writeJson(join(tmpDir, "codeprism.config.json"), {
      repos: [{ path: ".", name: "legacy-repo" }],
    });
    writeJson(join(tmpDir, ".codeprism", "config.json"), {
      engineUrl: "https://init-wins.example.com",
      apiKey:    "sk_init_key",
      repos:     [{ path: ".", name: "init-repo" }],
      exclude:   [],
    });

    // Act
    const loaded = loadWorkspaceConfig(tmpDir);

    // Assert: .codeprism/config.json wins
    expect(loaded.engineUrl).toBe("https://init-wins.example.com");
    expect(loaded.repos[0]!.name).toBe("init-repo");
  });

  it("falls back to codeprism.config.json when .codeprism/config.json is absent", () => {
    // Arrange
    writeJson(join(tmpDir, "codeprism.config.json"), {
      repos: [{ path: ".", name: "legacy-service" }],
    });

    // Act
    const loaded = loadWorkspaceConfig(tmpDir);

    // Assert
    expect(loaded.source).toBe("file");
    expect(loaded.repos[0]!.name).toBe("legacy-service");
    expect(loaded.engineUrl).toBeUndefined();
  });

  it("falls back to auto-discovery when no config files exist", () => {
    // Arrange: place a git repo inside so auto-discover finds it
    makeGitRepo(tmpDir, "discovered-repo");

    // Act
    const loaded = loadWorkspaceConfig(tmpDir);

    // Assert
    expect(loaded.source).toBe("auto");
    expect(loaded.repos.some((r) => r.name === "discovered-repo")).toBe(true);
  });

  it("parses optional llm config from .codeprism/config.json", () => {
    // Arrange
    writeJson(join(tmpDir, ".codeprism", "config.json"), {
      engineUrl: "https://engine.example.com",
      apiKey:    "sk_key",
      repos:     [{ path: ".", name: "repo" }],
      exclude:   [],
      llm:       { provider: "deepseek", apiKey: "ds_key_abc" },
    });

    // Act
    const loaded = loadWorkspaceConfig(tmpDir);

    // Assert
    expect(loaded.llm).toBeDefined();
    expect(loaded.llm!.provider).toBe("deepseek");
    expect(loaded.llm!.apiKey).toBe("ds_key_abc");
  });

  it("returns an empty exclude array when the field is absent", () => {
    writeJson(join(tmpDir, ".codeprism", "config.json"), {
      engineUrl: "https://engine.example.com",
      apiKey:    "sk_key",
      repos:     [{ path: ".", name: "repo" }],
    });

    const loaded = loadWorkspaceConfig(tmpDir);
    expect(loaded.exclude).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 3: runPush() auto-fills credentials from .codeprism/config.json
// ---------------------------------------------------------------------------

describe("Test 3: runPush() auto-fills engineUrl and apiKey from .codeprism/config.json", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();

    // Create a minimal SQLite file so runPush can read it as bytes
    dbPath = join(tmpDir, "codeprism.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS _test (id INTEGER PRIMARY KEY)");
    db.close();

    // Write .codeprism/config.json with engine credentials
    writeJson(join(tmpDir, ".codeprism", "config.json"), {
      engineUrl: "https://push-test.codeprism.dev",
      apiKey:    "sk_push_key_xyz",
      repos:     [{ path: ".", name: "push-repo" }],
      exclude:   [],
    });

    // Successful push response
    fetchMock.mockResolvedValue({
      ok:   true,
      json: async () => ({ ok: true, cards: 42, files: 10, docs: 3, repos: 1 }),
      text: async () => "ok",
    } as Response);

    // Point process.cwd() at tmpDir so loadInitConfig walks from there
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    // Suppress console output
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
    fetchMock.mockReset();
  });

  it("calls the engine push endpoint derived from config engineUrl", async () => {
    // Act
    await runPush({ engineUrl: "", apiKey: "", db: dbPath });

    // Assert
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://push-test.codeprism.dev/api/db/push",
    );
  });

  it("sends Bearer authorization header using apiKey from config", async () => {
    await runPush({ engineUrl: "", apiKey: "", db: dbPath });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk_push_key_xyz");
  });

  it("sends Content-Type: application/octet-stream with DB file bytes", async () => {
    await runPush({ engineUrl: "", apiKey: "", db: dbPath });

    const init   = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    // Body must be a Buffer with content (the SQLite file is non-empty)
    expect((init.body as Buffer).length).toBeGreaterThan(0);
  });

  it("explicit flags override config values", async () => {
    await runPush({
      engineUrl: "https://override.codeprism.dev",
      apiKey:    "sk_override_key",
      db:        dbPath,
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://override.codeprism.dev/api/db/push",
    );
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk_override_key");
  });

  it("strips a trailing slash from engineUrl before building the push URL", async () => {
    writeJson(join(tmpDir, ".codeprism", "config.json"), {
      engineUrl: "https://trailing.codeprism.dev/",
      apiKey:    "sk_key",
      repos:     [],
      exclude:   [],
    });

    await runPush({ engineUrl: "", apiKey: "", db: dbPath });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://trailing.codeprism.dev/api/db/push",
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4: findParentConfig() — child-repo init detects and defers to parent
// ---------------------------------------------------------------------------

describe("Test 4: runInit() parent-config detection", () => {
  let workspaceDir: string;
  let childRepoDir: string;

  beforeEach(() => {
    workspaceDir = makeTempDir();
    childRepoDir = makeGitRepo(workspaceDir, "child-service");

    // Pre-existing parent workspace config
    writeJson(join(workspaceDir, ".codeprism", "config.json"), {
      engineUrl: "https://parent.codeprism.dev",
      apiKey:    "sk_parent_key",
      repos:     [{ path: "child-service", name: "child-service" }],
      exclude:   [],
    });

    // Suppress console output from runInit
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(new Error("network error"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspaceDir, { recursive: true, force: true });
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it("presents a 'use-parent' choice when a parent config is found", async () => {
    // Arrange: user picks "use-parent"
    mockSelect.mockResolvedValueOnce("use-parent" as never);

    // Act
    await runInit(childRepoDir);

    // Assert: select was called once with all three choices
    expect(mockSelect).toHaveBeenCalledOnce();
    const choices = (mockSelect.mock.calls[0]![0] as unknown as {
      choices: Array<{ value: string }>;
    }).choices;
    const values = choices.map((c) => c.value);
    expect(values).toContain("use-parent");
    expect(values).toContain("new-here");
    expect(values).toContain("abort");
  });

  it("does NOT create a child config when user selects 'use-parent'", async () => {
    mockSelect.mockResolvedValueOnce("use-parent" as never);
    await runInit(childRepoDir);

    expect(
      existsSync(join(childRepoDir, ".codeprism", "config.json")),
    ).toBe(false);
  });

  it("creates a new local config when user selects 'new-here'", async () => {
    // Arrange: first select → "new-here"; then all the standard init prompts
    mockSelect.mockResolvedValueOnce("new-here" as never);
    setupInitPrompts({
      engineUrl: "https://child.codeprism.dev",
      apiKey:    "sk_child_key",
      devEmail:  "child-dev@example.com",
    });

    // Act
    await runInit(childRepoDir);

    // Assert: a new config was written inside childRepoDir
    const childConfigPath = join(childRepoDir, ".codeprism", "config.json");
    expect(existsSync(childConfigPath)).toBe(true);
    const cfg = readJson(childConfigPath);
    expect(cfg.engineUrl).toBe("https://child.codeprism.dev");
  });

  it("aborts cleanly when user selects 'abort'", async () => {
    mockSelect.mockResolvedValueOnce("abort" as never);
    await runInit(childRepoDir);

    // No config should have been created; no further prompts called
    expect(existsSync(join(childRepoDir, ".codeprism", "config.json"))).toBe(false);
    expect(mockInput).not.toHaveBeenCalled();
    expect(mockPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 5: Incremental re-index — cached DB helpers with real in-memory SQLite
// ---------------------------------------------------------------------------

describe("Test 5: Incremental re-index helpers (real in-memory SQLite)", () => {
  let db: DatabaseType;

  // Minimal schema required by the cached-data helpers
  function createMinimalSchema(database: DatabaseType): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS graph_edges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        relation    TEXT NOT NULL,
        metadata    TEXT DEFAULT '{}',
        repo        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_index (
        path        TEXT NOT NULL,
        repo        TEXT NOT NULL,
        branch      TEXT NOT NULL DEFAULT 'main',
        commit_sha  TEXT NOT NULL DEFAULT '',
        parsed_data TEXT NOT NULL DEFAULT '{}',
        file_role   TEXT NOT NULL DEFAULT 'domain',
        heat_score  REAL          DEFAULT 0,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (path, repo, branch)
      );
    `);
  }

  function insertEdge(
    database: DatabaseType,
    sourceFile: string,
    targetFile: string,
    relation: string,
    repo: string,
  ): void {
    database
      .prepare(
        "INSERT INTO graph_edges (source_file, target_file, relation, metadata, repo) VALUES (?, ?, ?, '{}', ?)",
      )
      .run(sourceFile, targetFile, relation, repo);
  }

  function insertFile(
    database: DatabaseType,
    path: string,
    repo: string,
    updatedAt: string,
  ): void {
    database
      .prepare(
        `INSERT INTO file_index (path, repo, branch, commit_sha, parsed_data, file_role, heat_score, updated_at)
         VALUES (?, ?, 'main', '', '{}', 'domain', 0, ?)`,
      )
      .run(path, repo, updatedAt);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    createMinimalSchema(db);

    // Seed two repos
    insertEdge(db, "alpha/service.ts", "shared/util.ts", "imports", "repo-alpha");
    insertEdge(db, "alpha/model.ts",   "alpha/service.ts", "uses",  "repo-alpha");
    insertEdge(db, "beta/controller.ts", "shared/util.ts", "imports", "repo-beta");

    const recentIso = new Date().toISOString();
    // 40 days ago — exceeds the default 30-day threshold
    const oldIso    = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    insertFile(db, "alpha/service.ts",    "repo-alpha", recentIso);
    insertFile(db, "alpha/model.ts",      "repo-alpha", recentIso);
    insertFile(db, "beta/controller.ts",  "repo-beta",  oldIso);
  });

  afterEach(() => {
    db.close();
  });

  // ── loadCachedGraphEdges ───────────────────────────────────────────────────

  it("loadCachedGraphEdges returns empty array for an empty repos list", () => {
    expect(loadCachedGraphEdges(db, [])).toEqual([]);
  });

  it("loadCachedGraphEdges returns only edges for the requested repo", () => {
    // Arrange & Act
    const edges = loadCachedGraphEdges(db, ["repo-alpha"]);

    // Assert
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.repo === "repo-alpha")).toBe(true);
  });

  it("loadCachedGraphEdges returns edges for multiple repos when all are requested", () => {
    const edges = loadCachedGraphEdges(db, ["repo-alpha", "repo-beta"]);

    expect(edges).toHaveLength(3);
    const repos = new Set(edges.map((e) => e.repo));
    expect(repos.has("repo-alpha")).toBe(true);
    expect(repos.has("repo-beta")).toBe(true);
  });

  it("loadCachedGraphEdges returns empty when repo has no matching edges", () => {
    expect(loadCachedGraphEdges(db, ["repo-nonexistent"])).toHaveLength(0);
  });

  it("loadCachedGraphEdges returns the correct edge shape", () => {
    const [edge] = loadCachedGraphEdges(db, ["repo-alpha"]);

    // Arrange-Act-Assert: shape contract
    expect(edge).toMatchObject({
      source_file: expect.any(String),
      target_file: expect.any(String),
      relation:    expect.any(String),
      metadata:    expect.any(String),
      repo:        "repo-alpha",
    });
  });

  // ── loadCachedFileIndex ────────────────────────────────────────────────────

  it("loadCachedFileIndex returns empty array for an empty repos list", () => {
    expect(loadCachedFileIndex(db, [])).toEqual([]);
  });

  it("loadCachedFileIndex returns only files for the requested repo", () => {
    const files = loadCachedFileIndex(db, ["repo-alpha"]);

    expect(files).toHaveLength(2);
    expect(files.every((f) => f.repo === "repo-alpha")).toBe(true);
    expect(files.map((f) => f.path).sort()).toEqual([
      "alpha/model.ts",
      "alpha/service.ts",
    ]);
  });

  it("loadCachedFileIndex returns correct file shape", () => {
    const [file] = loadCachedFileIndex(db, ["repo-alpha"]);

    expect(file).toMatchObject({
      path:        expect.any(String),
      repo:        "repo-alpha",
      branch:      "main",
      file_role:   "domain",
      parsed_data: expect.any(String),
      heat_score:  expect.any(Number),
    });
  });

  // ── checkCacheStaleness ────────────────────────────────────────────────────

  it("checkCacheStaleness returns empty array for an empty repos list", () => {
    expect(checkCacheStaleness(db, [])).toEqual([]);
  });

  it("checkCacheStaleness identifies repos with old updated_at as stale (default 30 days)", () => {
    // repo-beta was inserted with a 40-day-old timestamp
    const stale = checkCacheStaleness(db, ["repo-alpha", "repo-beta"]);

    expect(stale).toContain("repo-beta");
    expect(stale).not.toContain("repo-alpha");
  });

  it("checkCacheStaleness marks a repo stale when it has no file_index entries at all", () => {
    const stale = checkCacheStaleness(db, ["repo-nonexistent"]);

    expect(stale).toContain("repo-nonexistent");
  });

  it("checkCacheStaleness returns empty when all repos are within the freshness window", () => {
    const stale = checkCacheStaleness(db, ["repo-alpha"]);

    expect(stale).toHaveLength(0);
  });

  it("checkCacheStaleness respects a custom maxAgeDays threshold", () => {
    // repo-beta is 40 days old: stale at 30 days (default) but fresh at 365
    const staleDefault = checkCacheStaleness(db, ["repo-beta"], 30);
    expect(staleDefault).toContain("repo-beta");

    // With maxAgeDays=365 even repo-beta (40 days old) is fresh
    const staleLenient = checkCacheStaleness(db, ["repo-beta"], 365);
    expect(staleLenient).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: discoverRepos() — identifies git-repo subdirectories
// ---------------------------------------------------------------------------

describe("Test 6: discoverRepos() discovers git repositories", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns discovered git repos inside the workspace", () => {
    // Arrange
    makeGitRepo(tmpDir, "frontend");
    makeGitRepo(tmpDir, "backend");
    // Plain directory without .git — must NOT be included
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });

    // Act
    const repos = discoverRepos(tmpDir);

    // Assert
    const names = repos.map((r) => r.name).sort();
    expect(names).toEqual(["backend", "frontend"]);
  });

  it("returns empty array when no repos exist in the workspace", () => {
    // tmpDir has no children with repo markers
    const repos = discoverRepos(tmpDir);

    expect(Array.isArray(repos)).toBe(true);
    // Auto-discovery in a plain empty dir finds no repo markers → empty
    expect(repos).toHaveLength(0);
  });

  it("excludes hidden directories (names starting with '.')", () => {
    // Arrange
    makeGitRepo(tmpDir, ".hidden-service");
    makeGitRepo(tmpDir, "visible-service");

    // Act
    const repos = discoverRepos(tmpDir);
    const names = repos.map((r) => r.name);

    // Assert
    expect(names).not.toContain(".hidden-service");
    expect(names).toContain("visible-service");
  });

  it("returns absolute paths for each discovered repo", () => {
    makeGitRepo(tmpDir, "my-api");

    const repos = discoverRepos(tmpDir);
    const apiRepo = repos.find((r) => r.name === "my-api");

    expect(apiRepo).toBeDefined();
    expect(apiRepo!.path.startsWith("/")).toBe(true);
  });
});
