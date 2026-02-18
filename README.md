# FlowMate

[한국어](README.ko.md)

A personal AI assistant running 24/7 on Mac Mini M4 Pro. Communicates via Slack DM and autonomously performs coding tasks and general work through the Claude Agent SDK.

## Architecture

```
┌─────────────┐     Socket Mode      ┌──────────────────┐     spawn          ┌─────────────────┐
│  Slack App   │◄────────────────────►│   Orchestrator   │───────────────────►│     Runner       │
│  (DM Chat)   │     WebSocket        │  (always running) │  stderr IPC       │ (Podman/Local)   │
└─────────────┘                       │                  │◄──────────────────│                 │
                                      │  ┌────────────┐  │  @flowmate prefix │  Claude Agent   │
                                      │  │  SQLite DB  │  │                   │  SDK query()    │
                                      │  └────────────┘  │                   │                 │
                                      └──────────────────┘                   └─────────────────┘
```

**Flow**: Slack DM received → Load conversation context → Spawn runner → Agent SDK call (+ built-in MCP tools) → Reply to Slack thread

## Prerequisites

- Node.js 20+
- Podman (production mode only; Docker/nerdctl also compatible)
- Slack App (Socket Mode, Bot Token + App-Level Token, Agents & AI Apps enabled)
- Anthropic API Key

## Quick Start

### 1. Install Dependencies

```bash
npm install
npm run build --workspaces
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...        # Slack OAuth & Permissions
SLACK_APP_TOKEN=xapp-...        # Slack App-Level Token (connections:write)
ANTHROPIC_API_KEY=sk-ant-...    # Anthropic Console
ALLOWED_USER_IDS=U01234567      # Authorized Slack users (comma-separated)
```

### 3. Configure Settings

```bash
cp config/flowmate.example.yaml config/flowmate.yaml
```

Edit `config/flowmate.yaml` to set `allowedDirectories`, `defaultWorkingDirectory`, `database.path`, etc. for your environment.

### 4. Run

```bash
# Dev: Interactive terminal test (no Slack/container needed)
make dev-cli

# Dev: Slack connected + local runner (no container needed)
make dev

# Production: Build container image and run
make build
make start
```

## Slack App Setup

Create an app at api.slack.com and configure:

| Setting | Value |
|---------|-------|
| **Agents & AI Apps** | **Enable (required)** — App Settings > Agents & AI Apps tab |
| Socket Mode | Enable, issue App-Level Token (`connections:write`) |
| Event Subscriptions | `message.im`, `assistant_thread_started`, `assistant_thread_context_changed` |
| Bot Token Scopes | `chat:write`, `im:history`, `im:read`, `im:write`, `files:write`, `assistant:write` |
| App Home | Messages Tab → Check "Allow users to send messages" |

> **Important**: Agents & AI Apps must be enabled. This makes all DMs thread-based and enables `markdown`/`table` block rendering and Assistant APIs (`setStatus`, `setTitle`, `setSuggestedPrompts`).

## Configuration (config/flowmate.yaml)

```yaml
model: haiku                     # sonnet, opus, haiku, or full model ID
timezone: Asia/Seoul             # IANA timezone for daily budget boundaries

docker:
  command: podman                # podman, docker, or nerdctl

allowedDirectories:              # Directories the runner can access (absolute paths)
  - /absolute/path/to/workspace

defaultWorkingDirectory: /absolute/path/to/workspace  # Must be within allowedDirectories

limits:
  maxBudgetPerTask: 2.00         # Per-task cost cap (USD)
  maxTurnsPerTask: 100           # Max agent turns
  taskTimeoutMs: 600000          # Timeout (10 min)
  dailyBudgetLimit: 50.00        # Daily cost cap (USD)

tools:                           # Agent SDK tools (omit for all)
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
  - Task
  - WebSearch
  - WebFetch

mcpServers:                      # MCP tool servers (stdio transport only)
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/workspace"]
```

