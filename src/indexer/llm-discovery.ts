/**
 * LLM-First Discovery — runs before flow detection.
 *
 * Uses claude-opus-4-6 to:
 *   1. Read all READMEs in the repo
 *   2. Walk the full directory tree and classify each directory
 *   3. Identify real business features (not Louvain code clusters)
 *   4. For multi-repo workspaces, detect system topology
 *      (monolith / api+frontend / microservices / fullstack_monorepo)
 *
 * Output:
 *   - SeedFlow[] fed into detectFlows() before Louvain runs
 *   - DISCOVERY.md written to <repo>/ai-codeprism/DISCOVERY.md
 *   - WorkspaceTopology (cross-repo only, written to workspace root)
 *
 * Requires ANTHROPIC_API_KEY for Opus. Falls back gracefully to empty seeds
 * if the key is missing or the LLM call fails.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ParsedFile } from "./types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { SeedFlow } from "./route-extractor.js";
import {
  DISCOVERY_SYSTEM_PROMPT,
  buildDirectoryClassificationPrompt,
  buildFeatureDiscoveryPrompt,
  buildWorkspaceTopologyPrompt,
} from "./doc-prompts.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  repoName: string;
  seedFlows: SeedFlow[];
  mdContent: string;
  /** Compact summary used for workspace topology prompt */
  dirSummary: string;
  framework: string;
  repoClass: string;
}

export interface WorkspaceTopology {
  topology: string;
  description: string;
  repos: Array<{ name: string; role: string; serves: string[]; dependsOn: string[] }>;
  sharedConcepts: string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RepoTypeHint {
  repoClass: string;
  likelyFramework: string;
  signals: string[];
}

interface DirClassification {
  framework: string;
  repoType: string;
  primaryLanguage: string;
  repoClass: string;
  directories: Array<{ path: string; role: string; layer: string }>;
}

interface DiscoveredFeature {
  name: string;
  description: string;
  directoryPatterns: string[];
  filePatterns: string[];
  confidence: string;
}

// ---------------------------------------------------------------------------
// Directories to skip when building the tree
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", "vendor", ".git", ".svn", "tmp", "log", "logs",
  "coverage", "dist", "build", ".build", "__pycache__", ".bundle",
  ".cache", ".next", ".nuxt", ".output", "public/packs", "public/assets",
  ".turbo", ".yarn",
]);

// ---------------------------------------------------------------------------
// Step 1: Build directory tree (full depth, all dirs, no file listing)
// ---------------------------------------------------------------------------

/**
 * Builds a full directory tree string showing every directory with its
 * direct file count. No depth cap — we want full visibility for the LLM.
 * Directories in SKIP_DIRS are collapsed to a single line with a note.
 */
export function buildDirectoryTree(repoPath: string): string {
  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    const dirs: string[] = [];
    let fileCount = 0;

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          dirs.push(entry);
        } else {
          fileCount++;
        }
      } catch {
        // skip unreadable entries
      }
    }

    // Show file count for this directory
    const rel = relative(repoPath, dir) || ".";
    if (depth > 0) {
      lines.push(`${prefix}${rel.split("/").pop()}/  [${fileCount} files, ${dirs.length} subdirs]`);
    }

    for (const d of dirs) {
      if (SKIP_DIRS.has(d)) {
        lines.push(`${prefix}  ${d}/  [skipped]`);
        continue;
      }
      walk(join(dir, d), prefix + "  ", depth + 1);
    }
  }

  walk(repoPath, "", 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step 2: Read all READMEs
// ---------------------------------------------------------------------------

/**
 * Reads all READMEs found in the repo root and one level of subdirectories.
 * No content cap — the LLM should see everything.
 */
export function readAllReadmes(repoPath: string): string {
  const candidates: string[] = [];

  // Root-level READMEs
  for (const name of ["README.md", "readme.md", "README.rst", "README.txt", "README"]) {
    candidates.push(join(repoPath, name));
  }

  // Subdirectory READMEs (one level deep, useful for monorepos)
  try {
    const entries = readdirSync(repoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      for (const name of ["README.md", "readme.md", "README.rst"]) {
        candidates.push(join(repoPath, entry.name, name));
      }
    }
  } catch { /* ignore */ }

  const parts: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, "utf-8").trim();
      if (!content) continue;
      const rel = relative(repoPath, candidate);
      parts.push(`### ${rel}\n\n${content}`);
    } catch { /* skip */ }
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Step 3: Lightweight heuristic repo-type detection (no LLM cost)
// ---------------------------------------------------------------------------

