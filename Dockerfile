# Chog Toolhub — production image: the API server also serves the built web app.
# Build:  docker build -t chog-toolhub .
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w @chog/server && npm run build -w @chog/web

FROM node:24-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --ignore-scripts -w @chog/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
