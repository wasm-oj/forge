# `@wasm-oj/cli`

`woj` is the single local-first command-line interface for WASM-OJ. Local build,
run, test, benchmark, and judge commands never use the network. Student and
Organizer commands address explicit immutable resources on the configured
server. `--offline` rejects every network-capable command before dispatch.

```sh
woj config set server https://example.invalid
woj auth login
woj problem pull <problem-version-id> --language cpp --locale zh-TW
woj test
woj submit --wait
```

Run `woj --help` to see the complete role-based command tree.

`woj organizer collection build` materializes strict
`wasm-oj-platform/contests/v2` manifests. Contest workspaces pin timeline, rule, and problem epoch
tokens and send them through the contest Official Submit context; Prompt Program is a separate
prompt-attempt workflow, not a compiler language.
