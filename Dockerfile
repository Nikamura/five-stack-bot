# syntax=docker/dockerfile:1.7

# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build deps for better-sqlite3 native module.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY web ./web

# SQLite file lives here; mount a volume for persistence.
ENV DB_PATH=/app/data/five-stack.db
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=3000
EXPOSE 3000
RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
