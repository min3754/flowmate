# FlowMate

[English](README.md)

Mac Mini M4 Pro에서 24시간 동작하는 개인 AI 어시스턴트. Slack DM으로 대화하며, Claude Agent SDK를 통해 코드 개발 보조와 범용 업무를 자율적으로 수행합니다.

## 아키텍처

```
┌─────────────┐     Socket Mode      ┌──────────────────┐     spawn          ┌─────────────────┐
│  Slack App   │◄────────────────────►│   Orchestrator   │───────────────────►│     Runner       │
│  (DM Chat)   │     WebSocket        │   (항상 실행)      │  stderr IPC       │ (Podman/Local)   │
└─────────────┘                       │                  │◄──────────────────│                 │
                                      │  ┌────────────┐  │  @flowmate prefix │  Claude Agent   │
                                      │  │  SQLite DB  │  │                   │  SDK query()    │
                                      │  └────────────┘  │                   │                 │
                                      └──────────────────┘                   └─────────────────┘
```

**흐름**: Slack DM 수신 → 대화 컨텍스트 로드 → Runner 실행 → Agent SDK 호출 (+ 내장 MCP 도구) → 결과를 Slack 스레드에 응답

## 사전 요구사항

- Node.js 20+
- Podman (production 모드만 필요, Docker/nerdctl도 호환)
- Slack App (Socket Mode, Bot Token + App-Level Token, Agents & AI Apps 활성화)
- Anthropic API Key

## 빠른 시작

### 1. 의존성 설치

```bash
npm install
npm run build --workspaces
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일에 입력:

```bash
SLACK_BOT_TOKEN=xoxb-...        # Slack OAuth & Permissions
SLACK_APP_TOKEN=xapp-...        # Slack App-Level Token (connections:write)
ANTHROPIC_API_KEY=sk-ant-...    # Anthropic Console
ALLOWED_USER_IDS=U01234567      # 허가된 Slack 사용자 (쉼표 구분)
```

### 3. 설정 파일

```bash
cp config/flowmate.example.yaml config/flowmate.yaml
```

`config/flowmate.yaml`에서 `allowedDirectories`, `defaultWorkingDirectory`, `database.path` 등을 본인 환경에 맞게 수정합니다.

### 4. 실행

```bash
# 개발: 터미널 대화형 테스트 (Slack/컨테이너 불필요)
make dev-cli

# 개발: Slack 연동 + 로컬 Runner (컨테이너 불필요)
make dev

# Production: 컨테이너 이미지 빌드 후 실행
make build
make start
```

## Slack App 설정

api.slack.com에서 앱 생성 후:

| 설정 | 값 |
|------|-----|
| **Agents & AI Apps** | **활성화 (필수)** — 앱 설정 > Agents & AI Apps 탭에서 활성화 |
| Socket Mode | 활성화, App-Level Token 발급 (`connections:write`) |
| Event Subscriptions | `message.im`, `assistant_thread_started`, `assistant_thread_context_changed` |
| Bot Token Scopes | `chat:write`, `im:history`, `im:read`, `im:write`, `files:write`, `assistant:write` |
| App Home | Messages Tab → "Allow users to send messages" 체크 |

> **Important**: Agents & AI Apps 활성화는 필수입니다. 활성화하면 모든 DM이 스레드 기반으로 동작하며, `markdown`/`table` 블록 렌더링과 Assistant 전용 API(`setStatus`, `setTitle`, `setSuggestedPrompts`)를 사용할 수 있습니다.

## 설정 (config/flowmate.yaml)

```yaml
model: haiku                     # sonnet, opus, haiku or full model ID
timezone: Asia/Seoul             # IANA timezone for daily budget boundaries

docker:
  command: podman                # podman, docker, or nerdctl

allowedDirectories:              # Runner가 접근 가능한 디렉토리 (절대 경로)
  - /absolute/path/to/workspace

defaultWorkingDirectory: /absolute/path/to/workspace  # allowedDirectories 내 경로

limits:
  maxBudgetPerTask: 2.00         # 태스크당 최대 비용 (USD)
  maxTurnsPerTask: 100           # Agent 최대 턴 수
  taskTimeoutMs: 600000          # 타임아웃 (10분)
  dailyBudgetLimit: 50.00        # 일별 최대 비용 (USD)

tools:                           # Agent SDK 도구 (생략 시 전체 허용)
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
  - Task
  - WebSearch
  - WebFetch

