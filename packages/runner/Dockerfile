# Stage 1: Compile better-sqlite3 native module (needs build tools)
FROM node:22 AS mcp-builder
WORKDIR /build

# Provide @flowmate/shared as a local package so npm doesn't hit the registry
COPY packages/shared/package.json ./node_modules/@flowmate/shared/package.json
COPY packages/shared/dist ./node_modules/@flowmate/shared/dist/

COPY packages/mcp/package.json ./
RUN npm install --omit=dev

# Stage 2: Final slim image
FROM node:22-slim

# Claude Agent SDK requires the claude CLI binary
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Copy runner package
COPY packages/runner/package.json ./
COPY packages/runner/dist ./dist/

# Copy shared package as local dependency
COPY packages/shared/package.json ./node_modules/@flowmate/shared/package.json
COPY packages/shared/dist ./node_modules/@flowmate/shared/dist/

# Copy mcp package with pre-built native dependencies from builder stage
COPY packages/mcp/package.json ./mcp/
COPY --from=mcp-builder /build/node_modules ./mcp/node_modules/
COPY packages/mcp/dist ./mcp/dist/

# Install production dependencies only
RUN npm install --omit=dev

# Create non-root user with home directory for Claude CLI config.
# HOME is made world-writable because --user flag at runtime overrides
# the UID, so the actual UID may differ from the flowmate user's UID.
RUN useradd -m -s /bin/bash flowmate \
    && chown -R flowmate:flowmate /app \
    && chmod 777 /home/flowmate
USER flowmate

# stdout is captured by Agent SDK; IPC goes through stderr with @flowmate prefix
# Absolute path required: container -w flag overrides WORKDIR for user's cwd
CMD ["node", "/app/dist/index.js"]
