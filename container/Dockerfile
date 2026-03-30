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
    libnss-wrapper \
    openssh-client \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

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
# When the host runs the container as an arbitrary UID/GID (for bind-mounted
# repo ownership parity), OpenSSH requires that UID to resolve to a passwd
# entry. Use nss_wrapper to synthesize one at startup when needed.
RUN cat <<'EOF' > /app/entrypoint.sh
#!/bin/bash
set -e

CURRENT_UID="$(id -u)"
CURRENT_GID="$(id -g)"
NSS_WRAPPER_LIB="/usr/lib/x86_64-linux-gnu/libnss_wrapper.so"

if ! grep -Eq "^[^:]*:[^:]*:${CURRENT_UID}:${CURRENT_GID}:" /etc/passwd; then
  if [ -f "${NSS_WRAPPER_LIB}" ]; then
    export LD_PRELOAD="${NSS_WRAPPER_LIB}${LD_PRELOAD:+:${LD_PRELOAD}}"
    export NSS_WRAPPER_PASSWD=/tmp/nss-wrapper.passwd
    export NSS_WRAPPER_GROUP=/tmp/nss-wrapper.group

    cp /etc/passwd "${NSS_WRAPPER_PASSWD}"
    cp /etc/group "${NSS_WRAPPER_GROUP}"

    echo "nanoclaw:x:${CURRENT_UID}:${CURRENT_GID}:NanoClaw:${HOME:-/home/node}:/bin/sh" >> "${NSS_WRAPPER_PASSWD}"
    if ! grep -Eq "^[^:]*:[^:]*:${CURRENT_GID}:" /etc/group; then
      echo "nanoclaw:x:${CURRENT_GID}:" >> "${NSS_WRAPPER_GROUP}"
    fi
  fi
fi

exec node /app/dist/index.js
EOF
RUN chmod +x /app/entrypoint.sh

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
