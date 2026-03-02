import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadWorkspaceConfig, type LoadedWorkspaceConfig } from "../config/workspace-config.js";

/**
 * Find the workspace root for the CLI.
 *
 * Resolution order:
 * 1. Walk up from process.cwd() looking for `codeprism.config.json`
 * 2. Fall back to process.cwd() (autoDiscover will handle single-repo or multi-repo layouts)
 *
 * The `importMetaUrl` parameter is kept for API compatibility but is no longer used.
 */
export function userWorkspaceRootFrom(_importMetaUrl: string): string {
  const cwd = process.cwd();

  // Walk up looking for an explicit config file
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "codeprism.config.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  // No config found — treat cwd as workspace root.
  // autoDiscover will detect whether cwd is itself a repo or a parent of repos.
  return cwd;
}

/**
 * Load the full workspace configuration from process.cwd().
 */
export function loadWorkspace(_importMetaUrl: string): LoadedWorkspaceConfig {
  const workspaceRoot = userWorkspaceRootFrom(_importMetaUrl);
  return loadWorkspaceConfig(workspaceRoot);
}
