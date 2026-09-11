ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist ./dist
# Numeric, not a name. Kubernetes refuses to start a container under runAsNonRoot when the
# image's user is a name it cannot resolve, and the pod sits in CreateContainerConfigError
# saying so -- which is where an operator-built bot pod ended up the first time one ran.
USER 1000
EXPOSE 8080
# Liveness only. Readiness is /readyz, which also wants a link to mcp-server, and a bot waiting
# for the server to come back is healthy even though it is not ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/main.js"]
