/**
 * codeprism install-rules
 *
 * Writes editor rule files that tell AI assistants to always consult the
 * codeprism knowledge base before starting any task.
 *
 * Supported editors:
 *   cursor     — .cursor/rules/codeprism.mdc     (alwaysApply: true)
 *   claude     — CLAUDE.md                       (appended section)
 *   windsurf   — .windsurfrules                  (appended section)
 *   zed        — .zed/rules/codeprism.md         (new file)
 *
 * Usage:
 *   codeprism install-rules
 *   codeprism install-rules --editor cursor
 *   codeprism install-rules --all
 */

/* eslint-disable no-console */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Editor detection ───────────────────────────────────────────────────────

type EditorId = "cursor" | "claude" | "windsurf" | "zed";

interface EditorInfo {
  id: EditorId;
  name: string;
  /** File/dir that signals this editor is in use here */
  detectionPath: string;
}

const EDITORS: EditorInfo[] = [
  { id: "cursor",   name: "Cursor",   detectionPath: ".cursor" },
  { id: "claude",   name: "Claude Code", detectionPath: "CLAUDE.md" },
  { id: "windsurf", name: "Windsurf", detectionPath: ".windsurfrules" },
  { id: "zed",      name: "Zed",      detectionPath: ".zed" },
];

function detectEditors(cwd: string): EditorId[] {
  return EDITORS
    .filter((e) => existsSync(join(cwd, e.detectionPath)))
    .map((e) => e.id);
}

// ── Rule content ───────────────────────────────────────────────────────────

const CURSOR_MDC = `\
---
description: Always consult the codeprism knowledge base before starting any coding task
globs:
alwaysApply: true
---

# codeprism Context Rule

## When starting ANY coding task, ticket, or feature request:

1. **ALWAYS call \`codeprism_context\` first** with the task description to retrieve
   architectural knowledge cards about the relevant area of the codebase.

2. **Use \`codeprism_search\`** for follow-up queries during implementation
   (e.g. "how does billing work", "patient model associations").

3. **After any non-obvious discovery** (a pattern, business rule, gotcha, or
   architectural decision), **call \`codeprism_save_insight\` proactively** —
   do NOT wait to be asked. Every saved insight makes every developer's AI
   session smarter going forward.

4. **Call \`codeprism_list_flows\`** to see what the team has already documented
   before diving into implementation.

5. **Call \`codeprism_recent_queries\`** to see what teammates have already looked
   up — avoid re-asking questions your colleagues have already answered.

## Tool reference

| Tool | Parameters |
|------|-----------|
| \`codeprism_context\`      | \`{ query: "full task description", flow?: "billing" }\` |
| \`codeprism_search\`       | \`{ query: "search term" }\` |
| \`codeprism_save_insight\`  | \`{ flow: "auth", title: "...", content: "...", files?: [...] }\` |
| \`codeprism_list_flows\`    | _(no parameters)_ |
| \`codeprism_verify_card\`   | \`{ cardId: "..." }\` — after confirming a card is accurate |
| \`codeprism_recent_queries\`| _(no parameters)_ |

## Why

codeprism indexes the entire codebase into architectural knowledge cards —
model associations, API flows, cross-service interactions, business rules.
Using it saves tokens and avoids re-discovering what teammates already know.
`;

const CLAUDE_MD_SECTION = `
## codeprism (team knowledge base)

Always call \`codeprism_context\` at the start of every task with the full description.
Use \`codeprism_search\` for follow-up queries during implementation.
After discovering a non-obvious pattern, architectural decision, or business rule,
call \`codeprism_save_insight\` proactively — do NOT wait to be asked.
Call \`codeprism_list_flows\` to see what the team has already documented.
`;

const WINDSURF_SECTION = `
# codeprism

Always call \`codeprism_context\` at the start of every task.
Use \`codeprism_search\` for follow-up queries during implementation.
After any non-obvious discovery, call \`codeprism_save_insight\` to share it with the team.
Call \`codeprism_list_flows\` to see what the team has already documented.
`;

const ZED_MD = `\
# codeprism Context Rule

Always call \`codeprism_context\` at the start of every task with the full description.
Use \`codeprism_search\` for follow-up queries.
After any non-obvious discovery, call \`codeprism_save_insight\` proactively.
`;

