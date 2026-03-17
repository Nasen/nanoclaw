# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and M365 MCP server globally
RUN npm install -g agent-browser @anthropic-ai/claude-code m365-mcp

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script.
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Runs from the image-compiled /app/dist/ (owned by root, not writable by the node user)
# so a prompt-injected agent cannot modify its own compiled code.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nexec node /app/dist/index.js\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Allow git to operate in bind-mounted directories owned by any UID.
# Without this, git refuses to run in /workspace/extra/* because the host
# files are owned by UID 502 (or whatever the host user is), which doesn't
# match the container's node user. Safe: containers are already sandboxed.
RUN git config --system safe.directory '*'

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
