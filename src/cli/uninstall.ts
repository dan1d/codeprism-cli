/**
 * codeprism uninstall — remove all codeprism artifacts from the workspace.
 *
 * Cleans up:
 *   - .codeprism/ directory (config, rules, .gitignore)
 *   - codeprism.db (local SQLite index)
 *   - codeprism.config.json (legacy config)
 *   - ai-codeprism/ directories (generated docs)
 *   - .cursor/rules/codeprism.mdc, .zed/rules/codeprism.md
 *   - codeprism sections in CLAUDE.md, .windsurfrules
 *   - mcpServers.codeprism key in .cursor/mcp.json
 *   - git hooks with codeprism blocks
 *   - global editor configs (claude, windsurf, zed)
 */

/* eslint-disable no-console */

import { existsSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { userWorkspaceRootFrom } from "../utils/workspace.js";
import { discoverRepos, loadWorkspaceConfig } from "../config/workspace-config.js";
import { findGitRoot } from "./install-hook.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemovalItem {
  path: string;
  label: string;
  kind: "delete" | "remove-section" | "remove-json-key";
  /** For remove-section: regex or marker to find the block */
  sectionMarker?: string;
  /** For remove-json-key: dot-separated path to delete */
  jsonKey?: string;
}

export interface UninstallOptions {
  force: boolean;
  noGlobal: boolean;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Section removal helpers
// ---------------------------------------------------------------------------

/**
 * Remove a markdown section starting with a heading that contains `marker`.
 * Supports `## marker` and `# marker` headings.
 * Returns the file content with the section removed, or null if nothing changed.
 */
function removeMdSection(content: string, marker: string): string | null {
  // Match section from heading line to the next heading of same or higher level (or EOF)
  const pattern = new RegExp(
    `(^|\\n)(#{1,3}\\s+[^\\n]*${escapeRegex(marker)}[^\\n]*)\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`,
    "i",
  );
  const match = content.match(pattern);
  if (!match) return null;

  const removed = content.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim();
  return removed;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove codeprism blocks from a git hook script.
 * Returns null if no codeprism content found.
 * Returns empty string if the entire file is codeprism content.
 */
function removeHookBlock(content: string): string | null {
  if (!content.includes("codeprism")) return null;

  // If the shebang + codeprism comment is the very first thing, the whole file is ours
  const lines = content.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const allCodeprism = nonEmpty.every(
    (l) => l.includes("codeprism") || l.startsWith("#!/") || l.startsWith("_codeprism") ||
           l.startsWith("CODEPRISM") || l.startsWith("  ") || l.startsWith("\t") ||
           l.startsWith("PY") || l.startsWith("import ") || l.startsWith("print(") ||
           l.startsWith("for ") || l.startsWith("if ") || l.startsWith("repo ") ||
           l.startsWith("branch ") || l.startsWith("event ") || l.startsWith("changed") ||
           l.startsWith("printf") || l.startsWith("[") || l.startsWith("CHANGES") ||
           l.startsWith("PY'") || l.startsWith("}'") || l.startsWith("}") ||
           l.match(/^\s*[-|]/) || l.startsWith("\"") || l.startsWith("\\"),
  );

  // Simpler heuristic: if the file references codeprism in a comment near the top, it's ours
  const headerLines = lines.slice(0, 3).join("\n");
  if (headerLines.includes("codeprism") && allCodeprism) {
    return "";
  }

  // Otherwise try to remove just the codeprism block (from comment marker to end of block)
  // Look for `# codeprism` comment lines and the function block
  const startIdx = lines.findIndex((l) => l.includes("codeprism") && (l.startsWith("#") || l.startsWith("_codeprism")));
  if (startIdx === -1) return null;

  // Find the end: next non-codeprism section or EOF
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    // If we hit a new section (non-codeprism shebang-less comment block), stop
    if (lines[i]!.startsWith("# ") && !lines[i]!.includes("codeprism") && i > startIdx + 2) {
      endIdx = i;
      break;
    }
  }

  const result = [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || "";
}

/**
 * Remove a key from a JSON file. Returns the modified object or null if key not found.
 */
function removeJsonKey(content: string, keyPath: string): string | null {
  try {
    const obj = JSON.parse(content);
    const parts = keyPath.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current || typeof current !== "object") return null;
      current = current[parts[i]!];
    }
    const lastKey = parts[parts.length - 1]!;
    if (!current || !(lastKey in current)) return null;
    delete current[lastKey];
    return JSON.stringify(obj, null, 2) + "\n";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function collectItems(workspaceRoot: string, opts: UninstallOptions): RemovalItem[] {
  const items: RemovalItem[] = [];

  // --- Workspace root artifacts ---
  const dotDir = join(workspaceRoot, ".codeprism");
  if (existsSync(dotDir)) {
    items.push({ path: dotDir, label: ".codeprism/ directory", kind: "delete" });
  }

  const dbPath = join(workspaceRoot, "codeprism.db");
  if (existsSync(dbPath)) {
    items.push({ path: dbPath, label: "codeprism.db", kind: "delete" });
  }

  const legacyConfig = join(workspaceRoot, "codeprism.config.json");
  if (existsSync(legacyConfig)) {
    items.push({ path: legacyConfig, label: "codeprism.config.json (legacy)", kind: "delete" });
  }

  // --- Discover repos ---
  let repoPaths: string[] = [];
  try {
    const config = loadWorkspaceConfig(workspaceRoot);
    repoPaths = config.repos.map((r) => r.path);
  } catch {
    // Config might already be gone — fall back to auto-discovery
    const discovered = discoverRepos(workspaceRoot);
    repoPaths = discovered.map((r) => r.path);
  }

  // Ensure workspace root itself is covered (single-repo case)
  if (repoPaths.length === 0) {
    repoPaths = [workspaceRoot];
  }

  for (const repoPath of repoPaths) {
    // ai-codeprism/ docs directory
    const aiDir = join(repoPath, "ai-codeprism");
    if (existsSync(aiDir)) {
      items.push({ path: aiDir, label: `ai-codeprism/ in ${repoPath}`, kind: "delete" });
    }

    // .cursor/rules/codeprism.mdc
    const cursorRule = join(repoPath, ".cursor", "rules", "codeprism.mdc");
    if (existsSync(cursorRule)) {
      items.push({ path: cursorRule, label: ".cursor/rules/codeprism.mdc", kind: "delete" });
    }

    // .zed/rules/codeprism.md
    const zedRule = join(repoPath, ".zed", "rules", "codeprism.md");
    if (existsSync(zedRule)) {
      items.push({ path: zedRule, label: ".zed/rules/codeprism.md", kind: "delete" });
    }

    // CLAUDE.md — remove codeprism section
    const claudeMd = join(repoPath, "CLAUDE.md");
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, "utf-8");
      if (content.toLowerCase().includes("codeprism")) {
        items.push({
          path: claudeMd,
          label: "CLAUDE.md — remove codeprism section",
          kind: "remove-section",
          sectionMarker: "codeprism",
        });
      }
    }

    // .windsurfrules — remove codeprism section
    const windsurfRules = join(repoPath, ".windsurfrules");
    if (existsSync(windsurfRules)) {
      const content = readFileSync(windsurfRules, "utf-8");
      if (content.toLowerCase().includes("codeprism")) {
        items.push({
          path: windsurfRules,
          label: ".windsurfrules — remove codeprism section",
          kind: "remove-section",
          sectionMarker: "codeprism",
        });
      }
    }

    // .cursor/mcp.json — remove mcpServers.codeprism
    const cursorMcp = join(repoPath, ".cursor", "mcp.json");
    if (existsSync(cursorMcp)) {
      const content = readFileSync(cursorMcp, "utf-8");
      if (content.includes("codeprism")) {
        items.push({
          path: cursorMcp,
          label: ".cursor/mcp.json — remove codeprism server",
          kind: "remove-json-key",
          jsonKey: "mcpServers.codeprism",
        });
      }
    }

    // Git hooks
    const gitRoot = findGitRoot(repoPath);
    if (gitRoot) {
      const hookNames = ["post-commit", "post-merge", "post-checkout", "post-rewrite"];
      for (const hook of hookNames) {
        const hookPath = join(gitRoot, ".git", "hooks", hook);
        if (existsSync(hookPath)) {
          const content = readFileSync(hookPath, "utf-8");
          if (content.includes("codeprism")) {
            items.push({
              path: hookPath,
              label: `.git/hooks/${hook} — remove codeprism block`,
              kind: "remove-section",
              sectionMarker: "codeprism",
            });
          }
        }
      }
    }
  }