export function detectRepoTypeHint(tree: string, readme: string, repoPath: string): RepoTypeHint {
  const signals: string[] = [];
  let repoClass = "unknown";
  let likelyFramework = "unknown";

  const hasFile = (name: string) => existsSync(join(repoPath, name));
  const treeHas = (fragment: string) => tree.includes(fragment);
  const readmeHas = (fragment: string) => readme.toLowerCase().includes(fragment.toLowerCase());

  // Rails
  if (hasFile("Gemfile") && (treeHas("app/models/") || treeHas("app/controllers/"))) {
    repoClass = "backend"; likelyFramework = "Rails";
    signals.push("Gemfile present", "app/models or app/controllers found");
  }
  // Sinatra / generic Ruby
  else if (hasFile("Gemfile") && !treeHas("app/models/")) {
    repoClass = "backend"; likelyFramework = "Sinatra/Ruby";
    signals.push("Gemfile present");
  }
  // Django
  else if ((hasFile("manage.py") || readmeHas("django")) && hasFile("requirements.txt")) {
    repoClass = "backend"; likelyFramework = "Django";
    signals.push("manage.py or Django in README", "requirements.txt");
  }
  // FastAPI / Flask
  else if (hasFile("requirements.txt") || hasFile("pyproject.toml")) {
    repoClass = "backend"; likelyFramework = "Python";
    signals.push("requirements.txt or pyproject.toml");
    if (readmeHas("fastapi")) likelyFramework = "FastAPI";
    else if (readmeHas("flask")) likelyFramework = "Flask";
  }
  // Go
  else if (hasFile("go.mod")) {
    repoClass = "backend"; likelyFramework = "Go";
    signals.push("go.mod present");
    if (readmeHas("gin")) likelyFramework = "Gin";
    else if (readmeHas("echo")) likelyFramework = "Echo";
  }
  // PHP / Laravel
  else if (hasFile("composer.json")) {
    repoClass = "backend"; likelyFramework = "Laravel/PHP";
    signals.push("composer.json present");
  }
  // NestJS / Node backend
  else if (hasFile("package.json") && (treeHas("src/modules/") || treeHas("src/controllers/"))) {
    repoClass = "backend"; likelyFramework = "NestJS";
    signals.push("package.json with modules/controllers structure");
  }
  // Next.js (fullstack)
  else if (hasFile("package.json") && (hasFile("next.config.js") || hasFile("next.config.ts") || hasFile("next.config.mjs"))) {
    repoClass = "fullstack"; likelyFramework = "Next.js";
    signals.push("next.config found");
  }
  // React / Vue / Angular / Svelte (frontend)
  else if (hasFile("package.json")) {
    const pkgContent = (() => {
      try { return readFileSync(join(repoPath, "package.json"), "utf-8"); } catch { return ""; }
    })();
    if (pkgContent.includes('"react"') || treeHas("src/components/") || treeHas("src/pages/")) {
      repoClass = "frontend"; likelyFramework = "React";
      signals.push("React dependency or src/components/src/pages");
      if (pkgContent.includes('"next"')) { likelyFramework = "Next.js"; repoClass = "fullstack"; }
    } else if (pkgContent.includes('"vue"') || treeHas("src/views/")) {
      repoClass = "frontend"; likelyFramework = "Vue";
      signals.push("Vue dependency or src/views");
    } else if (pkgContent.includes('"@angular/core"')) {
      repoClass = "frontend"; likelyFramework = "Angular";
      signals.push("@angular/core dependency");
    } else if (pkgContent.includes('"svelte"')) {
      repoClass = "frontend"; likelyFramework = "Svelte";
      signals.push("Svelte dependency");
    } else {
      repoClass = "backend"; likelyFramework = "Node.js";
      signals.push("package.json without FE framework signals");
    }
  }

  return { repoClass, likelyFramework, signals };
}

// ---------------------------------------------------------------------------
// Step 4a: Key-files listing — flat list of file basenames per LLM-classified dir
// ---------------------------------------------------------------------------

