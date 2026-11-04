# Frische, isolierte Umgebung für einen Lauf: kein Home-Verzeichnis vom Host,
# keine Memories, keine CLAUDE.md/AGENTS.md, keine Plugins, keine Host-Umgebungsvariablen.
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep jq curl ca-certificates python3 procps less \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.318
ARG CODEX_VERSION=0.166.0
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force

USER node
ENV HOME=/home/node
WORKDIR /workspace
