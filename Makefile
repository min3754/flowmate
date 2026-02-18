.PHONY: setup build start stop dev dev-cli install uninstall clean status logs

CONTAINER_CMD ?= podman
PLIST_SRC  = config/launchd/com.flowmate.orchestrator.plist
PLIST_DEST = $(HOME)/Library/LaunchAgents/com.flowmate.orchestrator.plist

setup:
	bash scripts/setup.sh

build:
	npm run build --workspaces
	CONTAINER_CMD=$(CONTAINER_CMD) bash scripts/build-runner.sh

start:
	mkdir -p logs data
	node packages/orchestrator/dist/index.js

# Dev mode: Slack bot + local runner (no container needed)
dev:
	mkdir -p data
	FLOWMATE_DEV=true npx tsx packages/orchestrator/src/index.ts

# Dev CLI: interactive terminal test (no Slack, no container)
dev-cli:
	mkdir -p data
	FLOWMATE_DEV=true npx tsx packages/orchestrator/src/dev-cli.ts $(ARGS)

stop:
	@if pgrep -f "node.*packages/orchestrator/dist/index.js" > /dev/null 2>&1; then \
	  pkill -f "node.*packages/orchestrator/dist/index.js"; \
	  echo "FlowMate stopped."; \
	else \
	  echo "FlowMate is not running."; \
	fi

install:
	@test -f $(PLIST_SRC) || (echo "Error: $(PLIST_SRC) not found. Copy from example.plist and configure." && exit 1)
	mkdir -p logs data
	cp $(PLIST_SRC) $(PLIST_DEST)
	launchctl bootout gui/$$(id -u)/com.flowmate.orchestrator 2>/dev/null || true
	launchctl bootstrap gui/$$(id -u) $(PLIST_DEST)
	@echo "FlowMate service installed."

uninstall:
	launchctl bootout gui/$$(id -u)/com.flowmate.orchestrator 2>/dev/null || true
	rm -f $(PLIST_DEST)
	@CONTAINERS=$$($(CONTAINER_CMD) ps -q --filter name=flowmate- 2>/dev/null); \
	  if [ -n "$$CONTAINERS" ]; then $(CONTAINER_CMD) rm -f $$CONTAINERS; fi
	@echo "FlowMate service uninstalled."

clean:
	rm -rf packages/*/dist node_modules packages/*/node_modules
	$(CONTAINER_CMD) rmi flowmate-runner:latest 2>/dev/null || true
	rm -rf logs/ packages/*/*.tsbuildinfo
	@echo "Cleaned. (data/ preserved — remove manually if needed)"

status:
	@echo "=== Service ==="
	@launchctl list 2>/dev/null | grep flowmate || echo "Not installed"
	@echo ""
	@echo "=== Process ==="
	@pgrep -f "node.*packages/orchestrator" > /dev/null 2>&1 && echo "Running (PID $$(pgrep -f 'node.*packages/orchestrator'))" || echo "Not running"
	@echo ""
	@echo "=== Containers ==="
	@$(CONTAINER_CMD) ps --filter name=flowmate- 2>/dev/null || echo "Container runtime not available"
	@echo ""
	@echo "=== DB Stats ==="
	@if [ -f config/flowmate.yaml ]; then \
	  DB_PATH=$$(grep 'path:' config/flowmate.yaml | head -1 | awk '{print $$2}'); \
	  if [ -f "$$DB_PATH" ]; then \
	    sqlite3 "$$DB_PATH" \
	      "SELECT 'conversations: ' || COUNT(*) FROM conversations; \
	       SELECT 'executions: ' || COUNT(*) FROM executions; \
	       SELECT 'today cost: $$' || COALESCE(printf('%.4f', SUM(cost_usd)), '0') FROM executions WHERE started_at >= date('now') AND started_at < date('now', '+1 day');"; \
	  else \
	    echo "DB not found at $$DB_PATH"; \
	  fi \
	else \
	  echo "Config not found (config/flowmate.yaml)"; \
	fi

logs:
	tail -f logs/flowmate.log | npx pino-pretty
