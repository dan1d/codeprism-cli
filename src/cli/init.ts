/**
 * codeprism init — interactive setup wizard
 *
 * Sets up a multi-repo workspace with:
 *  1. Repo selection (auto-discovered sibling dirs)
 *  2. Engine URL + API key validation
 *  3. Team rules fetch + cache
 *  4. Editor detection + MCP config auto-install
 *  5. LLM provider + API key configuration
 *  6. .codeprism/ directory with config.json, rules.json, .gitignore
 */

/* eslint-disable no-console */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename, relative } from "node:path";
import { homedir } from "node:os";
import { checkbox, input, password, select, confirm } from "@inquirer/prompts";
import { discoverRepos } from "../config/workspace-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RepoChoice {
  name: string;
  path: string;
}

interface CodeprismConfig {
  engineUrl: string;
  apiKey: string;
  repos: Array<{ path: string; name: string }>;
  exclude: string[];
  llm?: { provider: string; apiKey: string };
}

// ---------------------------------------------------------------------------
// Editor detection + MCP config
// ---------------------------------------------------------------------------

type EditorId = "claude" | "cursor" | "windsurf" | "zed" | "lovable";

interface EditorSpec {
  id: EditorId;
  name: string;
  /** Paths to check for detection (relative to cwd or absolute) */
  detect: (cwd: string) => boolean;
  /** Where the MCP config lives */
  configPath: (cwd: string) => string;
  /** How to write the MCP config */
  writeMcpConfig: (configPath: string, mcpUrl: string, apiKey: string, devEmail: string) => void;
  note: string;
}

function fileExists(...parts: string[]): boolean {
  return existsSync(join(...parts));
}

