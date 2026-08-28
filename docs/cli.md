# `woj` command-line journey

`woj` is the Student and Organizer CLI. Local commands remain network-free; remote commands use
browser-assisted authorization and store tokens only in the operating-system credential store.

## Student journey

```sh
woj auth login
woj problem list --locale zh-TW
woj problem pull <problem-id> ./solution --language python
cd ./solution
woj build
woj test
woj submit --wait
woj submission show <submission-id>
```

A pulled workspace pins `problemId`, `catalogCommit`, public bundle digest, language/profile, entry
file, and visible sources. Official Submit repeats the stable problem ID and exact commit; the
server rejects a stale workspace with `409 problem-revision-stale`. `run` and `test` are local and
make no official correctness claim.

Contest reads use stable contest IDs. A contest pull also pins the current `timelineGeneration`,
`ruleEpoch`, and `problemEpoch`; `woj submit` sends those values in a discriminated contest context
and refuses a mismatched `--contest`. It does not reconstruct reveal state from wall-clock fields.
Invite codes are read from bounded, non-symlink files through `--code-file`; they are never
command-line values.

```sh
woj contest list
woj contest show <contest-id>
woj contest join <public-contest-id>
woj contest join <invite-contest-id> --code-file ./invite-code.txt
woj contest problems <contest-id>
woj problem pull <problem-id> ./solution --contest <contest-id> --language rust
cd ./solution
woj submit --contest <contest-id> --wait
woj contest standings <contest-id>
```

Prompt Program admission is a distinct prompt-attempt API and is not represented as a CLI
`--language`. A host without the pinned compiler reports `promptCompilerAvailable: false` and typed
`503 prompt-compiler-unavailable` before consuming quota.

## Local judge and authoring

```sh
woj judge inspect ./problem.wasmojjudge
woj judge verify ./problem.wasmojjudge
woj organizer collection init .
woj organizer collection build .
woj organizer collection verify .
```

Collection build/verify checks repository manifests, public projection relationships, digests,
redaction, and `WOJJDG02` deployability. It does not compile or execute reference solutions.
`collection/contests.json` is strict `wasm-oj-platform/contests/v2`. Authoring source may use the
`classic-score`, `icpc`, `blitz-batches`, or `prompt-five-by-three` preset; `build` expands it to
canonical typed rules and `verify` rejects repository v1 or a surviving preset.

## Remote Organizer journey

```sh
woj organizer repo list
woj organizer catalog connect --repo <numeric-repository-id>
woj organizer catalog sync <catalog-id> --ref <branch-tag-or-commit> --wait
woj organizer catalog show <catalog-id>
woj organizer contest list
woj organizer contest participants <contest-id>
woj organizer contest invite-rotate <contest-id> --code-file ./new-code.txt
woj organizer rejudge start <problem-id> \
  --from <40-character-commit> --to <40-character-commit> --wait
```

The sync command resolves the requested ref once and watches the resulting exact-commit job.
Repository files own contest creation, metadata, status, problem membership, schedule, scoring,
checkpoints, limits, and ordering. Entrant join/start state remains operational D1 data. The CLI
offers no platform-side rule editor or multi-stage catalog lifecycle commands. Invite rotation,
entrant inspection, standings, and commit-to-commit manual rejudge remain operational commands;
pause, resume, rule activation, and whole-contest rewind are explicit Organizer UI/API operations.

For public GitHub repositories, staged problem timing is a UI reveal boundary only. The repository
may expose files early, and the CLI/Organizer projection must not describe them as secret.

## Stable process outcomes

| Exit | Meaning |
| ---: | --- |
| `0` | Success |
| `1` | Waited work completed unsuccessfully |
| `2` | Usage error |
| `3` | Authentication or authorization failure |
| `4` | Contract, digest, or judge-package failure |
| `5` | Conflict or stale resource |
| `6` | Network or platform infrastructure failure |
| `7` | Local cache, runtime, or toolchain integrity failure |

Use `--json` for machine-readable output and `woj completion bash`, `zsh`, or `fish` for shell
completion.
