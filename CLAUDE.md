# FlowMate

Personal AI assistant running on Mac Mini M4 Pro. Communicates via Slack DM, executes tasks using Claude Agent SDK. Each request runs in an isolated environment (Podman container in production, local process in dev mode).

## Project Structure

```
flowmate/
├── config/flowmate.yaml                 # Main config (model, directories, limits, tools, MCP)
├── packages/
│   ├── shared/src/                      # Shared types and IPC protocol
│   │   ├── types.ts                     # TaskConfig, FlowmateConfig, ALL_TOOLS, etc.
│   │   ├── ipc.ts                       # IPC prefix, message types, validation + parser
│   │   └── timezone.ts                  # Timezone-aware date range utility
│   ├── db/src/                          # SQLite database (drizzle-orm + better-sqlite3)
│   │   ├── schema.ts                    # 3 tables: conversations, messages, executions
│   │   └── client.ts                    # DB creation, WAL mode, busy_timeout, migrations
│   ├── orchestrator/src/                # Always-running Slack bot + execution manager
│   │   ├── index.ts                     # Entrypoint: env validation → config → DB → Slack → shutdown
│   │   ├── dev-cli.ts                   # Interactive terminal test (no Slack, no container)
│   │   ├── config/loader.ts             # YAML config + zod validation (path, tool, directory checks)
│   │   ├── slack/app.ts                 # Slack Bolt Socket Mode init
│   │   ├── slack/handlers.ts            # DM message + Assistant events + per-thread lock
│   │   ├── slack/formatter.ts           # Markdown/table block formatting + overflow
│   │   ├── context/thread-manager.ts    # Conversation CRUD by (channel_id, thread_ts)
│   │   ├── container/manager.ts         # Podman CLI container lifecycle + --user UID
│   │   ├── container/local-runner.ts    # Dev mode: local Node process instead of container
│   │   ├── container/cleanup.ts         # Orphan container scanner (60s interval)
│   │   └── services/
│   │       ├── execution.ts             # Full orchestration: budget → history → runner → DB → Slack
│   │       └── cost-tracker.ts          # Real-time cost aggregation + budget reservation
│   ├── mcp/src/                         # Built-in MCP server for operational data access
│   │   ├── index.ts                     # Server entrypoint + CLI arg parsing
│   │   ├── db.ts                        # Readonly SQLite connection helper
│   │   └── tools/stats.ts              # 4 tools: daily stats, cost history, executions, model usage
│   └── runner/src/                      # Runs inside container (or locally in dev)
│       ├── index.ts                     # Agent SDK query() + IPC output + TaskConfig validation
│       └── ipc.ts                       # stderr IPC emitter (@flowmate prefix)
├── scripts/                             # setup.sh, build-runner.sh, install-service.sh
└── Makefile                             # dev, dev-cli, build, start, install, etc.
```

## Architecture

```
Slack DM → Orchestrator → Runner (Podman or local) → Claude Agent SDK → Slack thread reply
```

- Orchestrator is always running, receiving messages via Slack Socket Mode
- Each execution spawns a runner process that calls Agent SDK `query()`
- Runner communicates back via **stderr** with `@flowmate` prefix (Agent SDK captures stdout for CLI communication)
- Orchestrator parses stderr lines: `@flowmate`-prefixed lines are IPC messages, others are debug logs
- Conversation context is stored in SQLite and passed to each execution
- **Built-in MCP server** (`@flowmate/mcp`) is auto-injected into every execution, giving the runner read-only access to operational data (costs, executions, model usage)
- **Requires Slack Agents & AI Apps** enabled — all DMs are thread-based

## Key Design Decisions

