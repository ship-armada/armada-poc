# ABOUTME: Container image for the crowdfund indexer API and the Discord alert
# ABOUTME: evaluator, run directly from TypeScript via tsx.

# Build context is crowdfund-ui/ so the indexer's relative imports into the
# sibling shared package (../../../shared/src/lib/*) resolve. Build with:
#   docker build -f deploy/indexer.Dockerfile -t crowdfund-indexer:<tag> crowdfund-ui
FROM node:22-bookworm-slim

WORKDIR /app

# Install the indexer's dependencies hoisted at /app/node_modules so both the
# indexer and the shared source files (which import `ethers`) resolve them by
# walking up the tree. tsx (the TypeScript/ESM runner) is a devDependency
# required at runtime, so do not omit dev deps here. The indexer package has no
# workspace deps, so it installs standalone (no --legacy-peer-deps).
COPY packages/indexer/package.json ./package.json
RUN npm install --no-audit --no-fund

# Application source: the indexer plus the shared package it imports via
# relative paths. The /app/packages/{indexer,shared} layout mirrors the
# monorepo so those ../../../shared/src/lib/* imports resolve.
COPY packages/indexer ./packages/indexer
COPY packages/shared ./packages/shared

# Run as the unprivileged node user; pre-create the data dir so the named
# volume mounted at /app/data inherits node ownership.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production

# Default API port (overridable via CROWDFUND_INDEXER_PORT).
EXPOSE 3002

# API server by default; the alerts container overrides this command.
CMD ["node_modules/.bin/tsx", "packages/indexer/src/api/server.ts"]
