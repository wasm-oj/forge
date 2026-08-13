# `woj` command-line journey

`woj` is the single Student and Organizer command-line interface. It uses the same product
boundaries as the web application while making immutable IDs, exact commits, resumable work, and
process outcomes explicit.

## Install and authorize

```sh
pnpm add -D @wasm-oj/cli
pnpm exec woj auth login
pnpm exec woj auth status
```

Login creates a short-lived browser approval flow. The browser approves the currently signed-in
account; the CLI exchanges its verifier once and stores the resulting token in the operating
system credential store. Roles are resolved by the server on every request. There is no plaintext
token-file fallback. `woj auth logout` revokes the server token and removes the local credential.

## Student journey

```sh
woj problem list --locale zh-TW
woj problem pull <problem-version-id> ./solution --language python
cd ./solution
woj build
woj run --input input.txt
woj run --text $'1 2\n'
woj test --case sample-2
woj submit --wait
woj submission show <submission-id>
woj submission policy <submission-id>
woj contest join <contest-id> --code-file ./invite-code.txt
```

The pulled workspace pins the server origin, immutable problem version, public bundle digest,
language/profile, entry file, and visible source files. `run` only reports a local execution result;
it never claims correctness. `test` runs public samples only. `submit` creates an Official Submit
against immutable server-side judge data. If the platform requires a Turnstile check, `woj` opens
the same-origin browser verification page and retries the identical submission request after the
short-lived allowance is granted.

Student resources are available through `problem`, `submission`, `contest`, and `performance`.
Submission creation returns its exact ID; `--wait` watches that same resource, while
`submission watch` can resume it later.
Invite secrets are accepted only through bounded, non-symlink UTF-8 files (`--code-file`), never
as command-line values that would remain in shell history or the process list.

## Local judge and toolchains

```sh
woj toolchain list
woj toolchain fetch python
woj toolchain verify python
woj judge inspect ./problem.wasmojjudge
woj judge verify ./problem.wasmojjudge
woj judge execute ./problem.wasmojjudge --source ./solution --all
```

Toolchain acquisition is always an explicit `toolchain fetch`. Build, run, test, bench, watch,
judge inspection/verification/execution, collection build/verify, config, cache, and doctor are
local boundaries. `--offline` rejects every remote or acquisition command before dispatch.
Students never receive hidden judge packages from the platform.

## Organizer collection journey

```sh
woj organizer collection init .
woj organizer collection build .
woj organizer collection verify .
woj organizer repo list
woj organizer collection create --repo <numeric-repository-id> --index collection-v2/index.json
woj organizer collection validate <collection-id> --ref <branch-tag-or-commit> --wait
woj organizer collection publish <revision-id> --mode official-practice --wait
woj organizer collection activate <publication-id>
```

`build` and `verify` are deterministic local preflight. Remote `validate` resolves the requested
ref once, displays the exact commit, and performs only schema/path/size/digest/redaction/package
checks. It never compiles or executes a reference solution. Publish materializes an immutable
revision; official-practice activation remains a separate confirmation. Existing work is resumable
through its exact validation ID or publication-job ID. Activation instead uses the durable
immutable publication ID returned by a successful publication job.

Organizer contest commands preserve the web application's draft-before-publish model and expose
exact contest IDs, problem-version IDs, participants, standings, and archive state. Organizer
rejudge commands separate endpoint discovery, batch creation, watch, and cancellation so a lost
terminal can reattach to the same immutable batch.
Invite contest creation and updates use `--invite-code-file`; secret-valued `--invite-code`
arguments are intentionally unsupported.

## Stable process outcomes

| Exit | Meaning |
| ---: | --- |
| `0` | Command succeeded, or a read-only show command returned a terminal resource |
| `1` | A waited execution or asynchronous job completed unsuccessfully |
| `2` | Usage or argument error |
| `3` | Authentication or authorization failure |
| `4` | Schema, digest, judge-package, or static validation failure |
| `5` | Resource conflict or illegal state transition |
| `6` | Network or platform infrastructure failure |
| `7` | Local cache, runtime, or toolchain integrity failure |

Use `--json` for machine-readable output. Human output uses full immutable identifiers rather than
short aliases. Use `woj completion bash`, `zsh`, or `fish` for shell completion.
