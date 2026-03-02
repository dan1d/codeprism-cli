/**
 * Prompt builders for project-level documentation generation.
 * Each builder produces a prompt for a specific doc type; the LLM output
 * is stored in the `project_docs` table and injected into card prompts.
 */

import type { BestPractices } from "../skills/types.js";

export type DocType =
  | "readme"
  | "about"
  | "architecture"
  | "code_style"
  | "rules"
  | "styles"
  | "api_contracts"
  | "specialist"
  | "changelog"
  | "memory"
  | "pages"
  | "be_overview"
  | "business"
  | "product"
  | "cross_repo"
  | "discovery";

export const DOC_SYSTEM_PROMPT = `You are a senior software architect documenting a codebase for an AI coding assistant.
Write clear, concise markdown. Focus on what developers need to know to work confidently in this codebase.
Do NOT fabricate details not visible in the provided source. If something is unclear, say so briefly.
Maximum 600 words per document.`;

// ---------------------------------------------------------------------------
// Branch context helper
// ---------------------------------------------------------------------------

export interface BranchContext {
  branch: string;
  /** Semantic class of the branch */
  branchClass: "base" | "environment" | "feature";
  /** Target deployment environment — only set for environment branches */
  targetEnvironment?: "demo" | "staging" | "production" | "release" | "other" | null;
  baseBranch: string;
  changedFiles: string[];
  commitsAhead: number;
  /** Ticket IDs extracted from the branch name (e.g. ["ENG-756"]) */
  ticketIds?: string[];
  /** Optional ticket description injected via --ticket CLI flag */
  ticketDescription?: string;
  /**
   * Cross-repo branch context: other repos in the workspace that are on the
   * same epic/feature branch. Populated by buildWorkspaceBranchSignal().
   */
  crossRepoBranches?: Array<{
    repo: string;
    branch: string;
    changedFiles: string[];
    recentCommits: string[];
  }>;
  /** Repos that are still on their base branch and haven't picked up the epic */
  behindRepos?: string[];
}

/**
 * Builds a markdown block injected into prompts when indexing a non-base branch.
 * The framing is tailored to the branch class:
 *
 *  environment (demo)       → "DEMO ENVIRONMENT: WIP features for demo/orlando"
 *  environment (staging)    → "STAGING ENVIRONMENT: release candidate vs main"
 *  environment (production) → "PRODUCTION ENVIRONMENT: stable deployed state"
 *  feature                  → "FEATURE BRANCH: ticket-driven changes"
 */
export function buildBranchContextBlock(ctx: BranchContext): string {
  const { branch, branchClass, targetEnvironment, baseBranch, changedFiles, commitsAhead, ticketIds = [], ticketDescription } = ctx;

  const fileList = changedFiles.slice(0, 20).map((f) => `- \`${f}\``).join("\n");
  const moreFiles = changedFiles.length > 20
    ? `\n- _…and ${changedFiles.length - 20} more_`
    : "";

  const ticketLine = ticketIds.length > 0
    ? `> **Tickets**: ${ticketIds.map((t) => `\`${t}\``).join(", ")}\n`
    : "";

  const ticketDescSection = ticketDescription
    ? `\n**Ticket context**: ${ticketDescription.slice(0, 400)}\n`
    : "";

  // Build the header line based on branch class
  let header: string;
  let guidance: string;

  if (branchClass === "environment") {
    const envLabel =
      targetEnvironment === "demo"       ? "DEMO ENVIRONMENT" :
      targetEnvironment === "staging"    ? "STAGING ENVIRONMENT" :
      targetEnvironment === "production" ? "PRODUCTION ENVIRONMENT" :
      targetEnvironment === "release"    ? "RELEASE CANDIDATE" :
      "ENVIRONMENT BRANCH";

    const envNote =
      targetEnvironment === "demo"
        ? `This branch may contain WIP features not yet merged to \`${baseBranch}\`. ` +
          `It exists to support a specific demo/client environment.`
        : targetEnvironment === "staging"
        ? `This branch tracks the current release candidate. Changes vs \`${baseBranch}\` ` +
          `represent features awaiting production deployment.`
        : targetEnvironment === "production"
        ? `This branch reflects the live deployed state. Document only what is confirmed stable.`
        : `This branch represents an environment-specific state.`;

    header = `> ⚠️ **${envLabel}** — branch: \`${branch}\` (+${commitsAhead} commits vs \`${baseBranch}\`)`;
    guidance = [
      envNote,
      ``,
      `Focus on files changed vs \`${baseBranch}\` — these represent the delta that defines this environment.`,
      `Do NOT assume the documentation applies to \`${baseBranch}\` — document the state of \`${branch}\`.`,
    ].join("\n");
  } else {
    // feature branch
    const ticketHint = ticketIds.length > 0
      ? `implementing ${ticketIds.join(", ")}`
      : "implementing a feature or fix";

    header = `> 🔀 **FEATURE BRANCH** — \`${branch}\` ${ticketHint} (+${commitsAhead} commits vs \`${baseBranch}\`)`;
    guidance = [
      `This branch is ${ticketHint}. Document patterns visible in the changed files below.`,
      `Note any new routes, models, components, or rules introduced by this branch that differ from \`${baseBranch}\`.`,
    ].join("\n");
  }

  // Cross-repo section: other services on the same branch
  const crossRepoSection = buildCrossRepoSection(ctx);

  if (!changedFiles.length && commitsAhead === 0) {
    return [header, ` — no changes detected vs \`${baseBranch}\``, `\n`, crossRepoSection].join("");
  }

  return [
    header,
    `>`,
    ticketLine,
    `> **Changed files vs \`${baseBranch}\`** (${changedFiles.length} total):`,
    `>`,
    `> ${fileList.replace(/\n/g, "\n> ")}${moreFiles}`,
    ``,
    guidance,
    ticketDescSection,
    crossRepoSection,
    ``,
  ].join("\n");
}

