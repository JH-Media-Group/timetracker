# syntax=docker/dockerfile:1.7
#
# Tally, production image. One image, three commands (BACKEND_PRD §17.0).
#
#   node server.js          the web process
#   node ops/migrate.mjs    migrations, run before the new containers start
#   node ops/recurring.mjs  the daily recurring-invoice job, from cron
#
# Web and jobs share the image deliberately, so a job can never run against a
# different build of the code than the one serving traffic.
#
# TWO DELIBERATE DEVIATIONS FROM §17.1, both recorded in §17.0:
#
# 1. `node:22-bookworm-slim`, not `node:22-alpine`. `@node-rs/argon2` is a
#    native Rust binding shipped as prebuilt per-platform binaries. The glibc
#    build is the well-trodden one; musl works but is the variant that breaks
#    quietly, and password hashing is not a thing to discover is broken in
#    production.
#
# 2. There is no `worker` stage, because there is no worker. §17.1 specifies a
#    BullMQ worker running `worker.js`; that queue was never built. Scheduled
#    work is cron calling `ops/recurring.mjs`, which takes a row lock and is
#    safe to run twice.

# ---------------------------------------------------------------- base
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- deps
# Its own stage so a change to application code does not reinstall anything.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# A build must not silently produce a different app than the source describes.
RUN pnpm typecheck
RUN pnpm build

# Compile the operational scripts to plain JavaScript.
#
# They are TypeScript run through tsx, and tsx is a devDependency. Shipping it
# into the runtime image to run two scripts would drag the whole dev toolchain
# with it. esbuild is already present (tsx depends on it), so the scripts get
# bundled here instead and the runtime needs nothing but node.
#
# argon2 stays external because it is a native binary that cannot be bundled;
# it is resolved from the traced node_modules at runtime.
# ESM, because both scripts use top-level await and CommonJS cannot express it.
#
# dotenv is aliased to a stub rather than bundled. It is CommonJS, its internal
# `require("fs")` becomes an unsupported dynamic require inside an ESM bundle,
# and it is a devDependency that the traced production node_modules does not
# carry anyway. See docker/dotenv-stub.mjs for the whole story.
RUN node_modules/.bin/esbuild \
      src/server/db/migrate.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:@node-rs/argon2 \
      --alias:dotenv=./docker/dotenv-stub.mjs \
      --outfile=ops/migrate.mjs \
 && node_modules/.bin/esbuild \
      scripts/recurring.mts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:@node-rs/argon2 \
      --alias:dotenv=./docker/dotenv-stub.mjs \
      --outfile=ops/recurring.mjs

# ---------------------------------------------------------------- runner
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app

# Runs as a non-root user. `node` already exists in the base image as uid 1000.
RUN mkdir -p /app && chown node:node /app
USER node

# `standalone` carries server.js and only the node_modules actually reached.
# Static assets and public/ are not traced into it and are copied separately.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/ops ./ops

# The migration runner reads the SQL files at runtime rather than embedding
# them, so they have to travel with the image.
COPY --from=build --chown=node:node /app/drizzle ./drizzle

EXPOSE 3000

# Liveness only. This must not reach Postgres: an unhealthy container gets
# replaced, and replacing a web process because the database blinked fixes
# nothing and turns an outage into a restart loop. Readiness is a separate
# endpoint that the deploy pipeline polls.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
