/**
 * Tests for src/cli/uninstall.ts
 *
 * Coverage:
 *   - Workspace root cleanup (.codeprism/, codeprism.db, codeprism.config.json)
 *   - Per-repo cleanup (ai-codeprism/, cursor rules, zed rules)
 *   - Section removal from CLAUDE.md, .windsurfrules (strip section or delete file)
 *   - JSON key removal from .cursor/mcp.json (remove codeprism, keep others)
 *   - Git hook codeprism block removal
 *   - CLI options: --dry-run, --force, --no-global
 *   - Edge cases: clean workspace, config-less fallback
 *
 * Isolation:
 *   - @inquirer/prompts (confirm) → vi.mock
 *   - ./install-hook.js (findGitRoot) → vi.mock (avoids real git operations)
 *   - process.cwd() → vi.spyOn to point at temp workspace
 *   - console.log/warn/error → suppressed
 *   - Real temp directories on disk, cleaned in afterEach
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
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks — hoisted above all imports
// ---------------------------------------------------------------------------

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock("../install-hook.js", () => ({
  findGitRoot: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runUninstall } from "../uninstall.js";
import { findGitRoot } from "../install-hook.js";
import { confirm } from "@inquirer/prompts";

const mockFindGitRoot = findGitRoot as MockedFunction<typeof findGitRoot>;
const mockConfirm = confirm as MockedFunction<typeof confirm>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "codeprism-uninstall-"));
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function writeText(filePath: string, content: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

/**
 * Write a workspace config with repos. Creates .codeprism/config.json,
 * rules.json, and .gitignore.
 */