- **Podman CLI via child_process.spawn** — configurable via `docker.command` in config (`podman`, `docker`, `nerdctl`)
- **IPC: stderr with `@flowmate` prefix** — Agent SDK captures stdout for its CLI subprocess communication, so runner writes `@flowmate {"type":"progress"|"result"|"error", ...}` to stderr; orchestrator parses lines with prefix as IPC, others as debug logs. Follows the Nix `@nix` convention for structured data on stderr.
- **IPC validation: 2-layer** — 1st: `@flowmate` prefix match, 2nd: `isValidIpcMessage()` validates type discriminant and required fields. Prevents accidental collision.
- **Container user: runtime --user flag** — Dockerfile creates non-root `flowmate` user with `chmod 777 /home/flowmate`; `manager.ts` passes `--user $(uid):$(gid)` at runtime to match host UID for bind-mount write access. Claude CLI requires writable HOME and non-root user.
- **Thread-based conversations** — `(channel_id, thread_ts)` is the conversation key
- **Per-thread execution lock** — prevents concurrent executions in the same Slack thread
- **Budget reservation** — `CostTracker.reserve()` prevents concurrent executions from collectively exceeding daily budget (TOCTOU protection)
- **Graceful shutdown** — drains in-flight executions (10s timeout), closes DB, double-shutdown guard
- **child.on("close") not "exit"** — ensures stdio streams are fully drained before checking IPC result
- **process.exitCode not process.exit()** — ensures stderr IPC messages flush before runner exits
- **Agents & AI Apps required** — all DMs are thread-based, `thread_ts` is always present
- **RunnerBackend interface** — ContainerManager and LocalRunner share the same interface and IPC protocol
- **FLOWMATE_DEV=true** — skips container, runs runner as local Node process
- **Built-in MCP auto-injection** — orchestrator injects `@flowmate/mcp` server into every execution; dev uses host path, container uses `/app/mcp/dist/index.js`
- **Real-time cost aggregation** — daily costs computed from `executions` table with timezone-aware date boundaries; no separate summary table
- **Configurable tools** — `tools` array in config controls which Agent SDK tools are available to the runner
- **Slack table limit** — Slack allows only one `table` block per message; formatter renders the first markdown table as native table, subsequent ones as code blocks

## Slack Message Rendering (Agents & AI Apps)

- **`markdown` blocks** for response text — renders standard Markdown (headers, bold, lists, code blocks)
- **`table` blocks** for markdown tables — formatter auto-converts `| col | col |` syntax to native Slack table (one per message; additional tables rendered as code blocks)
- **`assistant.threads.setStatus()`** for thinking indicator — no separate "processing" message
- **`assistant.threads.setTitle()`** on completion — shows thread title in History tab
- **`assistant.threads.setSuggestedPrompts()`** on thread start — shows example prompts
- **12,000 char limit** per message (markdown block limit); overflow uploaded as file attachment
- **`text` field** is plaintext fallback for notifications only, not the rendered content

## Conventions

- TypeScript strict mode, ES2022 target, Node16 module resolution
- npm workspaces monorepo (shared → db → orchestrator, shared → runner, mcp)
- Runner package uses `"type": "module"` (ESM) for Agent SDK compatibility
- All config in `config/flowmate.yaml`, validated by zod at startup
- Environment secrets in `.env` (gitignored), template in `.env.example`
- Required env vars validated at startup: `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`

## Commenting Conventions

All comments are written in English.

### Module headers
Every non-barrel source file starts with a JSDoc module header:
```ts
/**
 * @module <package>/<filename>
 * <One-sentence description of the module's responsibility.>
 */
```

### Exported symbols
- All exported types, interfaces, functions, and classes have JSDoc comments
- Functions include `@param`, `@returns`, `@throws` where non-obvious
- Describe the "why" and contract, not implementation details

### Inline comments
- Explain **why**, not **what** — skip comments on self-documenting code
- Use for: non-obvious design decisions, platform workarounds, algorithm rationale
- Do NOT comment: imports, trivial assignments, obvious control flow, barrel re-exports

### What NOT to comment
- Barrel files (`export * from ...`)
- Self-descriptive constants (name tells the story)
- Drizzle/config boilerplate
- Getters and setters

## Development

```bash
make dev-cli    # Terminal test (no Slack, no container needed)
make dev        # Slack connected + local runner (no container needed)
make build      # TypeScript compile + container image build
make start      # Production mode (requires container image)
make install    # Register as macOS launchd service (auto-start)
make uninstall  # Unregister launchd service
make status     # Service, process, container, DB stats
make logs       # Tail orchestrator logs (pino-pretty)
```

## Config Reference (config/flowmate.yaml)

- `model` — Claude model: sonnet, opus, haiku, or full model ID
- `timezone` — IANA timezone for daily budget boundaries (default: UTC)
- `docker.command` — Container CLI: `podman` (default), `docker`, or `nerdctl`
- `allowedDirectories` — Directories the runner can access (bind-mounted in container, must be absolute paths)
- `defaultWorkingDirectory` — Runner's cwd (must be within `allowedDirectories`)
- `limits.maxBudgetPerTask` — Per-execution cost cap (USD)
- `limits.dailyBudgetLimit` — Daily total cost cap (USD)
- `limits.taskTimeoutMs` — Execution timeout
- `tools` — Agent SDK tools available to the runner (defaults to all: Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch, WebFetch)
- `mcpServers` — MCP server configurations passed to Agent SDK (stdio transport only)
