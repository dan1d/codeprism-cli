# codeprism CLI

Index your codebase locally and push AI knowledge cards to a [codeprism](https://codeprism.dev) engine.

```bash
npx codeprism index
npx codeprism push --engine-url https://yourteam.codeprism.dev --api-key sk_xxx --delete
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
- `--ticket <id>` — bias indexing toward a ticket (e.g. `ENG-123`)

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

Install git hooks in the current repo to sync file changes automatically after commits.

```bash
codeprism install-hook --engine-url https://yourteam.codeprism.dev
```

### `codeprism sync`

Manually notify a running codeprism server about git changes.

### `codeprism check`

LLM-powered PR diff checker against team rules.

### `codeprism rules list|add|delete`

Manage team coding rules stored in the local engine DB.

---

## Workspace config

Place `codeprism.config.json` at your workspace root to explicitly list repos:

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