function writeConfig(
  tmpDir: string,
  repos: Array<{ path: string; name: string }> = [{ path: ".", name: "test-repo" }],
): void {
  writeJson(join(tmpDir, ".codeprism", "config.json"), {
    engineUrl: "https://test.codeprism.dev",
    apiKey: "sk_test",
    repos,
    exclude: [],
  });
  writeText(join(tmpDir, ".codeprism", "rules.json"), "[]");
  writeText(join(tmpDir, ".codeprism", ".gitignore"), "config.json\n");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("runUninstall", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockConfirm.mockResolvedValue(true as never);
    mockFindGitRoot.mockReturnValue(null);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockFindGitRoot.mockReset();
    mockConfirm.mockReset();
  });

  // ── Workspace root cleanup ────────────────────────────────────────────

  describe("workspace root cleanup", () => {
    it("removes .codeprism/ directory", async () => {
      writeConfig(tmpDir);

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(tmpDir, ".codeprism"))).toBe(false);
    });

    it("removes codeprism.db", async () => {
      writeConfig(tmpDir);
      writeText(join(tmpDir, "codeprism.db"), "fake-sqlite-content");

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(tmpDir, "codeprism.db"))).toBe(false);
    });

    it("removes legacy codeprism.config.json", async () => {
      writeConfig(tmpDir);
      writeJson(join(tmpDir, "codeprism.config.json"), { repos: [] });

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(tmpDir, "codeprism.config.json"))).toBe(false);
    });
  });

  // ── Per-repo file deletions ───────────────────────────────────────────

  describe("per-repo file deletions", () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = join(tmpDir, "my-repo");
      mkdirSync(repoDir, { recursive: true });
      writeConfig(tmpDir, [{ path: "my-repo", name: "my-repo" }]);
    });

    it("removes ai-codeprism/ directory", async () => {
      mkdirSync(join(repoDir, "ai-codeprism"), { recursive: true });
      writeText(join(repoDir, "ai-codeprism", "overview.md"), "# Generated doc");

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, "ai-codeprism"))).toBe(false);
    });

    it("removes .cursor/rules/codeprism.mdc", async () => {
      writeText(
        join(repoDir, ".cursor", "rules", "codeprism.mdc"),
        "---\nalwaysApply: true\n---\n# codeprism rule",
      );

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, ".cursor", "rules", "codeprism.mdc"))).toBe(false);
    });

    it("removes .zed/rules/codeprism.md", async () => {
      writeText(
        join(repoDir, ".zed", "rules", "codeprism.md"),
        "# codeprism Context Rule\nAlways call codeprism_context.",
      );

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, ".zed", "rules", "codeprism.md"))).toBe(false);
    });
  });

  // ── Section removal (CLAUDE.md, .windsurfrules) ───────────────────────

  describe("section removal", () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = join(tmpDir, "my-repo");
      mkdirSync(repoDir, { recursive: true });
      writeConfig(tmpDir, [{ path: "my-repo", name: "my-repo" }]);
    });

    it("strips codeprism section from CLAUDE.md, keeps other content", async () => {
      const content = [
        "# My Project",
        "",
        "Some description here.",
        "",
        "## codeprism (team knowledge base)",
        "",
        "Always call `codeprism_context` at the start of every task.",
        "",
        "## Other Section",
        "",
        "Other content here.",
      ].join("\n");
      writeText(join(repoDir, "CLAUDE.md"), content);

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, "CLAUDE.md"))).toBe(true);
      const result = readFileSync(join(repoDir, "CLAUDE.md"), "utf-8");
      expect(result).toContain("# My Project");
      expect(result).toContain("Some description here.");
      expect(result).toContain("## Other Section");
      expect(result).toContain("Other content here.");
      expect(result.toLowerCase()).not.toContain("codeprism");
    });

    it("deletes CLAUDE.md when it only contains codeprism boilerplate", async () => {
      const content = [
        "# Project Notes",
        "",
        "## codeprism (team knowledge base)",
        "",
        "Always call `codeprism_context` at the start of every task.",
      ].join("\n");
      writeText(join(repoDir, "CLAUDE.md"), content);

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, "CLAUDE.md"))).toBe(false);
    });

    it("strips codeprism section from .windsurfrules, keeps other content", async () => {
      const content = [
        "# General Rules",
        "",
        "Some rules here.",
        "",
        "# codeprism",
        "",
        "Always call `codeprism_context` at the start of every task.",
        "",
        "# Another Rule",
        "",
        "Other rule content.",
      ].join("\n");
      writeText(join(repoDir, ".windsurfrules"), content);

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, ".windsurfrules"))).toBe(true);
      const result = readFileSync(join(repoDir, ".windsurfrules"), "utf-8");
      expect(result).toContain("# General Rules");
      expect(result).toContain("# Another Rule");
      expect(result.toLowerCase()).not.toContain("codeprism");
    });

    it("deletes .windsurfrules when it only contains codeprism content", async () => {
      const content = [
        "# codeprism",
        "",
        "Always call `codeprism_context` at the start of every task.",
      ].join("\n");
      writeText(join(repoDir, ".windsurfrules"), content);

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, ".windsurfrules"))).toBe(false);
    });
  });

  // ── JSON key removal (.cursor/mcp.json) ───────────────────────────────

  describe("JSON key removal", () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = join(tmpDir, "my-repo");
      mkdirSync(repoDir, { recursive: true });
      writeConfig(tmpDir, [{ path: "my-repo", name: "my-repo" }]);
    });

    it("removes mcpServers.codeprism from .cursor/mcp.json, keeps other keys", async () => {
      writeJson(join(repoDir, ".cursor", "mcp.json"), {
        mcpServers: {
          codeprism: { url: "http://localhost:4000/mcp/sse" },
          otherServer: { url: "http://localhost:5000" },
        },
      });

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      const result = JSON.parse(readFileSync(join(repoDir, ".cursor", "mcp.json"), "utf-8"));
      expect(result.mcpServers.codeprism).toBeUndefined();
      expect(result.mcpServers.otherServer).toBeDefined();
      expect(result.mcpServers.otherServer.url).toBe("http://localhost:5000");
    });

    it("keeps .cursor/mcp.json intact (empty mcpServers) when codeprism is the only server", async () => {
      writeJson(join(repoDir, ".cursor", "mcp.json"), {
        mcpServers: {
          codeprism: { url: "http://localhost:4000/mcp/sse" },
        },
      });

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, ".cursor", "mcp.json"))).toBe(true);
      const result = JSON.parse(readFileSync(join(repoDir, ".cursor", "mcp.json"), "utf-8"));
      expect(result.mcpServers.codeprism).toBeUndefined();
      expect(Object.keys(result.mcpServers)).toHaveLength(0);
    });
  });

  // ── Git hook removal ──────────────────────────────────────────────────

  describe("git hook removal", () => {
    let repoDir: string;
    let hooksDir: string;

    beforeEach(() => {
      repoDir = join(tmpDir, "my-repo");
      hooksDir = join(repoDir, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeConfig(tmpDir, [{ path: "my-repo", name: "my-repo" }]);
      mockFindGitRoot.mockReturnValue(repoDir);
    });

    it("deletes a hook file that is entirely codeprism content", async () => {
      const hookContent = [
        "#!/bin/sh",
        "# codeprism post-commit — installed by `codeprism install-hook`",
        "# Syncs after each commit. Non-blocking.",
        "",
        '_codeprism_sync_range() {',
        '  CODEPRISM_URL="http://localhost:4000"',
        '  CODEPRISM_EVENT="$1"',
        "}",
        "",
        '_codeprism_sync_range save "HEAD~1..HEAD"',
      ].join("\n");
      writeFileSync(join(hooksDir, "post-commit"), hookContent, { encoding: "utf-8", mode: 0o755 });

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(hooksDir, "post-commit"))).toBe(false);
    });

    it("removes codeprism block from a hook that has other content", async () => {
      const hookContent = [
        "#!/bin/sh",
        "# My custom post-commit hook",
        'echo "Custom hook running"',
        "",
        "# codeprism post-commit — syncs after each commit",
        '_codeprism_sync_range() {',
        '  CODEPRISM_URL="http://localhost:4000"',
        "}",
        '_codeprism_sync_range save "HEAD~1..HEAD"',
      ].join("\n");
      writeFileSync(join(hooksDir, "post-commit"), hookContent, { encoding: "utf-8", mode: 0o755 });

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(hooksDir, "post-commit"))).toBe(true);
      const result = readFileSync(join(hooksDir, "post-commit"), "utf-8");
      expect(result).toContain("Custom hook running");
      expect(result.toLowerCase()).not.toContain("codeprism");
    });

    it("scans all four hook types", async () => {
      const hooks = ["post-commit", "post-merge", "post-checkout", "post-rewrite"];
      for (const hook of hooks) {
        const content = [
          "#!/bin/sh",
          `# codeprism ${hook}`,
          '_codeprism_sync_range() {',
          '  CODEPRISM_URL="http://localhost:4000"',
          "}",
        ].join("\n");
        writeFileSync(join(hooksDir, hook), content, { encoding: "utf-8", mode: 0o755 });
      }

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      for (const hook of hooks) {
        expect(existsSync(join(hooksDir, hook))).toBe(false);
      }
    });
  });

  // ── CLI options ───────────────────────────────────────────────────────

  describe("CLI options", () => {
    it("--dry-run lists items but does not remove them", async () => {
      writeConfig(tmpDir);
      writeText(join(tmpDir, "codeprism.db"), "fake");

      await runUninstall({ force: true, noGlobal: true, dryRun: true });

      expect(existsSync(join(tmpDir, ".codeprism"))).toBe(true);
      expect(existsSync(join(tmpDir, "codeprism.db"))).toBe(true);
    });

    it("--force skips confirmation prompt", async () => {
      writeConfig(tmpDir);

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("prompts for confirmation when --force is not set", async () => {
      writeConfig(tmpDir);
      mockConfirm.mockResolvedValueOnce(true as never);

      await runUninstall({ force: false, noGlobal: true, dryRun: false });

      expect(mockConfirm).toHaveBeenCalledOnce();
    });

    it("aborts when user declines confirmation", async () => {
      writeConfig(tmpDir);
      mockConfirm.mockReset();
      mockConfirm.mockResolvedValueOnce(false as never);

      await runUninstall({ force: false, noGlobal: true, dryRun: false });

      // .codeprism should still exist because user declined
      expect(existsSync(join(tmpDir, ".codeprism"))).toBe(true);
    });

    it("reports nothing for a clean workspace", async () => {
      // Empty tmpDir — no artifacts at all
      const logMock = console.log as MockedFunction<typeof console.log>;

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      const messages = logMock.mock.calls.map((args) => args[0]).join(" ");
      expect(messages).toContain("Nothing to remove");
    });
  });

  // ── Config fallback ───────────────────────────────────────────────────

  describe("config fallback", () => {
    it("falls back to auto-discovery when .codeprism/config.json is missing", async () => {
      // Create a repo with a .git dir (REPO_MARKER) so auto-discover finds it
      const repoDir = join(tmpDir, "discovered-repo");
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      mkdirSync(join(repoDir, "ai-codeprism"), { recursive: true });
      writeText(join(repoDir, "ai-codeprism", "doc.md"), "# Generated");

      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      expect(existsSync(join(repoDir, "ai-codeprism"))).toBe(false);
    });
  });

  // ── Full cleanup integration ──────────────────────────────────────────

  describe("full cleanup", () => {
    it("removes all artifact types in a single run", async () => {
      const repoDir = join(tmpDir, "my-repo");
      mkdirSync(repoDir, { recursive: true });
      writeConfig(tmpDir, [{ path: "my-repo", name: "my-repo" }]);

      // Workspace root artifacts
      writeText(join(tmpDir, "codeprism.db"), "fake-db");
      writeJson(join(tmpDir, "codeprism.config.json"), { repos: [] });

      // Per-repo artifacts
      mkdirSync(join(repoDir, "ai-codeprism"), { recursive: true });
      writeText(join(repoDir, "ai-codeprism", "doc.md"), "# Doc");
      writeText(
        join(repoDir, ".cursor", "rules", "codeprism.mdc"),
        "---\nalwaysApply: true\n---",
      );
      writeText(
        join(repoDir, ".zed", "rules", "codeprism.md"),
        "# codeprism rules",
      );
      writeText(join(repoDir, "CLAUDE.md"), [
        "# Project Notes",
        "",
        "## codeprism (team knowledge base)",
        "",
        "Content here.",
      ].join("\n"));
      writeJson(join(repoDir, ".cursor", "mcp.json"), {
        mcpServers: {
          codeprism: { url: "http://localhost:4000/mcp/sse" },
          other: { url: "http://other:5000" },
        },
      });

      // Git hook
      const hooksDir = join(repoDir, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        join(hooksDir, "post-commit"),
        "#!/bin/sh\n# codeprism post-commit\n_codeprism_sync_range() { true; }\n",
        { encoding: "utf-8", mode: 0o755 },
      );
      mockFindGitRoot.mockReturnValue(repoDir);

      // Execute
      await runUninstall({ force: true, noGlobal: true, dryRun: false });

      // Verify workspace root
      expect(existsSync(join(tmpDir, ".codeprism"))).toBe(false);
      expect(existsSync(join(tmpDir, "codeprism.db"))).toBe(false);
      expect(existsSync(join(tmpDir, "codeprism.config.json"))).toBe(false);

      // Verify per-repo deletions
      expect(existsSync(join(repoDir, "ai-codeprism"))).toBe(false);
      expect(existsSync(join(repoDir, ".cursor", "rules", "codeprism.mdc"))).toBe(false);
      expect(existsSync(join(repoDir, ".zed", "rules", "codeprism.md"))).toBe(false);

      // Verify section removals
      expect(existsSync(join(repoDir, "CLAUDE.md"))).toBe(false); // only boilerplate → deleted

      // Verify JSON key removal (file kept, key removed)
      const mcp = JSON.parse(readFileSync(join(repoDir, ".cursor", "mcp.json"), "utf-8"));
      expect(mcp.mcpServers.codeprism).toBeUndefined();
      expect(mcp.mcpServers.other).toBeDefined();

      // Verify git hook removed
      expect(existsSync(join(hooksDir, "post-commit"))).toBe(false);
    });
  });
});