mcpServers:                      # MCP 도구 서버 (stdio 전송만 지원)
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/workspace"]
```

> **Note**: `allowedDirectories`와 `defaultWorkingDirectory`는 절대 경로만 허용됩니다. `defaultWorkingDirectory`는 `allowedDirectories` 중 하나의 하위 경로여야 합니다.

## 대화 동작 방식

- **새 대화** → Slack이 자동으로 스레드 생성, 추천 프롬프트 표시
- **메시지 전송** → `setStatus`로 thinking 표시 → 실행 완료 후 결과 메시지 게시
- **스레드 내 메시지** → 기존 대화 계속, 이전 이력이 Agent에 전달
- **동시 실행 방지** → 같은 스레드에서 작업 중이면 대기 안내 메시지 표시
- **응답 렌더링** → `markdown` 블록(표준 Markdown), `table` 블록(표), 코드 블록 지원
- **이미지 첨부** → JPEG, PNG, GIF, WebP 지원 (5MB 이하, 최대 5장)
- **데이터 영속** → SQLite에 저장, 재시작해도 기존 대화 유지
- **History 탭** → 실행 완료 시 `setTitle`로 스레드 제목 표시

## 내장 MCP 도구

Runner(Agent SDK)에 자동 주입되는 `@flowmate/mcp` 서버가 운영 데이터에 대한 read-only 접근을 제공합니다. "오늘 비용 얼마?" 같은 질문에 Agent가 직접 DB를 조회하여 답변합니다.

| 도구 | 설명 |
|------|------|
| `get_daily_stats` | 오늘의 비용, 잔여 예산, 실행 횟수, 평균 소요시간 |
| `get_cost_history` | 최근 N일간 일별 비용 추이 (최대 90일) |
| `get_execution_history` | 실행 기록 조회 (상태/날짜 필터) |
| `get_model_usage` | 모델별 사용량, 비용, 토큰 통계 |

> 날짜 경계는 설정된 timezone 기준으로 계산됩니다.

## Makefile 명령어

| 명령 | 설명 |
|------|------|
| `make dev-cli` | 터미널 대화형 테스트 (Slack/컨테이너 불필요) |
| `make dev` | Slack 연동 + 로컬 Runner (컨테이너 불필요) |
| `make build` | TypeScript 컴파일 + 컨테이너 이미지 빌드 |
| `make start` | Production 포그라운드 실행 |
| `make stop` | 오케스트레이터 중지 |
| `make install` | macOS launchd 서비스 등록 (자동 시작 + 비정상 종료 시 재시작) |
| `make uninstall` | launchd 서비스 해제 + 실행 중 컨테이너 정리 |
| `make clean` | 빌드 산출물 삭제 (data/ 보존) |
| `make status` | 서비스 상태, 프로세스 PID, 실행 중 컨테이너, DB 통계 |
| `make logs` | 오케스트레이터 로그 tail (pino-pretty) |

> Makefile의 컨테이너 명령은 기본 `podman`을 사용합니다. Docker를 사용하려면: `make build CONTAINER_CMD=docker`

## launchd 서비스 설정

24시간 자동 실행을 위한 macOS 서비스 등록:

```bash
# 1. plist 파일 생성 (example에서 복사 후 경로 수정)
cp config/launchd/com.flowmate.orchestrator.example.plist config/launchd/com.flowmate.orchestrator.plist

# 2. plist에서 node 경로, 프로젝트 경로, 로그 경로를 본인 환경에 맞게 수정

# 3. 서비스 등록
make install
```

plist에서 수정할 항목:
- Node.js 바이너리 경로 (nvm 사용 시 `~/.nvm/versions/node/vXX/bin/node`)
- PATH에 podman/node 경로 포함
- `WorkingDirectory`, `ProgramArguments`, 로그 경로

## 프로젝트 구조

```
flowmate/
├── config/
│   ├── flowmate.yaml                    # 메인 설정 (gitignored)
│   ├── flowmate.example.yaml            # 설정 예시
│   └── launchd/                         # macOS 서비스 plist
├── packages/
│   ├── shared/                          # 공유 타입, IPC 프로토콜
│   ├── db/                              # SQLite 스키마 (drizzle-orm)
│   ├── orchestrator/                    # Slack 봇 + 실행 관리자
│   ├── mcp/                             # 내장 MCP 서버 (운영 통계 조회)
│   └── runner/                          # Agent SDK 실행 + Dockerfile
├── scripts/                             # setup, build, install 스크립트
├── Makefile
└── CLAUDE.md                            # Agent용 프로젝트 지침
```

## 기술 스택

| 구성요소 | 기술 |
|---------|------|
| 언어 | TypeScript (ES2022, strict mode) |
| 런타임 | Node.js 20+ (컨테이너 내 Node.js 22 LTS) |
| Slack | @slack/bolt (Socket Mode) |
| AI | @anthropic-ai/claude-agent-sdk |
| MCP | @modelcontextprotocol/sdk (내장 운영 통계 서버) |
| DB | SQLite + drizzle-orm + better-sqlite3 |
| 컨테이너 | Podman CLI (Docker/nerdctl 호환) |
| 프로세스 관리 | macOS launchd |
| 설정 | YAML + zod 검증 |
| 로깅 | pino |
