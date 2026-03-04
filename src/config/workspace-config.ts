import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoEntry {
  /** Absolute or relative path to the repo root */
  path: string;
  /** Display name — defaults to the directory basename */
  name?: string;
}

/** Schema for `codeprism.config.json` placed at the workspace root. */
export interface WorkspaceConfig {
  /** Explicit list of repos to index */
  repos?: RepoEntry[];
  /** Glob patterns to exclude from indexing */
  exclude?: string[];
  /** Override the workspace root directory */
  workspaceRoot?: string;
}

/** Resolved repo entry with guaranteed absolute path and name. */
export interface ResolvedRepo {
  name: string;
  path: string;
}

/** Result of loading the workspace config. */
export interface LoadedWorkspaceConfig {
  workspaceRoot: string;
  repos: ResolvedRepo[];
  exclude: string[];
  /** Whether the config was loaded from a file or auto-discovered. */
  source: "file" | "auto";
  /** Engine URL from .codeprism/config.json (if present). */
  engineUrl?: string;
  /** Team API key from .codeprism/config.json (if present). */
  apiKey?: string;
  /** LLM config from .codeprism/config.json (if present). */
  llm?: { provider: string; apiKey: string };
}

const CONFIG_FILENAME = "codeprism.config.json";
const INIT_CONFIG_DIR = ".codeprism";
const INIT_CONFIG_FILENAME = "config.json";

// Markers that indicate a directory is a repository root.
const REPO_MARKERS = [
  "package.json",
  "Gemfile",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  ".git",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load workspace configuration.
 *
 * Resolution order:
 * 1. `.codeprism/config.json` — created by `codeprism init`
 * 2. `codeprism.config.json`  — legacy explicit config
 * 3. Auto-discovery            — scan sibling directories for repos
 */
export function loadWorkspaceConfig(workspaceRoot: string): LoadedWorkspaceConfig {
  // Priority 1: .codeprism/config.json (init wizard output)
  const initConfigPath = join(workspaceRoot, INIT_CONFIG_DIR, INIT_CONFIG_FILENAME);
  if (existsSync(initConfigPath)) return loadFromInitConfig(initConfigPath, workspaceRoot);

  // Priority 2: codeprism.config.json (legacy)
  const configPath = join(workspaceRoot, CONFIG_FILENAME);
  if (existsSync(configPath)) return loadFromFile(configPath, workspaceRoot);

  return autoDiscover(workspaceRoot);
}

/**
 * Public API: discover repos in a directory (for use by `codeprism init`).
 * Returns resolved repos found by scanning the directory.
 */
export function discoverRepos(dir: string): ResolvedRepo[] {
  const result = autoDiscover(dir);
  return result.repos;
}

// ---------------------------------------------------------------------------
// File-based config
// ---------------------------------------------------------------------------

function loadFromFile(configPath: string, fallbackRoot: string): LoadedWorkspaceConfig {
  const raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath}: expected a JSON object at the top level`);
  }

  const cfg = parsed as Record<string, unknown>;
  const configDir = dirname(configPath);

  const workspaceRoot = resolveWorkspaceRoot(cfg, configDir, fallbackRoot);
  const repos = resolveRepos(cfg, configDir);
  const exclude = resolveExclude(cfg);

  return { workspaceRoot, repos, exclude, source: "file" };
}

// ---------------------------------------------------------------------------
// .codeprism/config.json (init wizard format)
// ---------------------------------------------------------------------------

function loadFromInitConfig(configPath: string, fallbackRoot: string): LoadedWorkspaceConfig {
  const raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath}: expected a JSON object at the top level`);
  }

  const cfg = parsed as Record<string, unknown>;
  // .codeprism/ is inside the workspace root, so configDir's parent IS the root
  const configDir = dirname(dirname(configPath));

  const repos = resolveRepos(cfg, configDir);
  const exclude = resolveExclude(cfg);

  const engineUrl = typeof cfg.engineUrl === "string" ? cfg.engineUrl : undefined;
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey : undefined;

  let llm: { provider: string; apiKey: string } | undefined;
  if (cfg.llm && typeof cfg.llm === "object" && !Array.isArray(cfg.llm)) {
    const llmObj = cfg.llm as Record<string, unknown>;
    if (typeof llmObj.provider === "string" && typeof llmObj.apiKey === "string") {
      llm = { provider: llmObj.provider, apiKey: llmObj.apiKey };
    }
  }

  return {
    workspaceRoot: configDir || fallbackRoot,
    repos,
    exclude,
    source: "file",
    engineUrl,
    apiKey,
    llm,
  };
}

function resolveWorkspaceRoot(
  cfg: Record<string, unknown>,
  configDir: string,
  fallback: string,
): string {
  if (!("workspaceRoot" in cfg)) return fallback;
  if (typeof cfg.workspaceRoot !== "string")
    throw new Error(`codeprism.config.json: "workspaceRoot" must be a string`);
  return resolve(configDir, cfg.workspaceRoot);
}

function resolveRepos(
  cfg: Record<string, unknown>,
  configDir: string,
): ResolvedRepo[] {
  if (!("repos" in cfg)) return [];
  if (!Array.isArray(cfg.repos)) {
    throw new Error(`codeprism.config.json: "repos" must be an array`);
  }

  return cfg.repos.map((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`codeprism.config.json: repos[${i}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.length === 0) {
      throw new Error(`codeprism.config.json: repos[${i}].path must be a non-empty string`);
    }
    if (obj.name !== undefined && typeof obj.name !== "string") {
      throw new Error(`codeprism.config.json: repos[${i}].name must be a string`);
    }

    const absPath = resolve(configDir, obj.path);
    const name = typeof obj.name === "string" ? obj.name : absPath.split("/").at(-1)!;
    return { name, path: absPath };
  });
}

function resolveExclude(cfg: Record<string, unknown>): string[] {
  if (!("exclude" in cfg)) return [];
  if (!Array.isArray(cfg.exclude)) {
    throw new Error(`codeprism.config.json: "exclude" must be an array`);
  }
  for (let i = 0; i < cfg.exclude.length; i++) {
    if (typeof cfg.exclude[i] !== "string") {
      throw new Error(`codeprism.config.json: exclude[${i}] must be a string`);
    }
  }
  return cfg.exclude as string[];
}

// ---------------------------------------------------------------------------
// Auto-discovery fallback
// ---------------------------------------------------------------------------

/**
 * Auto-discover repos.
 *
 * - If the workspace root itself looks like a repo (has package.json, .git, etc.)
 *   treat it as a single-repo workspace. This is the common case when a developer
 *   runs `codeprism index` from inside their project.
 *
 * - Otherwise scan child directories for repos (multi-repo workspace layout).
 */
function autoDiscover(workspaceRoot: string): LoadedWorkspaceConfig {
  // Single-repo case: cwd IS the repo
  if (REPO_MARKERS.some((marker) => existsSync(join(workspaceRoot, marker)))) {
    const name = workspaceRoot.split("/").at(-1) ?? "repo";
    return {
      workspaceRoot,
      repos: [{ name, path: workspaceRoot }],
      exclude: [],
      source: "auto",
    };
  }

  // Multi-repo case: scan child directories
  const entries = readdirSync(workspaceRoot, { withFileTypes: true });
  const repos: ResolvedRepo[] = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "codeprism")
    .map((e) => ({ name: e.name, path: join(workspaceRoot, e.name) }))
    .filter((r) => REPO_MARKERS.some((marker) => existsSync(join(r.path, marker))));

  return { workspaceRoot, repos, exclude: [], source: "auto" };
}