> **Note**: `allowedDirectories` and `defaultWorkingDirectory` must be absolute paths. `defaultWorkingDirectory` must be within one of the `allowedDirectories`.

## Conversation Behavior

- **New conversation** → Slack auto-creates a thread with suggested prompts
- **Send message** → Thinking indicator via `setStatus` → Result posted on completion
- **Thread messages** → Continues existing conversation with full history passed to the agent
- **Concurrent execution guard** → Shows a wait message if a task is already running in the thread
- **Response rendering** → `markdown` blocks (standard Markdown), `table` blocks, code blocks
- **Image attachments** → JPEG, PNG, GIF, WebP supported (under 5MB, up to 5 images)
- **Data persistence** → Stored in SQLite, conversations survive restarts
- **History tab** → Thread title set via `setTitle` on completion

## Built-in MCP Tools

The `@flowmate/mcp` server is auto-injected into every execution, giving the agent read-only access to operational data. Questions like "How much did I spend today?" are answered by querying the DB directly.

| Tool | Description |
|------|-------------|
| `get_daily_stats` | Today's cost, remaining budget, execution count, avg duration |
| `get_cost_history` | Daily cost trend over recent days (up to 90) |
| `get_execution_history` | Execution records with status/date filters |
| `get_model_usage` | Per-model usage, cost, and token stats |

> Date boundaries are calculated using the configured timezone.

## Makefile Commands

| Command | Description |
|---------|-------------|
| `make dev-cli` | Interactive terminal test (no Slack/container needed) |
| `make dev` | Slack connected + local runner (no container needed) |
| `make build` | TypeScript compile + container image build |
| `make start` | Production foreground run |
| `make stop` | Stop the orchestrator |
| `make install` | Register as macOS launchd service (auto-start + restart on crash) |
| `make uninstall` | Unregister launchd service + clean up running containers |
| `make clean` | Remove build artifacts (data/ preserved) |
| `make status` | Service status, process PID, running containers, DB stats |
| `make logs` | Tail orchestrator logs (pino-pretty) |

> Container commands default to `podman`. For Docker: `make build CONTAINER_CMD=docker`

## launchd Service Setup

Register as a macOS service for 24/7 operation:

```bash
# 1. Create plist (copy from example and configure paths)
cp config/launchd/com.flowmate.orchestrator.example.plist config/launchd/com.flowmate.orchestrator.plist

# 2. Edit the plist: set node path, project path, and log paths for your environment

# 3. Register the service
make install
```

Items to configure in the plist:
- Node.js binary path (for nvm: `~/.nvm/versions/node/vXX/bin/node`)
- PATH including podman/node directories
- `WorkingDirectory`, `ProgramArguments`, log paths

## Project Structure

```
flowmate/
├── config/
│   ├── flowmate.yaml                    # Main config (gitignored)
│   ├── flowmate.example.yaml            # Example config
│   └── launchd/                         # macOS service plist
├── packages/
│   ├── shared/                          # Shared types, IPC protocol
│   ├── db/                              # SQLite schema (drizzle-orm)
│   ├── orchestrator/                    # Slack bot + execution manager
│   ├── mcp/                             # Built-in MCP server (operational stats)
│   └── runner/                          # Agent SDK execution + Dockerfile
├── scripts/                             # setup, build, install scripts
├── Makefile
└── CLAUDE.md                            # Project instructions for the agent
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ES2022, strict mode) |
| Runtime | Node.js 20+ (Node.js 22 LTS in container) |
| Slack | @slack/bolt (Socket Mode) |
| AI | @anthropic-ai/claude-agent-sdk |
| MCP | @modelcontextprotocol/sdk (built-in operational stats server) |
| DB | SQLite + drizzle-orm + better-sqlite3 |
| Container | Podman CLI (Docker/nerdctl compatible) |
| Process Mgmt | macOS launchd |
| Config | YAML + zod validation |
| Logging | pino |
