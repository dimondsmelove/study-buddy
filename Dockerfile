FROM node:22.22.2-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY vite.backend.config.ts tsconfig.backend.json ./
COPY src/backend/ ./src/backend/
COPY src/shared/ ./src/shared/
RUN npm run backend:build

FROM node:22.22.2-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/study-buddy.sqlite
WORKDIR /app

COPY --from=build --chown=node:node /app/.backend-dist/ ./.backend-dist/
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir /data && chown 10001:10001 /data && chmod 0700 /data

USER 10001:10001
EXPOSE 8787
CMD ["node", ".backend-dist/server.js"]
