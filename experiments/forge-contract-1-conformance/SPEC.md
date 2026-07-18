# Forge contract 1 conformance and efficiency matrix

## Claim

Every declared language and target compiles and executes through the same
Forge contract on browser and server hosts. Repeated uncached builds produce
the same canonical artifact bytes, and repeated runs produce identical
deterministic transcripts including virtual-clock metrics and termination.

## Preregistered panel

The default panel contains the declared C, C++, Rust, Python, JavaScript,
TypeScript, and standard Go profiles plus deterministic filesystem, multi-file,
transactional VFS-quota, and denied WASIX capability probes. Each case builds
twice and runs three times. The opt-in full panel adds the header-heavy C++ case
whose canonical header selects the digest-pinned debug/release libc++ PCH.

Contract 1 includes dedicated clock probes to establish that:

- relative and absolute clock waits fast-forward virtual time without host wait;
- a ready fd wins a mixed fd/clock poll without advancing virtual time;
- language-level sleep and clock observations share the same deterministic
  timeline; and
- exceeding `logicalTimeLimitMs` produces `logical-time-limit`, independently
  of the emergency wall deadline.

Artifact IDs and measured compile/run durations are host observations and are
excluded from compatibility. Artifact digests, executable payloads, exit code,
stdout, stderr, files, termination, deterministic configuration, resources,
and execution metrics are contract data.

## Command and evidence

```sh
pnpm run conformance:server
pnpm run conformance:browser
pnpm run conformance:compare <server-record.json> <browser-record.json>
```

Every attempt writes append-only evidence to `runs/raw/records/` and binds the
snapshot to this spec hash, Forge contract, command, host, and exact source-tree
digest. Browser collection permits HTTP(S) only to the exact loopback origin
and records every request decision. Publication writes the canonical matrix
only when all browser/server transcripts and artifact digests agree.