  // --- Global configs ---
  if (!opts.noGlobal) {
    const globalConfigs: Array<{ path: string; label: string; jsonKey: string }> = [
      {
        path: join(homedir(), ".claude", "claude_desktop_config.json"),
        label: "~/.claude/claude_desktop_config.json — remove codeprism",
        jsonKey: "mcpServers.codeprism",
      },
      {
        path: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
        label: "~/.codeium/windsurf/mcp_config.json — remove codeprism",
        jsonKey: "mcpServers.codeprism",
      },
      {
        path: join(homedir(), ".config", "zed", "settings.json"),
        label: "~/.config/zed/settings.json — remove codeprism",
        jsonKey: "context_servers.codeprism",
      },
    ];

    for (const gc of globalConfigs) {
      if (existsSync(gc.path)) {
        const content = readFileSync(gc.path, "utf-8");
        if (content.includes("codeprism")) {
          items.push({
            path: gc.path,
            label: gc.label,
            kind: "remove-json-key",
            jsonKey: gc.jsonKey,
          });
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function tryCleanEmptyParent(filePath: string): void {
  try {
    const parent = join(filePath, "..");
    if (existsSync(parent) && statSync(parent).isDirectory()) {
      const entries = readdirSync(parent);
      if (entries.length === 0) {
        rmSync(parent, { recursive: true });
      }
    }
  } catch {
    // best-effort
  }
}

function executeRemoval(item: RemovalItem): boolean {
  try {
    switch (item.kind) {
      case "delete": {
        rmSync(item.path, { recursive: true, force: true });
        return true;
      }
      case "remove-section": {
        const content = readFileSync(item.path, "utf-8");

        // Git hooks use a different removal strategy
        if (item.path.includes(".git/hooks/")) {
          const result = removeHookBlock(content);
          if (result === null) return false;
          if (result === "" || result.trim() === "" || result.trim() === "#!/bin/sh") {
            unlinkSync(item.path);
            return true;
          }
          writeFileSync(item.path, result + "\n", { encoding: "utf-8", mode: 0o755 });
          return true;
        }

        // Markdown section removal (CLAUDE.md, .windsurfrules)
        const result = removeMdSection(content, item.sectionMarker!);
        if (result === null) return false;
        if (result.trim() === "" || result.trim() === "# Project Notes") {
          unlinkSync(item.path);
          tryCleanEmptyParent(item.path);
          return true;
        }
        writeFileSync(item.path, result + "\n", "utf-8");
        return true;
      }
      case "remove-json-key": {
        const content = readFileSync(item.path, "utf-8");
        const updated = removeJsonKey(content, item.jsonKey!);
        if (updated === null) return false;
        writeFileSync(item.path, updated, "utf-8");
        return true;
      }
    }
  } catch (err) {
    console.error(`  ✗ ${item.label}: ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  const workspaceRoot = userWorkspaceRootFrom(import.meta.url);

  console.log(`\n  Workspace root: ${workspaceRoot}\n`);
  console.log("  Scanning for codeprism artifacts...\n");

  const items = collectItems(workspaceRoot, opts);

  if (items.length === 0) {
    console.log("  Nothing to remove — workspace is clean.\n");
    return;
  }

  // Print summary
  console.log(`  Found ${items.length} item(s) to remove:\n`);
  for (const item of items) {
    const action =
      item.kind === "delete" ? "DELETE" :
      item.kind === "remove-section" ? "EDIT" :
      "EDIT";
    console.log(`    [${action}] ${item.label}`);
  }
  console.log("");

  if (opts.dryRun) {
    console.log("  --dry-run: no changes made.\n");
    return;
  }

  // Confirm unless --force
  if (!opts.force) {
    const { confirm } = await import("@inquirer/prompts");
    const ok = await confirm({
      message: `Remove ${items.length} item(s)?`,
      default: false,
    });
    if (!ok) {
      console.log("  Aborted.\n");
      return;
    }
  }

  // Execute
  let removed = 0;
  let failed = 0;

  for (const item of items) {
    const ok = executeRemoval(item);
    if (ok) {
      console.log(`  ✓ ${item.label}`);
      removed++;
    } else {
      failed++;
    }
  }

  console.log(`\n  Done: ${removed} removed, ${failed} failed.\n`);
}
