# `@wasm-oj/sdk`

Lightweight convenience entrypoints for the WASM-OJ SDK. The root entrypoint exposes
`@wasm-oj/core`; host and Organizer APIs are available from `/browser`, `/server`, and
`/organizer`. Compiler toolchains are deliberately separate packages and are never installed by
this package.
