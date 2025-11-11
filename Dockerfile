# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3010

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY skyoffice/package*.json ./skyoffice/
COPY skyoffice/tsconfig.server.build.json ./skyoffice/
COPY skyoffice/server/tsconfig.server.json ./skyoffice/server/
RUN cd skyoffice && npm ci --include=dev

FROM deps AS builder
COPY skyoffice ./skyoffice
COPY shared ./shared
RUN cd skyoffice && npm run build:server
RUN mkdir -p skyoffice/dist/skyoffice/client/public && cp -R skyoffice/client/public/. skyoffice/dist/skyoffice/client/public/
RUN cd skyoffice && npm prune --omit=dev

FROM base AS runner
RUN apk add --no-cache curl
COPY --from=builder /app/skyoffice/dist ./dist
COPY --from=builder /app/skyoffice/node_modules ./node_modules
COPY skyoffice/package.json .
COPY skyoffice/package-lock.json .
RUN mkdir -p /app/dist/skyoffice/server/data
RUN chown -R node:node /app
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3010}/healthz" || exit 1
USER node
CMD ["node", "dist/skyoffice/server/index.js"]