// Role/layer fragments that indicate non-domain directories (tests, config, assets…).
// We exclude these so we only show domain code files to the LLM in Call 2.
const EXCLUDED_ROLE_FRAGMENTS = [
  "test", "spec", "vendor", "config", "asset", "build", "migrat",
  "fixture", "seed", "public", "static", "generat", "cache", "tmp", "log",
];
const EXCLUDED_LAYER_FRAGMENTS = [
  "test", "vendor", "config", "build", "asset", "generat",
];

function isDomainDir(dir: { path: string; role: string; layer: string }): boolean {
  const r = dir.role.toLowerCase();
  const l = dir.layer.toLowerCase();
  return (
    !EXCLUDED_ROLE_FRAGMENTS.some((f) => r.includes(f)) &&
    !EXCLUDED_LAYER_FRAGMENTS.some((f) => l.includes(f))
  );
}

/**
 * Returns a compact block like:
 *   app/controllers/api/v1/: accounts_controller, bookmarks_controller, ...
 *   app/models/: account, bookmark, status, tag, ...
 *   lib/kamal/commands/: app, builder, proxy, registry, ...
 *
 * Uses the LLM's own directory classification (from Call 1) to decide which
 * directories to surface — no hardcoded path patterns needed. Works for Rails,
 * Go, Ruby gems, CLI tools, Django, Laravel, etc.
 */
