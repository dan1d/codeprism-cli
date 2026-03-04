# codeprism CLI

Index your codebase locally and push AI knowledge cards to a [codeprism](https://codeprism.dev) engine.

```bash
npx codeprism init
npx codeprism index
npx codeprism push
```

---

## Install

```bash
npm install -g codeprism
# or use npx (no install needed)
npx codeprism --help
```

---

## Commands

### `codeprism init`

Interactive setup wizard — configure repos, engine URL, API key, MCP editor config, git hooks, and LLM provider in one step.

```bash
codeprism init
```

Creates a `.codeprism/` directory with `config.json`, `rules.json`, and `.gitignore`. Optionally installs MCP configs for detected editors and git hooks for automatic KB sync.

### `codeprism index`

Indexes all repositories in your workspace using your own LLM key. Results are written to a local `codeprism.db` file.

```bash
CODEPRISM_LLM_PROVIDER=anthropic \
CODEPRISM_LLM_API_KEY=sk-ant-... \
codeprism index
```

Supported LLM providers: `anthropic`, `openai`, `deepseek`, `gemini`

Options:
- `--force` — reindex everything regardless of git changes
- `--repo <name>` — restrict to a single repo
- `--skip-docs` — skip doc generation (faster)
- `--force-docs` — force regeneration of all docs even if they exist
- `--ticket <id>` — bias indexing toward a ticket (e.g. `ENG-123`)
- `--fetch-remote` — run `git fetch --all` before branch signal collection

### `codeprism push`

Upload a local `codeprism.db` to a hosted engine so your whole team benefits.

```bash
codeprism push \
  --engine-url https://yourteam.codeprism.dev \
  --api-key YOUR_TEAM_API_KEY \
  --delete
```

Options:
- `--engine-url` — hosted engine URL (or `CODEPRISM_ENGINE_URL` env var)
- `--api-key` — team API key (or `CODEPRISM_API_KEY` env var)
- `--db` — path to local DB (auto-detected if omitted)
- `--delete` — delete the local DB after a successful push

### `codeprism install-hook`

Install git hooks in the current repo to sync file changes automatically after commits, merges, branch switches, and rebases.

```bash
codeprism install-hook --engine-url https://yourteam.codeprism.dev
```

Hooks installed: `post-commit`, `post-merge`, `post-checkout`, `post-rewrite`. Also offered during `codeprism init`.

### `codeprism install-rules`

Write AI rule files that instruct your editor to always consult codeprism before any task. Auto-detects Cursor, Claude Code, Windsurf, and Zed.

```bash
codeprism install-rules            # auto-detect editors
codeprism install-rules --all      # install for all editors
codeprism install-rules --editor cursor
```

### `codeprism uninstall`

Remove all codeprism artifacts from the workspace, repos, git hooks, and (optionally) global editor configs.

```bash
codeprism uninstall              # interactive confirmation
codeprism uninstall --dry-run    # preview what would be removed
codeprism uninstall --force      # skip confirmation
codeprism uninstall --no-global  # skip global editor configs
```

Removes:
- `.codeprism/` directory, `codeprism.db`, `codeprism.config.json`
- `ai-codeprism/` generated docs per repo
- Editor rules (`.cursor/rules/codeprism.mdc`, `.zed/rules/codeprism.md`)
- Codeprism sections from `CLAUDE.md`, `.windsurfrules`
- `mcpServers.codeprism` from `.cursor/mcp.json`
- Codeprism blocks from git hooks
- Global configs (`~/.claude/`, `~/.codeium/windsurf/`, `~/.config/zed/`)

### `codeprism sync`

Manually notify a running codeprism server about git changes.

### `codeprism check`

LLM-powered PR diff checker against team rules.

### `codeprism rules list|add|delete`

Manage team coding rules stored in the local engine DB.

---

## Workspace config

Run `codeprism init` to create `.codeprism/config.json` interactively, or place `codeprism.config.json` at your workspace root:

```json
{
  "repos": [
    { "path": "./api", "name": "my-api" },
    { "path": "./frontend", "name": "my-frontend" }
  ]
}
```

Without a config file, codeprism auto-discovers repos in sibling directories.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `CODEPRISM_LLM_PROVIDER` | LLM provider: `anthropic`, `openai`, `deepseek`, `gemini` |
| `CODEPRISM_LLM_API_KEY` | Your personal LLM API key (used only for local indexing) |
| `CODEPRISM_LLM_MODEL` | Override the default model |
| `CODEPRISM_DB_PATH` | Path to the local SQLite DB (default: `./codeprism.db`) |
| `CODEPRISM_ENGINE_URL` | Hosted engine base URL |
| `CODEPRISM_API_KEY` | Team API key for `codeprism push` |

---

## License

MIT