// ── Writers ────────────────────────────────────────────────────────────────

const CODEPRISM_MARKER = "codeprism";

function isAlreadyInstalled(content: string): boolean {
  return content.toLowerCase().includes(CODEPRISM_MARKER);
}

function installCursor(cwd: string): void {
  const rulesDir = join(cwd, ".cursor", "rules");
  const filePath = join(rulesDir, "codeprism.mdc");

  if (existsSync(filePath)) {
    console.log(`  ✓ Cursor — already installed at ${filePath}`);
    return;
  }

  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(filePath, CURSOR_MDC, "utf-8");
  console.log(`  ✓ Cursor — written to ${filePath}`);
}

function installClaude(cwd: string): void {
  const filePath = join(cwd, "CLAUDE.md");

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    if (isAlreadyInstalled(existing)) {
      console.log(`  ✓ Claude Code — already installed in ${filePath}`);
      return;
    }
    writeFileSync(filePath, existing.trimEnd() + "\n" + CLAUDE_MD_SECTION, "utf-8");
    console.log(`  ✓ Claude Code — section appended to ${filePath}`);
  } else {
    writeFileSync(filePath, `# Project Notes\n${CLAUDE_MD_SECTION}`, "utf-8");
    console.log(`  ✓ Claude Code — created ${filePath}`);
  }
}

function installWindsurf(cwd: string): void {
  const filePath = join(cwd, ".windsurfrules");

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    if (isAlreadyInstalled(existing)) {
      console.log(`  ✓ Windsurf — already installed in ${filePath}`);
      return;
    }
    writeFileSync(filePath, existing.trimEnd() + "\n" + WINDSURF_SECTION, "utf-8");
    console.log(`  ✓ Windsurf — section appended to ${filePath}`);
  } else {
    writeFileSync(filePath, WINDSURF_SECTION.trimStart(), "utf-8");
    console.log(`  ✓ Windsurf — created ${filePath}`);
  }
}

function installZed(cwd: string): void {
  const rulesDir = join(cwd, ".zed", "rules");
  const filePath = join(rulesDir, "codeprism.md");

  if (existsSync(filePath)) {
    console.log(`  ✓ Zed — already installed at ${filePath}`);
    return;
  }

  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(filePath, ZED_MD, "utf-8");
  console.log(`  ✓ Zed — written to ${filePath}`);
}

// ── Main entry ─────────────────────────────────────────────────────────────

export interface InstallRulesOptions {
  editor?: string;
  all?: boolean;
}

export async function installRules(cwd: string, opts: InstallRulesOptions): Promise<void> {
  console.log("\n📋  Installing codeprism AI rules\n");

  let targets: EditorId[];

  if (opts.editor) {
    const valid: EditorId[] = ["cursor", "claude", "windsurf", "zed"];
    const requested = opts.editor.toLowerCase() as EditorId;
    if (!valid.includes(requested)) {
      console.error(`❌  Unknown editor "${opts.editor}". Choose: ${valid.join(", ")}`);
      process.exit(1);
    }
    targets = [requested];
  } else if (opts.all) {
    targets = ["cursor", "claude", "windsurf", "zed"];
  } else {
    // Auto-detect
    targets = detectEditors(cwd);
    if (targets.length === 0) {
      // No editor config files found — install Cursor + Claude as sensible defaults
      console.log("  No editor config files detected — installing Cursor + Claude Code rules.\n");
      targets = ["cursor", "claude"];
    } else {
      const names = targets.map((id) => EDITORS.find((e) => e.id === id)!.name).join(", ");
      console.log(`  Detected: ${names}\n`);
    }
  }

  for (const id of targets) {
    switch (id) {
      case "cursor":   installCursor(cwd);   break;
      case "claude":   installClaude(cwd);   break;
      case "windsurf": installWindsurf(cwd); break;
      case "zed":      installZed(cwd);      break;
    }
  }

  console.log(`
  Your AI assistant will now consult the codeprism knowledge base
  automatically at the start of every task.

  To update: re-run \`codeprism install-rules\` (idempotent).
  To uninstall: remove the codeprism blocks from the rule files above.
`);
}
