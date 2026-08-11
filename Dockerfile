FROM node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS build

RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run library:build \
  && pnpm prune --prod

FROM rust:1.97.1-bookworm@sha256:14bc9c5966e7b3a385794b3d5389a8765668342025fbcc7b2e3d2866ac4bd8c3 AS runtime-build

WORKDIR /src
COPY crates/runtime-core ./crates/runtime-core
COPY vendor ./vendor
RUN cargo build --locked --manifest-path crates/runtime-core/Cargo.toml --release --bins

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS judge

ARG FORGE_RELEASE_ID
ARG FORGE_GIT_COMMIT

RUN corepack enable \
  && useradd --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --uid 10001 forge
WORKDIR /app
COPY --from=build /src/package.json /src/pnpm-lock.yaml ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/lib ./lib
COPY --from=build /src/public/toolchains ./public/toolchains
COPY --from=runtime-build /src/crates/runtime-core/target/release/forge-compiler /app/runtime/forge-compiler
COPY --from=runtime-build /src/crates/runtime-core/target/release/forge-runner /app/runtime/forge-runner
COPY --from=build /src/container/server.mjs ./container/server.mjs
COPY --from=build /src/container/identity.mjs ./container/identity.mjs
COPY --from=build /src/container/generate-identity.mjs ./container/generate-identity.mjs
COPY --from=build /src/container/tree-digest.mjs ./container/tree-digest.mjs
COPY --from=build /src/container/submission-result.mjs ./container/submission-result.mjs
COPY --from=build /src/container/output-budget.mjs ./container/output-budget.mjs
COPY --from=build /src/container/github-archive.mjs ./container/github-archive.mjs

RUN mkdir -p /app/release \
  && chmod 0555 /app/runtime/forge-compiler /app/runtime/forge-runner \
  && chmod 0444 /app/container/server.mjs /app/container/identity.mjs /app/container/generate-identity.mjs /app/container/tree-digest.mjs /app/container/submission-result.mjs /app/container/output-budget.mjs /app/container/github-archive.mjs \
  && chmod -R a-w /app \
  && chmod u+w /app/release \
  && FORGE_RELEASE_ID="$FORGE_RELEASE_ID" \
    FORGE_GIT_COMMIT="$FORGE_GIT_COMMIT" \
    node /app/container/generate-identity.mjs \
  && chmod a-w /app/release /app/release/container-identity.json \
  && node -e "import('/app/container/identity.mjs').then(async m => { await m.loadEmbeddedContainerIdentity(); })" \
  && runuser -u forge -- node -e "const fs=require('node:fs/promises');const targets=['/app/release/container-identity.json','/app/runtime/forge-compiler','/app/runtime/forge-runner'];Promise.all(targets.flatMap((p)=>[fs.access(p,2).then(()=>{throw new Error('forge can write '+p)},()=>{}),fs.unlink(p).then(()=>{throw new Error('forge can delete '+p)},(error)=>{if(!['EACCES','EPERM'].includes(error.code))throw error})])).catch((error)=>{console.error(error);process.exit(1)})"
USER forge
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 8080
CMD ["node", "/app/container/server.mjs"]
