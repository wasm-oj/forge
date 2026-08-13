FROM node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS build

RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/browser/package.json ./packages/browser/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/organizer/package.json ./packages/organizer/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/toolchain-clang/package.json ./packages/toolchain-clang/package.json
COPY packages/toolchain-rust/package.json ./packages/toolchain-rust/package.json
COPY packages/toolchain-python/package.json ./packages/toolchain-python/package.json
COPY packages/toolchain-javascript/package.json ./packages/toolchain-javascript/package.json
COPY packages/toolchain-go/package.json ./packages/toolchain-go/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN generated_package_state="$(find packages -type d \( -name dist -o -name tmp -o -name '.wasm-oj-build-*' \) -print)" \
  && if [ -n "$generated_package_state" ]; then \
      printf 'Generated package state entered the judge build context:\n%s\n' "$generated_package_state" >&2; \
      exit 1; \
    fi \
  && temporary_package_links="$(find packages -type l -lname '*/tmp/*' -print)" \
  && if [ -n "$temporary_package_links" ]; then \
      printf 'Host-temporary package symlink entered the judge build context:\n%s\n' "$temporary_package_links" >&2; \
      exit 1; \
    fi
RUN pnpm run library:build \
  && pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false

FROM rust:1.97.1-bookworm@sha256:14bc9c5966e7b3a385794b3d5389a8765668342025fbcc7b2e3d2866ac4bd8c3 AS runtime-build

WORKDIR /src
COPY crates/runtime-core ./crates/runtime-core
COPY vendor ./vendor
RUN cargo build --locked --manifest-path crates/runtime-core/Cargo.toml --release --bins

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS judge

ARG WASM_OJ_RELEASE_ID
ARG WASM_OJ_GIT_COMMIT

RUN corepack enable \
  && useradd --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --uid 10001 wasmoj
WORKDIR /app
COPY --from=build /src/package.json /src/pnpm-lock.yaml ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/public/toolchains ./public/toolchains
COPY --from=runtime-build /src/crates/runtime-core/target/release/wasm-oj-compiler /app/runtime/wasm-oj-compiler
COPY --from=runtime-build /src/crates/runtime-core/target/release/wasm-oj-runner /app/runtime/wasm-oj-runner
COPY --from=build /src/container/server.mjs ./container/server.mjs
COPY --from=build /src/container/identity.mjs ./container/identity.mjs
COPY --from=build /src/container/generate-identity.mjs ./container/generate-identity.mjs
COPY --from=build /src/container/tree-digest.mjs ./container/tree-digest.mjs
COPY --from=build /src/container/submission-result.mjs ./container/submission-result.mjs
COPY --from=build /src/container/progress.mjs ./container/progress.mjs
COPY --from=build /src/container/runtime-smoke.mjs ./container/runtime-smoke.mjs

RUN mkdir -p /app/release \
  && chmod 0555 /app/runtime/wasm-oj-compiler /app/runtime/wasm-oj-runner \
  && chmod 0444 /app/container/server.mjs /app/container/identity.mjs /app/container/generate-identity.mjs /app/container/tree-digest.mjs /app/container/submission-result.mjs /app/container/progress.mjs /app/container/runtime-smoke.mjs \
  && chmod -R a+rX /app \
  && chmod -R a-w /app \
  && chmod u+w /app/release \
  && WASM_OJ_RELEASE_ID="$WASM_OJ_RELEASE_ID" \
    WASM_OJ_GIT_COMMIT="$WASM_OJ_GIT_COMMIT" \
    node /app/container/generate-identity.mjs \
  && chmod a-w /app/release /app/release/container-identity.json \
  && runuser -u wasmoj -- env HOME=/tmp NODE_ENV=production node --input-type=module -e "const dependencies = ['@wasm-oj/core', '@wasm-oj/server', '@wasm-oj/toolchain-clang', '@wasm-oj/toolchain-go', '@wasm-oj/toolchain-javascript', '@wasm-oj/toolchain-python', '@wasm-oj/toolchain-rust']; await Promise.all(dependencies.map((dependency) => import(dependency))); const { loadEmbeddedContainerIdentity } = await import('/app/container/identity.mjs'); await loadEmbeddedContainerIdentity();" \
  && runuser -u wasmoj -- env HOME=/tmp NODE_ENV=production node /app/container/runtime-smoke.mjs \
  && runuser -u wasmoj -- env HOME=/tmp NODE_ENV=production node -e "const fs=require('node:fs/promises');const targets=['/app/release/container-identity.json','/app/runtime/wasm-oj-compiler','/app/runtime/wasm-oj-runner'];Promise.all(targets.flatMap((p)=>[fs.access(p,2).then(()=>{throw new Error('wasmoj can write '+p)},()=>{}),fs.unlink(p).then(()=>{throw new Error('wasmoj can delete '+p)},(error)=>{if(!['EACCES','EPERM'].includes(error.code))throw error})])).catch((error)=>{console.error(error);process.exit(1)})"
USER wasmoj
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 8080
CMD ["node", "/app/container/server.mjs"]
