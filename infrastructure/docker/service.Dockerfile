FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web/scripts apps/web/scripts
COPY packages/execution-sdk/package.json packages/execution-sdk/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec tsc && pnpm --dir packages/execution-sdk build
ENV NODE_ENV=production
USER node
CMD ["node","dist/apps/api/src/index.js"]