export function buildKeyFilesListing(
  parsedFiles: ParsedFile[],
  repoAbsPath: string,
  classifiedDirs: Array<{ path: string; role: string; layer: string }>,
): string {
  const domainDirPaths = classifiedDirs
    .filter(isDomainDir)
    .map((d) => d.path.replace(/^\/|\/$/g, "")); // normalize: no leading/trailing slash

  if (domainDirPaths.length === 0) return "";

  const byDir = new Map<string, string[]>();

  for (const pf of parsedFiles) {
    const rel = pf.path.startsWith(repoAbsPath + "/")
      ? pf.path.slice(repoAbsPath.length + 1)
      : pf.path;

    const parts = rel.split("/");
    if (parts.length < 2) continue;

    const dir = parts.slice(0, -1).join("/");
    const fileName = parts[parts.length - 1] ?? "";
    const baseName = fileName.replace(/\.[^.]+$/, "");
    if (!baseName || baseName.startsWith(".")) continue;

    const isUnderDomainDir = domainDirPaths.some(
      (dp) => dir === dp || dir.startsWith(dp + "/"),
    );
    if (!isUnderDomainDir) continue;

    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(baseName);
  }

  const lines: string[] = [];
  for (const [dir, files] of [...byDir.entries()].sort()) {
    if (files.length === 0) continue;
    lines.push(`${dir}/: ${files.sort().join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step 4b: Compute file counts per directory (no cap)
// ---------------------------------------------------------------------------

function computeFileCounts(parsedFiles: ParsedFile[], repoAbsPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pf of parsedFiles) {
    const rel = pf.path.startsWith(repoAbsPath + "/")
      ? pf.path.slice(repoAbsPath.length + 1)
      : pf.path;
    const parts = rel.split("/");
    // Count in every ancestor directory
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      counts[dir] = (counts[dir] ?? 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Step 5: Match LLM patterns → actual file paths
// ---------------------------------------------------------------------------

function matchPatternsToFiles(
  features: DiscoveredFeature[],
  parsedFiles: ParsedFile[],
  repoAbsPath: string,
): SeedFlow[] {
  return features
    .filter((f) => f.name && f.name.length > 2)
    .map((feature) => {
      const matched = new Set<string>();

      for (const pf of parsedFiles) {
        const rel = pf.path.startsWith(repoAbsPath + "/")
          ? pf.path.slice(repoAbsPath.length + 1)
          : pf.path;
        const filename = rel.split("/").pop() ?? "";
        const fileBase = filename.replace(/\.[^.]+$/, "");

        const matchesDir = feature.directoryPatterns.some((pat) =>
          rel.startsWith(pat.replace(/^\/|\/$/g, "")) ||
          rel.includes("/" + pat.replace(/^\/|\/$/g, "") + "/") ||
          rel.includes(pat.replace(/^\/|\/$/g, "")),
        );

        const matchesFile = feature.filePatterns.some((pat) =>
          fileBase.includes(pat) ||
          rel.replace(/\.[^.]+$/, "").includes(pat),
        );

        if (matchesDir || matchesFile) {
          matched.add(pf.path);
        }
      }

      const files = [...matched];
      const repos = [...new Set(
        files
          .map((f) => parsedFiles.find((pf) => pf.path === f)?.repo ?? "")
          .filter(Boolean),
      )];

      return { name: feature.name, files, repos };
    })
    .filter((sf) => sf.files.length > 0);
}

// ---------------------------------------------------------------------------
// Step 6: Build DISCOVERY.md content
// ---------------------------------------------------------------------------

function buildDiscoveryMarkdown(
  repoName: string,
  hint: RepoTypeHint,
  classification: DirClassification,
  features: DiscoveredFeature[],
  seedFlows: SeedFlow[],
  topology?: WorkspaceTopology,
): string {
  const flowsByName = new Map(seedFlows.map((sf) => [sf.name, sf]));

  const lines: string[] = [
    `# ${repoName} — LLM Discovery`,
    ``,
    `> Generated by claude-opus-4-6. Do not edit manually — re-run indexing to refresh.`,
    ``,
    `## Repository Profile`,
    ``,
    `| Property | Value |`,
    `|----------|-------|`,
    `| Framework | ${classification.framework} |`,
    `| Type | ${classification.repoType} |`,
    `| Language | ${classification.primaryLanguage} |`,
    `| Class | ${classification.repoClass} |`,
    ``,
    `## Directory Classification`,
    ``,
    `| Path | Role | Layer |`,
    `|------|------|-------|`,
    ...classification.directories.map((d) => `| \`${d.path}\` | ${d.role} | ${d.layer} |`),
    ``,
    `## Discovered Business Features`,
    ``,
  ];

  for (const f of features) {
    const flow = flowsByName.get(f.name);
    lines.push(
      `### ${f.name}  _(${f.confidence} confidence, ${flow?.files.length ?? 0} files matched)_`,
      ``,
      f.description,
      ``,
      `**Directory patterns:** ${f.directoryPatterns.join(", ") || "—"}`,
      `**File patterns:** ${f.filePatterns.join(", ") || "—"}`,
      ``,
    );
  }

  if (topology) {
    lines.push(
      `## Workspace Topology`,
      ``,
      `**Architecture:** ${topology.topology} — ${topology.description}`,
      ``,
      `| Repo | Role | Serves | Depends On |`,
      `|------|------|--------|------------|`,
      ...topology.repos.map((r) =>
        `| ${r.name} | ${r.role} | ${r.serves.join(", ") || "—"} | ${r.dependsOn.join(", ") || "—"} |`,
      ),
      ``,
      `**Shared concepts:** ${topology.sharedConcepts.join(", ")}`,
      ``,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse LLM JSON safely
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string, fallback: T): T {
  try {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Main: discoverFeatures (per-repo)
// ---------------------------------------------------------------------------

/**
 * Runs the full LLM-first discovery for a single repo.
 * Returns SeedFlow[] (for flow-detector) and DISCOVERY.md content.
 */
export async function discoverFeatures(
  repoAbsPath: string,
  repoName: string,
  parsedFiles: ParsedFile[],
  discoveryLlm: LLMProvider,
): Promise<DiscoveryResult> {
  const tree = buildDirectoryTree(repoAbsPath);
  const readme = readAllReadmes(repoAbsPath);
  const hint = detectRepoTypeHint(tree, readme, repoAbsPath);
  const fileCounts = computeFileCounts(parsedFiles, repoAbsPath);

  // --- Call 1: Directory classification ---
  // maxTokens: 6000 — mastodon has 80+ dirs; each entry ≈ 60 tokens → ~5000 tokens output
  const call1Prompt = buildDirectoryClassificationPrompt(repoName, tree, readme, hint);
  const call1Raw = await discoveryLlm.generate(call1Prompt, {
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    maxTokens: 6000,
  });
  const classification = parseJson<DirClassification>(call1Raw, {
    framework: hint.likelyFramework,
    repoType: hint.repoClass,
    primaryLanguage: "unknown",
    repoClass: hint.repoClass,
    directories: [],
  });

  console.log(`  [discovery:${repoName}] ${classification.framework} ${classification.repoType}, ${classification.directories.length} dirs classified`);

  // Key-files listing is built AFTER Call 1 using the LLM's own directory classification.
  // This means no hardcoded path patterns — works for Rails, Go, Ruby gems, CLI tools, etc.
  const keyFiles = buildKeyFilesListing(parsedFiles, repoAbsPath, classification.directories);
  console.log(`  [discovery:${repoName}] key-files listing: ${keyFiles.split("\n").filter(Boolean).length} dirs surfaced`);

  // --- Call 2: Feature discovery ---
  // maxTokens: 8000 — mastodon has 30+ features; each ≈ 200 tokens → ~6000 tokens output
  // Also pass the raw tree so Call 2 can enumerate controllers/routes directly.
  const call2Prompt = buildFeatureDiscoveryPrompt(
    repoName,
    JSON.stringify(classification, null, 2),
    readme,
    fileCounts,
    tree,
    keyFiles,
  );
  const call2Raw = await discoveryLlm.generate(call2Prompt, {
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    maxTokens: 8000,
  });
  const featureResult = parseJson<{ features: DiscoveredFeature[] }>(call2Raw, { features: [] });
  const features = featureResult.features ?? [];

  console.log(`  [discovery:${repoName}] ${features.length} business features identified`);
  for (const f of features) {
    console.log(`    - ${f.name} (${f.confidence})`);
  }

  // Match patterns → real file paths
  const seedFlows = matchPatternsToFiles(features, parsedFiles, repoAbsPath);
  console.log(`  [discovery:${repoName}] ${seedFlows.length} features matched files (${seedFlows.reduce((s, f) => s + f.files.length, 0)} total files)`);

  // Compact dir summary for workspace topology prompt
  const dirSummary = classification.directories
    .map((d) => `${d.path}: ${d.role}`)
    .join("\n");

  const mdContent = buildDiscoveryMarkdown(repoName, hint, classification, features, seedFlows);

  return {
    repoName,
    seedFlows,
    mdContent,
    dirSummary,
    framework: classification.framework,
    repoClass: classification.repoClass,
  };
}

// ---------------------------------------------------------------------------
// Workspace topology (cross-repo, runs after all per-repo discoveries)
// ---------------------------------------------------------------------------

/**
 * When 2+ repos are indexed together, detect how they relate to each other.
 * Returns WorkspaceTopology and updates each repo's DISCOVERY.md with topology section.
 */
export async function discoverWorkspaceTopology(
  results: DiscoveryResult[],
  discoveryLlm: LLMProvider,
): Promise<WorkspaceTopology | null> {
  if (results.length < 2) return null;

  const prompt = buildWorkspaceTopologyPrompt(
    results.map((r) => ({
      name: r.repoName,
      repoClass: r.repoClass,
      framework: r.framework,
      dirSummary: r.dirSummary,
    })),
  );

  const raw = await discoveryLlm.generate(prompt, {
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    maxTokens: 1500,
  });

  const topology = parseJson<WorkspaceTopology>(raw, {
    topology: "unknown",
    description: "",
    repos: results.map((r) => ({ name: r.repoName, role: r.repoClass, serves: [], dependsOn: [] })),
    sharedConcepts: [],
  });

  console.log(`  [discovery:workspace] topology=${topology.topology} — ${topology.description}`);
  return topology;
}

/**
 * Merges LLM-discovered seed flows with route-extractor seeds.
 * LLM seeds take priority. Route seeds that don't overlap are appended.
 */
export function mergeSeedFlows(llmSeeds: SeedFlow[], routeSeeds: SeedFlow[]): SeedFlow[] {
  const result = [...llmSeeds];
  const llmNamesLower = new Set(llmSeeds.map((s) => s.name.toLowerCase()));

  for (const rs of routeSeeds) {
    const rsLower = rs.name.toLowerCase();
    // Skip if an LLM seed already covers this (substring match either way)
    const alreadyCovered = [...llmNamesLower].some(
      (n) => n.includes(rsLower.slice(0, 6)) || rsLower.includes(n.slice(0, 6)),
    );
    if (!alreadyCovered) {
      result.push(rs);
    }
  }

  return result;
}