/**
 * Builds a cross-repo awareness section showing which other services are on
 * the same epic branch. Injected after the per-repo branch context so the LLM
 * understands the full scope of the change across the workspace.
 */
function buildCrossRepoSection(ctx: BranchContext): string {
  const { crossRepoBranches, behindRepos = [] } = ctx;
  if (!crossRepoBranches?.length && !behindRepos.length) return "";

  const lines: string[] = ["### Cross-repo branch status", ""];

  if (crossRepoBranches?.length) {
    lines.push(`The following sibling services are **also on \`${ctx.branch}\`**:`);
    lines.push("");
    for (const sibling of crossRepoBranches) {
      lines.push(`**\`${sibling.repo}\`** — ${sibling.changedFiles.length} changed files`);
      if (sibling.changedFiles.length > 0) {
        lines.push(...sibling.changedFiles.slice(0, 8).map((f) => `  - \`${f}\``));
        if (sibling.changedFiles.length > 8) {
          lines.push(`  - _…and ${sibling.changedFiles.length - 8} more_`);
        }
      }
      if (sibling.recentCommits.length > 0) {
        lines.push(`  Recent commits:`);
        lines.push(...sibling.recentCommits.slice(0, 3).map((c) => `  - ${c}`));
      }
      lines.push("");
    }
  }

  if (behindRepos.length) {
    lines.push(`The following services are **not yet on this branch** (still on their base branch):`);
    lines.push(...behindRepos.map((r) => `- \`${r}\``));
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

interface SourceFile {
  path: string;
  content: string;
}

function fenceBlock(file: SourceFile): string {
  const ext = file.path.split(".").at(-1) ?? "text";
  const langMap: Record<string, string> = {
    rb: "ruby", js: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", vue: "vue",
    json: "json", yml: "yaml", yaml: "yaml", css: "css", scss: "scss",
    md: "markdown", gemfile: "ruby",
  };
  const lang = langMap[ext.toLowerCase()] ?? ext;
  const short = file.path.split("/").slice(-3).join("/");
  return `### \`${short}\`\n\`\`\`${lang}\n${file.content}\n\`\`\``;
}

function sourceSection(files: SourceFile[]): string {
  return files
    .filter((f) => f.content.trim())
    .map(fenceBlock)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

export function buildReadmePrompt(repoName: string, files: SourceFile[], branchContext?: BranchContext): string {
  const branchBlock = branchContext ? buildBranchContextBlock(branchContext) : "";
  return `Generate a **README.md** for the \`${repoName}\` repository.

${branchBlock}## Source Files

${sourceSection(files)}

## Task

Write a concise README covering:
1. **What this project is** — one-paragraph description
2. **Tech stack** — language, framework, key libraries (infer from package manager files)
3. **Project structure** — top-level directories and their purpose
4. **Setup** — how to install dependencies and run locally (infer from scripts/Makefile)
5. **Key entry points** — where execution starts

Start with a # heading with the project name. Be factual; do not invent steps not visible in the code.`;
}

// ---------------------------------------------------------------------------
// ABOUT
// ---------------------------------------------------------------------------

export function buildAboutPrompt(repoName: string, files: SourceFile[], branchContext?: BranchContext): string {
  const branchBlock = branchContext ? buildBranchContextBlock(branchContext) : "";
  return `Generate an **About.md** for the \`${repoName}\` repository — a business-focused description for AI coding assistants.

${branchBlock}## Source Files

${sourceSection(files)}

## Task

Write a concise About document covering:
1. **Business domain** — what real-world problem does this application solve?
2. **Users and actors** — who uses this system and in what roles?
3. **Core entities** — the 3-5 most important domain concepts (e.g. Patient, Cycle, PreAuthorization)
4. **Key workflows** — the 2-3 most critical user journeys or business processes
5. **Boundaries** — what this service is responsible for vs. what other services handle

This document will be injected into AI prompts to give context about the business domain.`;
}

// ---------------------------------------------------------------------------
// ARCHITECTURE
// ---------------------------------------------------------------------------

export function buildArchitecturePrompt(repoName: string, files: SourceFile[], branchContext?: BranchContext): string {
  const branchBlock = branchContext ? buildBranchContextBlock(branchContext) : "";
  return `Generate an **Architecture.md** for the \`${repoName}\` repository.

${branchBlock}## Source Files

${sourceSection(files)}

## Task

Write a concise architecture document covering:
1. **Architectural pattern** — MVC, REST API, SPA, microservice, monolith, etc.
2. **Layer breakdown** — how the codebase is organized (controllers, models, services, jobs, etc.)
3. **Data flow** — how a typical request travels through the system
4. **Key design decisions** — notable patterns, abstractions, or conventions used
5. **External integrations** — third-party APIs, background job systems, databases visible in the code
6. **Cross-service contracts** — if this is an API, what are the main endpoints or data formats?

Be specific about what is visible in the provided code. Do not speculate.`;
}

// ---------------------------------------------------------------------------
// CODE STYLE
// ---------------------------------------------------------------------------

export function buildCodeStylePrompt(repoName: string, files: SourceFile[], frameworkBaseline?: string, branchContext?: BranchContext): string {
  const baselineSection = frameworkBaseline
    ? `## Framework Baseline\n\nThe following conventions are standard for this tech stack. Extend, override, or note exceptions based on what you observe in the project:\n\n${frameworkBaseline}\n\n`
    : "";
  const branchBlock = branchContext ? buildBranchContextBlock(branchContext) : "";

  return `Generate a **CodeStyle.md** for the \`${repoName}\` repository — coding conventions for AI assistants.

${branchBlock}${baselineSection}## Source Files

${sourceSection(files)}

## Task

Document the coding conventions visible in the source:
1. **Naming conventions** — files, classes, methods, variables (snake_case, camelCase, etc.)
2. **Code organization** — how code is split into files and modules
3. **Common patterns** — dependency injection, service objects, hooks, stores, concerns, etc.
4. **Error handling** — how errors are caught and surfaced
5. **Testing patterns** — test file naming, factory/fixture usage (if visible)
6. **Do's and Don'ts** — anything the codebase clearly enforces or avoids

Note which framework baseline conventions are confirmed, extended, or overridden by the actual project patterns. This will guide AI code generation to match the existing style.`;
}

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

export function buildRulesPrompt(repoName: string, files: SourceFile[], frameworkBaseline?: string, branchContext?: BranchContext): string {
  const baselineSection = frameworkBaseline
    ? `## Framework Baseline\n\nThe following rules are standard for this tech stack. Note which are confirmed, extended, or overridden by the project's actual patterns:\n\n${frameworkBaseline}\n\n`
    : "";
  const branchBlock = branchContext ? buildBranchContextBlock(branchContext) : "";

  return `Generate a **Rules.md** for the \`${repoName}\` repository — business rules and domain constraints.

${branchBlock}

${baselineSection}## Source Files

${sourceSection(files)}

## Task

Document the business rules and domain constraints visible in the code:
1. **Validation rules** — data constraints enforced at the model or API level
2. **Authorization rules** — who can do what (policies, scopes, guards)
3. **Business logic constraints** — state machines, conditional flows, invariants
4. **Domain-specific rules** — any healthcare, billing, compliance, or domain rules visible
5. **Gotchas** — non-obvious rules that would surprise a new developer
6. **Framework alignment** — note which baseline security and authorization rules are confirmed by the project's actual patterns, and flag any project-specific overrides or gaps.

Be specific and reference the actual field names and models you see in the code.`;
}

// ---------------------------------------------------------------------------
// STYLES (frontend only)
// ---------------------------------------------------------------------------

export function buildStylesPrompt(repoName: string, files: SourceFile[]): string {
  return `Generate a **Styles.md** for the \`${repoName}\` frontend repository — UI and styling conventions.

## Source Files

${sourceSection(files)}

## Task

Document the UI and styling conventions:
1. **CSS approach** — CSS modules, styled-components, Tailwind, SCSS, global styles, etc.
2. **Design tokens** — colors, typography, spacing variables if defined
3. **Component conventions** — how UI components are structured
4. **Naming conventions** — BEM, utility classes, component-scoped styles
5. **Theme** — any dark/light mode or theming system

If no CSS files are provided, note that styling information was not available.`;
}

// ---------------------------------------------------------------------------
// PAGES (frontend only) — LLM-discovered page/view inventory
// ---------------------------------------------------------------------------

export function buildPagesPrompt(repoName: string, files: SourceFile[]): string {
  return `Analyze the navigation and page components of the \`${repoName}\` frontend repository.

## Source Files

${sourceSection(files)}

## Task

Produce a **Pages.md** document that catalogues every distinct user-facing page or view in this application.

Rules:
- A **page** is a route-level view a user navigates to (e.g. "Remote Authorizations", "Patient Profile").
- A **section header** is a nav group that contains child pages (e.g. "Admin", "Settings" when they have sub-items) — do NOT list these as pages.
- Infer page names from nav \`title\` attributes, component directory names, and route definitions.
- For each page write exactly one sentence describing what the user does there.

Output format — use this exact markdown structure so it can be machine-parsed:

## Pages

- **<Page Name>** — <one sentence describing what the user does on this page>
- **<Page Name>** — <one sentence>
...

List every leaf page you can identify. Do not include section headers, utility components, or modal-only views.`;
}

// ---------------------------------------------------------------------------
// BE_OVERVIEW — LLM-generated backend API summary
// ---------------------------------------------------------------------------

export function buildBeOverviewPrompt(
  repoName: string,
  files: SourceFile[],
  fePagesContext = "",
  branchContext?: BranchContext,
): string {
  const feSection = fePagesContext
    ? `## What the Frontend Expects\n\nThe following pages/journeys have been discovered in the frontend. ` +
      `Describe BE routes in terms of which FE pages they serve:\n\n${fePagesContext.slice(0, 600)}\n\n`
    : "";
  const branchBlock = branchContext ? buildBranchContextBlock(branchContext) : "";

  return `Analyze the backend routes and controllers of the \`${repoName}\` repository.

${branchBlock}${feSection}

## Source Files

${sourceSection(files)}

## Task

Produce a **BackendOverview.md** that gives a developer an instant understanding of what this API does.

Cover:
1. **Purpose** — one paragraph: what real-world problem does this API solve?
2. **Main Resources** — bullet list of the 5-10 core domain resources (e.g. Patient, Authorization, Device) with one-line descriptions
3. **Key Endpoint Groups** — for each resource, list 2-4 of the most important routes (method + path + purpose)
4. **Authentication** — how clients authenticate (token, session, API key, etc.)
5. **Notable Patterns** — any cross-cutting concerns visible in the routes (versioning, namespacing, nested resources)

Be specific to what is visible in the provided files. Maximum 600 words.`;
}

// ---------------------------------------------------------------------------
// BUSINESS — operational context for the codebase
// ---------------------------------------------------------------------------

export function buildBusinessPrompt(
  repoName: string,
  files: SourceFile[],
  readmeSeed = "",
): string {
  const seedSection = readmeSeed
    ? `## Prior Context from README\n\n${readmeSeed.slice(0, 600)}\n\n`
    : "";

  return `Generate a **Business.md** for the \`${repoName}\` repository — operational context for AI coding assistants.

${seedSection}## Source Files

${sourceSection(files)}

## Task

Document the operational and business context visible in the code:
1. **Stakeholders** — who owns and depends on this system (infer from model names, policy classes, job names)
2. **Critical workflows** — the 2–4 most business-critical processes (billing, auth, patient management, etc.)
3. **Business invariants** — rules that must never be violated (e.g. "an authorization must exist before dispensing")
4. **Compliance signals** — any HIPAA, PCI, or regulatory patterns visible in the code
5. **Failure impact** — what breaks for end users if this service goes down

This document gives AI assistants the business context they need to avoid changes that are technically correct but operationally dangerous.`;
}

// ---------------------------------------------------------------------------
// PRODUCT — FE user journeys (FE repos only)
// ---------------------------------------------------------------------------

export function buildProductPrompt(
  repoName: string,
  files: SourceFile[],
  readmeSeed = "",
  pagesDoc = "",
): string {
  const seedSection = readmeSeed
    ? `## Prior Context from README\n\n${readmeSeed.slice(0, 400)}\n\n`
    : "";
  const pagesSection = pagesDoc
    ? `## Discovered Pages\n\n${pagesDoc.slice(0, 800)}\n\n`
    : "";

  return `Generate a **Product.md** for the \`${repoName}\` frontend repository — user journey documentation for AI coding assistants.

${seedSection}${pagesSection}## Source Files

${sourceSection(files)}

## Task

Document the product experience visible in the router, navigation, and active page components:
1. **Core user journeys** — the 3–5 most important end-to-end flows a user completes (e.g. "Submit pre-authorization", "Onboard a new patient")
2. **Page inventory** — key pages and what user action each enables
3. **Navigation model** — how users move between sections (sidebar, tabs, wizards)
4. **Key interactions** — forms, wizards, data tables that drive the primary value of the product
5. **Frontend constraints** — patterns the UI enforces (required fields, step-gating, permission-gated sections)

Focus on what the user does and why — not how the code works internally.
Do NOT reference Cypress, Storybook, or test infrastructure.`;
}

// ---------------------------------------------------------------------------
// CROSS_REPO — workspace-level FE→BE mapping
// ---------------------------------------------------------------------------

export function buildCrossRepoPrompt(
  workspaceName: string,
  fePagesDoc: string,
  feProductDoc: string,
  beApiContractsDoc: string,
): string {
  return `Generate a **CrossRepo.md** workspace document that maps FE user journeys to BE API endpoints.

## FE Pages
${fePagesDoc.slice(0, 800)}

## FE Product Journeys
${feProductDoc.slice(0, 600)}

## BE API Contracts
${beApiContractsDoc.slice(0, 1000)}

## Task

Produce a cross-service mapping for AI coding assistants:
1. **Journey → Endpoint map** — for each major FE user journey, list the BE endpoints it calls (method + path)
2. **Shared contracts** — data shapes passed between FE and BE (request/response schemas)
3. **Auth boundary** — how authentication tokens flow from FE to BE
4. **Known gaps** — FE pages that reference endpoints not visible in the BE contracts doc
5. **Cross-repo change risk** — which FE journeys would break if a specific BE endpoint changed

Keep this factual; do not speculate about endpoints not visible in the provided docs.`;
}

// ---------------------------------------------------------------------------
// Refresh prompt (used by POST /api/refresh for incremental updates)
// ---------------------------------------------------------------------------

export function buildRefreshDocPrompt(
  docType: DocType,
  repoName: string,
  files: SourceFile[],
  frameworkBaseline?: string,
): string {
  switch (docType) {
    case "readme":       return buildReadmePrompt(repoName, files);
    case "about":        return buildAboutPrompt(repoName, files);
    case "architecture": return buildArchitecturePrompt(repoName, files);
    case "code_style":   return buildCodeStylePrompt(repoName, files, frameworkBaseline);
    case "rules":        return buildRulesPrompt(repoName, files, frameworkBaseline);
    case "styles":       return buildStylesPrompt(repoName, files);
    case "pages":        return buildPagesPrompt(repoName, files);
    case "be_overview":  return buildBeOverviewPrompt(repoName, files);
    case "business":     return buildBusinessPrompt(repoName, files);
    case "product":      return buildProductPrompt(repoName, files);
    case "specialist":
    case "api_contracts":
    case "changelog":
    case "memory":
    case "cross_repo":
      // These doc types require special generation logic (generateSpecialistDoc, git log,
      // cross-repo context, etc.). The refresh endpoint cannot handle them generically —
      // throw so the caller skips and logs the error.
      throw new Error(`Doc type "${docType}" cannot be refreshed via buildRefreshDocPrompt`);
    default:             return buildReadmePrompt(repoName, files);
  }
}

// ---------------------------------------------------------------------------
// Specialist prompt — repo-specific AI persona, generated last (after all docs)
// ---------------------------------------------------------------------------

export function buildSpecialistPrompt(
  repoName: string,
  stackLabel: string,
  aboutDoc: string,
  archDoc: string,
  rulesDoc: string,
  frameworkBestPractices?: string,
): string {
  const frameworkSection = frameworkBestPractices
    ? `\n## Framework Expertise (${stackLabel})\n${frameworkBestPractices}\n`
    : "";

  return `You are creating a Specialist Identity Card for an AI coding assistant.
This card will be prepended to EVERY prompt that operates on the "${repoName}" repository.
It must be accurate, specific, and immediately useful. Maximum 400 words.

Stack: ${stackLabel}

## Project About
${aboutDoc.slice(0, 1200)}

## Architecture
${archDoc.slice(0, 800)}

## Business Rules (excerpt)
${rulesDoc.slice(0, 600)}
${frameworkSection}
Generate a specialist card with these exact sections:
1. **Domain** — 2 sentences: what the system does and who uses it
2. **Core Entities** — bullet list of the 5–8 most important models/services/components with one-line descriptions
3. **Key Patterns** — bullet list of 3–5 architectural patterns and conventions specific to this codebase
4. **Gotchas** — bullet list of 2–4 non-obvious constraints, edge cases, or traps
5. **Agent Directives** — 3–5 "When answering questions about this codebase, always..." directives`;
}

// ---------------------------------------------------------------------------
// API Contracts prompt — documents the public API surface of a backend repo
// ---------------------------------------------------------------------------

export function buildApiContractsPrompt(repoName: string, files: SourceFile[]): string {
  const fileBlocks = files.map((f) => fenceBlock(f)).join("\n\n");
  return `Repository: ${repoName}

${fileBlocks}

---

Document the public API surface of this repository. Maximum 500 words. Cover:
1. **Base URL / namespace** — the route prefix
2. **Key endpoints** — list each route with method, path, brief purpose, and authentication requirement
3. **Request/response conventions** — format (JSON/XML), common headers, pagination
4. **Authentication** — how clients authenticate (Bearer token, session cookie, API key)
5. **Notable constraints** — rate limits, required params, error formats`;
}

// ---------------------------------------------------------------------------
// Changelog prompt — recent notable changes, updated on each merge event
// ---------------------------------------------------------------------------

export function buildChangelogPrompt(
  repoName: string,
  commitMessages: string[],
): string {
  const commits = commitMessages.slice(0, 30).join("\n");
  return `Repository: ${repoName}

Recent commit messages (newest first):
${commits}

---

Write a concise changelog summary (max 300 words) of the most significant recent changes to this codebase.
Group by theme (e.g. "New Features", "Bug Fixes", "Schema Changes", "API Changes").
Only include changes that are meaningful to a developer reading code — skip chores, dependency bumps, and typo fixes.`;
}

// ---------------------------------------------------------------------------
// Memory prompt — rolling log of team insights and usage patterns (OpenClaw MEMORY.md)
// ---------------------------------------------------------------------------

export interface MemoryInput {
  recentInsights: Array<{ title: string; flow: string; content: string; created_at: string }>;
  topFlows: Array<{ flow: string; queryCount: number }>;
}

export function buildMemoryDocPrompt(input: MemoryInput): string {
  const insightLines = input.recentInsights
    .slice(0, 10)
    .map((i) => `- [${i.created_at.slice(0, 10)}] **${i.title}** (flow: ${i.flow})\n  ${i.content.slice(0, 200)}`)
    .join("\n");

  const flowLines = input.topFlows
    .slice(0, 10)
    .map((f) => `- ${f.flow}: ${f.queryCount} queries`)
    .join("\n");

  return `You are summarising a team's recent development knowledge for an AI coding assistant.
Write a MEMORY document (max 500 words) that captures:

1. **Recent Insights** — key architectural decisions and gotchas discovered recently
2. **Active Areas** — flows being queried most (indicating where the team is currently working)
3. **Patterns Emerging** — any recurring themes across the insights
4. **Watch Out For** — any gotchas or warnings to keep top of mind

## Recent Dev Insights
${insightLines || "(none yet)"}

## Most-Queried Flows (last 30 days)
${flowLines || "(no query data yet)"}`;
}

// ---------------------------------------------------------------------------
// Framework baseline — formats skill bestPractices for injection into prompts
// ---------------------------------------------------------------------------

/** @deprecated — use BestPractices from skills/types.ts directly. Kept for backward compat. */
export type { BestPractices as FrameworkBestPractices };

/**
 * Formats a skill's bestPractices into a compact markdown string suitable
 * for injection into code_style and rules doc prompts.
 * Multiple skills are merged and de-duplicated. Each section is capped at 8
 * bullets to prevent bloat when 3+ framework stacks are combined.
 */
export function buildFrameworkBaseline(
  practicesList: BestPractices[],
  options: { includeTesting?: boolean; includePerformance?: boolean } = {},
): string {
  if (practicesList.length === 0) return "";

  const { includeTesting = false, includePerformance = false } = options;

  const merge = (key: keyof BestPractices): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of practicesList) {
      for (const item of p[key]) {
        if (!seen.has(item)) {
          seen.add(item);
          result.push(item);
        }
      }
    }
    return result;
  };

  const sections: string[] = [];

  const arch = merge("architecture").slice(0, 8);
  if (arch.length > 0) sections.push(`**Architecture**\n${arch.map((s) => `- ${s}`).join("\n")}`);

  const style = merge("codeStyle").slice(0, 8);
  if (style.length > 0) sections.push(`**Code Style**\n${style.map((s) => `- ${s}`).join("\n")}`);

  const security = merge("security").slice(0, 8);
  if (security.length > 0) sections.push(`**Security**\n${security.map((s) => `- ${s}`).join("\n")}`);

  const antiPatterns = merge("antiPatterns").slice(0, 8);
  if (antiPatterns.length > 0) sections.push(`**Anti-Patterns**\n${antiPatterns.map((s) => `- ${s}`).join("\n")}`);

  if (includeTesting) {
    const testing = merge("testing").slice(0, 8);
    if (testing.length > 0) sections.push(`**Testing**\n${testing.map((s) => `- ${s}`).join("\n")}`);
  }

  if (includePerformance) {
    const perf = merge("performance").slice(0, 8);
    if (perf.length > 0) sections.push(`**Performance**\n${perf.map((s) => `- ${s}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Returns only the Architecture section of the framework baseline.
 * Designed for the specialist prompt where token budget is tighter
 * and architectural personality is more useful than style/security details.
 */
export function buildFrameworkArchitectureOnly(practicesList: BestPractices[]): string {
  if (practicesList.length === 0) return "";

  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const p of practicesList) {
    for (const item of p.architecture) {
      if (!seen.has(item)) {
        seen.add(item);
        bullets.push(item);
      }
    }
  }
  const capped = bullets.slice(0, 10);
  if (capped.length === 0) return "";
  return `**Architecture**\n${capped.map((s) => `- ${s}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// LLM-First Discovery prompts (claude-opus — called before flow detection)
// ---------------------------------------------------------------------------

export const DISCOVERY_SYSTEM_PROMPT = `You are a senior software architect performing codebase discovery.
Your job is to identify the real business features of an application — not code clusters or file groups.
Return ONLY valid JSON. No markdown fences, no explanation, no preamble.
Be specific. Name features as a product manager would name them.`;

/**
 * Call 1: Classify the directory structure and identify the repo type.
 * Input: full directory tree + all READMEs found.
 * Output: JSON with framework, repoType, primaryLanguage, and directory roles.
 */
export function buildDirectoryClassificationPrompt(
  repoName: string,
  tree: string,
  readme: string,
  repoTypeHint: { repoClass: string; likelyFramework: string; signals: string[] },
): string {
  return `Repository: ${repoName}
Pre-detection signals: ${repoTypeHint.repoClass} / ${repoTypeHint.likelyFramework}
${repoTypeHint.signals.length > 0 ? `Evidence: ${repoTypeHint.signals.join(", ")}` : ""}

DIRECTORY TREE (full):
${tree}

README CONTENT (all found):
${readme || "(no README found)"}

Classify every meaningful directory and identify the overall repo type.

Return JSON exactly like this:
{
  "framework": "Rails",
  "repoType": "backend API",
  "primaryLanguage": "Ruby",
  "repoClass": "backend",
  "directories": [
    { "path": "app/models", "role": "ActiveRecord domain models", "layer": "data" },
    { "path": "app/controllers", "role": "HTTP request handlers", "layer": "web" },
    { "path": "app/workers", "role": "Background jobs (Sidekiq)", "layer": "async" },
    { "path": "app/services", "role": "Business logic services", "layer": "domain" },
    { "path": "app/mailers", "role": "Email templates and delivery", "layer": "notifications" },
    { "path": "app/serializers", "role": "API response formatting", "layer": "presentation" }
  ]
}

Layers can be: data, web, async, domain, notifications, presentation, frontend, config, infra, test.
Include ALL directories that exist in the tree above — do not omit any.`;
}

/**
 * Call 2: Discover the real business features from the classified structure.
 * Input: dir classification JSON + file counts + README + raw tree + key files.
 * Output: JSON array of real business features with directory/file patterns.
 */
export function buildFeatureDiscoveryPrompt(
  repoName: string,
  dirClassificationJson: string,
  readme: string,
  fileCounts: Record<string, number>,
  tree?: string,
  keyFiles?: string,
): string {
  const countLines = Object.entries(fileCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([dir, n]) => `  ${dir}: ${n} files`)
    .join("\n");

  const treeSection = tree
    ? `\nDIRECTORY TREE (raw — enumerate every controller/service/worker folder):\n${tree}\n`
    : "";

  // KEY FILES is the most critical input: single-file controllers (e.g. bookmarks_controller)
  // won't appear as directories in the tree — this listing exposes them directly.
  const keyFilesSection = keyFiles
    ? `\nKEY FILES BY DIRECTORY (every controller, model, service, worker file):\n${keyFiles}\n`
    : "";

  return `Repository: ${repoName}

DIRECTORY CLASSIFICATION (from Call 1):
${dirClassificationJson}
${treeSection}${keyFilesSection}
FILE COUNTS BY DIRECTORY (all):
${countLines}

README (full):
${readme || "(no README)"}

Identify EVERY real business feature of this application — list as many as exist.
Think like a product manager reading the codebase.

GOOD feature names (specific, user-facing or business-critical):
  "ActivityPub Federation", "Status Timeline", "Account Management",
  "Bookmarks API", "Favourites", "Push Notifications", "OAuth Authentication",
  "Media Attachments", "Search", "Admin Dashboard", "Email Notifications"

BAD feature names (file-level names, framework noise, migrations):
  "verified_badge", "collection_serializer", "maintenance", "base", "utils",
  "Backfill Admin Action Logs Again", "Tags", "Display Name", "REST Serializer"

Rules:
- KEY FILES above lists every controller/model/service — create one feature per resource file group
- For Rails: bookmarks_controller → "Bookmarks API"; statuses_controller → "Statuses API" etc.
- For Rails: each background worker namespace group = one feature
- Do NOT name features after single migration files or tiny utility classes
- Do NOT include routing/middleware/config boilerplate
- DO include every major model-driven subsystem (Accounts, Statuses, Media, etc.)
- DO include auth/session/OAuth subsystems
- DO include admin and moderation features if present
- filePatterns should be the resource word (e.g. "bookmark", "favourite", "status")
- Confidence: "high" = README confirms it; "medium" = directory name implies it; "low" = inferred

Return JSON exactly like this (no markdown, no explanation):
{
  "features": [
    {
      "name": "ActivityPub Federation",
      "description": "Implements the W3C ActivityPub protocol for federated social networking. Handles incoming/outgoing activities, follow relationships, and remote actor resolution across federated instances.",
      "directoryPatterns": ["app/lib/activitypub", "app/workers/activitypub"],
      "filePatterns": ["activitypub", "activity_pub", "federation"],
      "confidence": "high"
    },
    {
      "name": "Bookmarks",
      "description": "Allows users to bookmark statuses for later reference. REST API resource under /api/v1/bookmarks.",
      "directoryPatterns": ["app/controllers/api/v1"],
      "filePatterns": ["bookmark"],
      "confidence": "high"
    }
  ]
}`;
}

/**
 * Workspace-level cross-repo topology prompt.
 * Sent once when multiple repos are indexed together.
 * Identifies: monolith vs API+FE vs microservices, and maps repo responsibilities.
 */
export function buildWorkspaceTopologyPrompt(
  repos: Array<{ name: string; repoClass: string; framework: string; dirSummary: string }>,
): string {
  const repoBlocks = repos.map((r) =>
    `### ${r.name} (${r.framework}, ${r.repoClass})\n${r.dirSummary}`,
  ).join("\n\n");

  return `You are analyzing a multi-repo workspace with ${repos.length} repositories.

${repoBlocks}

Identify the overall system architecture and how the repos relate to each other.

Return JSON exactly like this:
{
  "topology": "api_plus_frontend",
  "description": "Rails API backend consumed by a React SPA frontend",
  "repos": [
    {
      "name": "biobridge-backend",
      "role": "REST API server",
      "serves": ["biobridge-frontend"],
      "dependsOn": []
    },
    {
      "name": "biobridge-frontend",
      "role": "React SPA",
      "serves": [],
      "dependsOn": ["biobridge-backend"]
    }
  ],
  "sharedConcepts": ["User authentication", "Patient records", "Lab results"]
}

topology must be one of: "monolith", "api_plus_frontend", "microservices", "library", "fullstack_monorepo", "unknown"`;
}
