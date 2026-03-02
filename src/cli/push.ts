/**
 * codeprism push — uploads a local codeprism.db to a hosted engine.
 *
 * After running `codeprism index` locally (which uses your own LLM key
 * to generate rich AI cards), use this command to sync the results to
 * your team's hosted codeprism engine.
 *
 * Usage:
 *   codeprism push \
 *     --engine-url https://yourteam.codeprism.dev \
 *     --api-key    sk_xxxxxxxxxxxx
 *
 * Options:
 *   --engine-url  Engine base URL (or set CODEPRISM_ENGINE_URL env var)
 *   --api-key     Team API key   (or set CODEPRISM_API_KEY env var)
 *   --db          Path to local codeprism.db (auto-detected if not set)
 *   --delete      Delete the local DB after a successful push
 */

/* eslint-disable no-console */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const _moduleDir = dirname(fileURLToPath(import.meta.url));

function defaultDbPath(): string {
  // packages/engine/codeprism.db (when run from the engine package)
  return join(_moduleDir, "..", "..", "codeprism.db");
}

export interface PushOptions {
  engineUrl: string;
  apiKey: string;
  db?: string;
  delete?: boolean;
}

export async function runPush(opts: PushOptions): Promise<void> {
  const engineUrl = opts.engineUrl.replace(/\/$/, "");
  const apiKey = opts.apiKey;
  const dbPath = resolve(opts.db ?? defaultDbPath());
  const shouldDelete = opts.delete ?? false;

  if (!engineUrl) {
    console.error("❌  --engine-url is required (or set CODEPRISM_ENGINE_URL)");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("❌  --api-key is required (or set CODEPRISM_API_KEY)");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`❌  Database not found: ${dbPath}`);
    console.error("    Run `codeprism index` first to generate the local knowledge base.");
    process.exit(1);
  }

  const bytes = readFileSync(dbPath);
  const mb = (bytes.length / 1024 / 1024).toFixed(1);

  console.log(`\n📦  Pushing local knowledge base to ${engineUrl}`);
  console.log(`    DB: ${dbPath} (${mb} MB)\n`);

  const url = `${engineUrl}/api/db/push`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
  } catch (err) {
    console.error(`❌  Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(`❌  Push failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const result = await res.json() as { ok: boolean; cards: number; files: number; docs: number };

  console.log(`✅  Push complete!`);
  console.log(`    Cards   : ${result.cards}`);
  console.log(`    Files   : ${result.files}`);
  console.log(`    Docs    : ${result.docs}`);
  console.log("");
  console.log("    Your team can now query the updated knowledge base via MCP.");
  console.log("");

  if (shouldDelete) {
    try {
      unlinkSync(dbPath);
      console.log(`🗑   Local DB deleted: ${dbPath}`);
    } catch (err) {
      console.warn(`⚠️   Could not delete local DB: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`    Tip: pass --delete to remove the local DB after pushing.`);
  }
}