const EDITORS: EditorSpec[] = [
  {
    id: "cursor",
    name: "Cursor",
    detect: (cwd) =>
      fileExists(cwd, ".cursor") ||
      fileExists(homedir(), ".cursor", "mcp.json"),
    configPath: (cwd) => join(cwd, ".cursor", "mcp.json"),
    writeMcpConfig: (configPath, mcpUrl, apiKey, devEmail) => {
      const dir = resolve(configPath, "..");
      mkdirSync(dir, { recursive: true });
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};
      config.mcpServers = config.mcpServers ?? {};
      config.mcpServers.codeprism = {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Dev-Email": devEmail,
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    },
    note: "Project-level .cursor/mcp.json (recommended)",
  },
  {
    id: "claude",
    name: "Claude Code",
    detect: (_cwd) =>
      fileExists(homedir(), ".claude", "claude_desktop_config.json") ||
      !!process.env["CLAUDE_CODE"],
    configPath: (_cwd) => join(homedir(), ".claude", "claude_desktop_config.json"),
    writeMcpConfig: (configPath, mcpUrl, apiKey, devEmail) => {
      const dir = resolve(configPath, "..");
      mkdirSync(dir, { recursive: true });
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};
      config.mcpServers = config.mcpServers ?? {};
      config.mcpServers.codeprism = {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Dev-Email": devEmail,
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    },
    note: "~/.claude/claude_desktop_config.json",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detect: (_cwd) =>
      fileExists(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    configPath: (_cwd) => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    writeMcpConfig: (configPath, mcpUrl, apiKey, devEmail) => {
      const dir = resolve(configPath, "..");
      mkdirSync(dir, { recursive: true });
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};
      config.mcpServers = config.mcpServers ?? {};
      config.mcpServers.codeprism = {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Dev-Email": devEmail,
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    },
    note: "~/.codeium/windsurf/mcp_config.json",
  },
  {
    id: "zed",
    name: "Zed",
    detect: (_cwd) =>
      fileExists(homedir(), ".config", "zed", "settings.json"),
    configPath: (_cwd) => join(homedir(), ".config", "zed", "settings.json"),
    writeMcpConfig: (configPath, mcpUrl, apiKey, devEmail) => {
      const dir = resolve(configPath, "..");
      mkdirSync(dir, { recursive: true });
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};
      config.context_servers = config.context_servers ?? {};
      config.context_servers.codeprism = {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Dev-Email": devEmail,
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    },
    note: "~/.config/zed/settings.json (under context_servers)",
  },
];

function detectEditors(cwd: string): EditorSpec[] {
  return EDITORS.filter((e) => e.detect(cwd));
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function validateApiKey(
  engineUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; teamName?: string; email?: string; error?: string }> {
  try {
    const res = await fetch(`${engineUrl}/api/instance-info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { ok: false, error: `${res.status}: ${text}` };
    }
    const data = (await res.json()) as { companyName?: string };
    return { ok: true, teamName: data.companyName || "Your team" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function fetchTeamRules(
  engineUrl: string,
  apiKey: string,
): Promise<unknown[]> {
  try {
    const res = await fetch(`${engineUrl}/api/rules`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    return (await res.json()) as unknown[];
  } catch {
    return [];
  }
}

async function fetchDevEmail(
  engineUrl: string,
  apiKey: string,
): Promise<string> {
  try {
    const res = await fetch(`${engineUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { email?: string };
    return data.email ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Main init wizard
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for an existing `.codeprism/config.json`
 * in a parent directory. Returns the parent path or null.
 */
function findParentConfig(startDir: string): string | null {
  let dir = resolve(startDir, "..");
  while (true) {
    if (existsSync(join(dir, ".codeprism", "config.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function runInit(cwd: string): Promise<void> {
  const configDir = join(cwd, ".codeprism");
  const configPath = join(configDir, "config.json");

  console.log(`
╔══════════════════════════════════════════════╗
║           codeprism workspace setup          ║
╚══════════════════════════════════════════════╝
`);
  console.log(`  Workspace root: ${cwd}\n`);

  // Step 0a: Check if a parent directory already has .codeprism/
  const parentConfig = findParentConfig(cwd);
  if (parentConfig) {
    console.log(`  ⚠ An existing workspace was found at: ${parentConfig}`);
    console.log(`    That workspace already has a .codeprism/config.json.\n`);

    const choice = await select({
      message: "What would you like to do?",
      choices: [
        {
          name: `Use existing workspace at ${parentConfig} (recommended)`,
          value: "use-parent",
        },
        {
          name: `Create a new workspace here at ${cwd}`,
          value: "new-here",
        },
        {
          name: "Abort",
          value: "abort",
        },
      ],
    });

    if (choice === "abort") {
      console.log("Aborted.");
      return;
    }
    if (choice === "use-parent") {
      console.log(`\n  All codeprism commands will use the workspace at: ${parentConfig}`);
      console.log(`  Run commands from that directory, or pass --workspace ${parentConfig}\n`);
      console.log(`  To re-initialize that workspace: cd ${parentConfig} && npx codeprism init`);
      return;
    }
    // "new-here" continues with current cwd
  }

  // Step 0b: Check for existing config in current dir
  if (existsSync(configDir)) {
    const reinit = await confirm({
      message: ".codeprism/ already exists here. Re-initialize?",
      default: false,
    });
    if (!reinit) {
      console.log("Aborted.");
      return;
    }
  }

  // ── Step 1: Discover & select repos ──────────────────────────────────
  console.log("\n  Scanning for repositories...\n");
  const discovered = discoverRepos(cwd);

  let repos: RepoChoice[];

  if (discovered.length === 0) {
    console.log("  No repositories found in the current directory.");
    const manualPath = await input({
      message: "Enter a repo path (relative or absolute):",
    });
    const abs = resolve(cwd, manualPath);
    repos = [{ name: basename(abs), path: relative(cwd, abs) || "." }];
  } else if (discovered.length === 1) {
    console.log(`  Found 1 repo: ${discovered[0]!.name}\n`);
    repos = [{ name: discovered[0]!.name, path: relative(cwd, discovered[0]!.path) || "." }];
  } else {
    const selected = await checkbox({
      message: "Select repositories to index together:",
      choices: discovered.map((r) => ({
        name: r.name,
        value: r,
        checked: true,
      })),
    });
    if (selected.length === 0) {
      console.log("No repos selected. Aborted.");
      return;
    }
    repos = selected.map((r) => ({
      name: r.name,
      path: relative(cwd, r.path) || ".",
    }));
  }

  if (repos.length >= 2) {
    console.log(`
  Multi-repo workspace detected!
  Indexing ${repos.length} repos together generates cross-service cards
  mapping API connections between them.
`);
  }

  // ── Step 2: Engine URL ───────────────────────────────────────────────
  const engineUrl = await input({
    message: "Engine URL:",
    default: process.env["CODEPRISM_ENGINE_URL"] || "https://gobiobridge.codeprism.dev",
  });
  const cleanEngineUrl = engineUrl.replace(/\/$/, "");

  // ── Step 3: API key ──────────────────────────────────────────────────
  const apiKey = await password({
    message: "Team API key:",
    mask: "*",
  });
  if (!apiKey) {
    console.log("No API key provided. Aborted.");
    return;
  }

  // Validate
  console.log("\n  Validating API key...");
  const validation = await validateApiKey(cleanEngineUrl, apiKey);
  if (!validation.ok) {
    console.log(`\n  API key validation failed: ${validation.error}`);
    const proceed = await confirm({
      message: "Continue anyway? (config will be saved, you can fix the key later)",
      default: false,
    });
    if (!proceed) return;
  } else {
    console.log(`  Connected to: ${validation.teamName}\n`);
  }

  // Fetch dev email for MCP headers
  let devEmail = await fetchDevEmail(cleanEngineUrl, apiKey);
  if (!devEmail) {
    devEmail = await input({
      message: "Your email (for MCP request attribution):",
      default: process.env["USER"] ? `${process.env["USER"]}@example.com` : "",
    });
  }

  // ── Step 4: Editor detection + MCP config ────────────────────────────
  const detected = detectEditors(cwd);
  const tenantSlug = cleanEngineUrl.includes("gobiobridge")
    ? "gobiobridge"
    : cleanEngineUrl.split("//")[1]?.split(".")[0] ?? "default";
  const mcpUrl = `${cleanEngineUrl}/${tenantSlug}/mcp/sse`;

  if (detected.length > 0) {
    const editorNames = detected.map((e) => e.name).join(", ");
    console.log(`  Detected editors: ${editorNames}\n`);

    const installMcp = await checkbox({
      message: "Install MCP config for:",
      choices: detected.map((e) => ({
        name: `${e.name} (${e.note})`,
        value: e,
        checked: true,
      })),
    });

    for (const editor of installMcp) {
      const cfgPath = editor.configPath(cwd);
      try {
        editor.writeMcpConfig(cfgPath, mcpUrl, apiKey, devEmail);
        console.log(`  ✓ ${editor.name} — MCP config written to ${cfgPath}`);
      } catch (err) {
        console.warn(`  ✗ ${editor.name} — failed: ${(err as Error).message}`);
      }
    }
    console.log("");
  } else {
    console.log("  No supported editors detected automatically.\n");
    const manualEditor = await select({
      message: "Install MCP config for an editor?",
      choices: [
        { name: "Skip (I'll configure manually)", value: "skip" },
        ...EDITORS.map((e) => ({ name: `${e.name} (${e.note})`, value: e.id })),
      ],
    });

    if (manualEditor !== "skip") {
      const editor = EDITORS.find((e) => e.id === manualEditor)!;
      const cfgPath = editor.configPath(cwd);
      try {
        editor.writeMcpConfig(cfgPath, mcpUrl, apiKey, devEmail);
        console.log(`  ✓ ${editor.name} — MCP config written to ${cfgPath}\n`);
      } catch (err) {
        console.warn(`  ✗ ${editor.name} — failed: ${(err as Error).message}\n`);
      }
    }

    // Show the config for manual copy
    console.log("  MCP config (for manual setup):\n");
    const mcpConfig = JSON.stringify(
      {
        mcpServers: {
          codeprism: {
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Dev-Email": devEmail,
            },
          },
        },
      },
      null,
      2,
    );
    console.log(`  ${mcpConfig.split("\n").join("\n  ")}\n`);
  }

  // ── Step 5: LLM provider ─────────────────────────────────────────────
  const llmProvider = await select({
    message: "LLM provider for indexing (uses your own API key):",
    choices: [
      { name: "Anthropic (claude-opus-4-6 — best quality)", value: "anthropic" },
      { name: "DeepSeek (deepseek-chat — best value)", value: "deepseek" },
      { name: "OpenAI (gpt-4o)", value: "openai" },
      { name: "Google Gemini (free tier available)", value: "gemini" },
      { name: "Skip — I'll set env vars manually", value: "skip" },
    ],
  });

  let llmConfig: { provider: string; apiKey: string } | undefined;

  if (llmProvider !== "skip") {
    const llmKey = await password({
      message: `${llmProvider.charAt(0).toUpperCase() + llmProvider.slice(1)} API key:`,
      mask: "*",
    });
    if (llmKey) {
      llmConfig = { provider: llmProvider, apiKey: llmKey };
    }
  }

  // ── Step 6: Fetch team rules ─────────────────────────────────────────
  console.log("  Fetching team rules...");
  const rules = await fetchTeamRules(cleanEngineUrl, apiKey);
  console.log(`  ${rules.length} rule(s) cached.\n`);

  // ── Step 7: Create .codeprism/ directory ─────────────────────────────
  mkdirSync(configDir, { recursive: true });

  const config: CodeprismConfig = {
    engineUrl: cleanEngineUrl,
    apiKey,
    repos: repos.map((r) => ({ path: r.path, name: r.name })),
    exclude: [],
  };
  if (llmConfig) {
    config.llm = llmConfig;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  writeFileSync(join(configDir, "rules.json"), JSON.stringify(rules, null, 2) + "\n", "utf-8");
  writeFileSync(join(configDir, ".gitignore"), "config.json\n", "utf-8");

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════╗
║             Setup complete!                  ║
╚══════════════════════════════════════════════╝

  Created:
    .codeprism/config.json  — workspace config (git-ignored)
    .codeprism/rules.json   — cached team rules
    .codeprism/.gitignore   — protects API key

  Repos: ${repos.map((r) => r.name).join(", ")}
  Engine: ${cleanEngineUrl}
`);

  // Build the index command with env vars
  const envPrefix = llmConfig
    ? `CODEPRISM_LLM_PROVIDER=${llmConfig.provider} CODEPRISM_LLM_API_KEY=<your-key> `
    : `CODEPRISM_LLM_PROVIDER=anthropic CODEPRISM_LLM_API_KEY=<your-key> `;

  console.log(`  Next steps:

    1. Index your repos:
       ${envPrefix}npx codeprism index

    2. Push to the team engine:
       npx codeprism push

  The push command reads engine URL and API key from .codeprism/config.json
  — no flags needed!
`);
}
