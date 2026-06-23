# ABOUTME: Standalone container image for the crowdfund indexer API and the
# ABOUTME: Discord alert evaluator, run directly from TypeScript via ts-node.

# Build context is the indexer package dir, e.g.:
#   docker build -f deploy/indexer.Dockerfile -t crowdfund-indexer:<tag> crowdfund-ui/packages/indexer
FROM node:22-bookworm-slim

WORKDIR /app

# Install only the indexer package's own dependencies. The indexer has no
# workspace deps, so it installs standalone without the rest of the monorepo
# (and without --legacy-peer-deps). tsx (the TypeScript/ESM runner) is a
# devDependency and is required at runtime, so do not omit dev deps here.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Application source (node_modules and data/ are excluded via .dockerignore).
COPY . .

# Run as the unprivileged node user; pre-create the data dir so the named
# volume mounted at /app/data inherits node ownership.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production

# Default API port (overridable via CROWDFUND_INDEXER_PORT).
EXPOSE 3002

# API server by default; the alerts container overrides this command.
CMD ["node_modules/.bin/tsx", "src/api/server.ts"]
