# syntax=docker/dockerfile:1
# Hosted Desk gateway (hosted/README.md). Build from the repository root, which
# the image needs for both Desk's plugin and the gateway:
#   docker build -f hosted/Dockerfile .
#   az acr build -r <registry> -f hosted/Dockerfile -t ouro-desk-hosted:<sha> .
# The root .dockerignore sends only plugins/desk and hosted, without node_modules.
FROM node:22-slim

# Git for the desk clone, tini as PID 1, and the real GitHub CLI from GitHub's
# own apt repository at /usr/bin/gh. The gateway puts its gh shim (hosted/bin)
# first on each Desk child's PATH; the shim runs this gh with a fresh
# installation token.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source-only change reuses these layers.
COPY plugins/desk/mcp/package.json plugins/desk/mcp/package-lock.json plugins/desk/mcp/
RUN npm ci --omit=dev --prefix plugins/desk/mcp
COPY hosted/package.json hosted/package-lock.json hosted/
RUN npm ci --omit=dev --prefix hosted

COPY plugins/desk plugins/desk
COPY hosted hosted

# The desk clone lives on the container's own disk: it is a cache of
# arimendelow/desk that the gateway clones again on every start.
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=8080 \
    DESK_PLUGIN_DIR=/app/plugins/desk \
    DESK_CLONE_DIR=/data/desk

USER node
EXPOSE 8080
# tini reaps the detached workers Desk leaves behind (its push worker, problem
# filer and refreshes), which node as PID 1 would leave as zombies, and passes
# SIGTERM on to the gateway so its shutdown can push the desk.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "hosted/src/main.js"]
