# Caller wakes and command shorthand (1.1.0)

A subagent can start a durable run and receive its result after ending its current turn:

```sh
pi-durable-subagents run --request build-42 --wake caller -- npm test
```

The command runs as a durable command call. It keeps running after the calling subagent's turn ends and through orchestrator restarts. When its workflow ends, dsa sends the caller a follow-up containing the workflow status, each call's status and duration, command exit code or signal when available, and a bounded output tail. The first line is:

```text
Durable run build-42 (<wid>) that you started with --wake caller finished: done.
```

An agent result never gets an invented command exit code. The message lists at most 20 calls (then `… N more`) and has at most 4000 characters; when output does not fit, its earlier part is removed. Full output remains available through `describe` and `status`.

`--wake` accepts only `caller`, and requires `DSA_CALL`, which dsa supplies inside a subagent call. Outside a call, it refuses before submitting anything:

```text
--wake caller needs DSA_CALL: run it from inside a subagent call
```

The main-session `subagents` tool has no wake option. A caller must be an agent call in an existing, unpruned workflow's current revision. A command call cannot receive a wake. Invalid callers are rejected with a reason beginning `wake caller: `, without creating a workflow.

The follow-up uses the existing send rules: a sealed caller opens a new generation, a running caller gets a forwarded follow-up, and an undelivered follow-up opens a generation after that turn seals. Holds, pinned inputs and revision currency apply normally. A caller stopped before delivery is recorded as `skipped` with reason `caller stopped`. A pruned or retired caller, or broken pinned inputs, can cause a durable rejection. Skips and rejections are final. Every `workflow-done` entry of the wake run has its own deterministic wake id; retries and crash recovery reuse its first decision. The run's ordinary finished attention to its CLI origin is unchanged.

Use a unique `--request` id for each distinct operation. Repeating the same id with the same content returns its existing outcome. The stored `RunBody.wake` is `{ "to": "<wid>/<key>" }` and participates in the spec digest. `RunBody.caller` records the full `DSA_CALL` as provenance and is excluded from the digest, so retrying from another generation of the same caller retains the request identity. Requests without wake retain their existing digests.

Both run forms support caller wakes:

```text
run --request <id> [--wake caller] --spec <file|-> [--cwd <dir>] [--labels <json>] [--session <id>] [--json] [--wait-ms <n>]
run --request <id> [--wake caller] [--cwd <dir>] [--timeout-ms <n>] [--name <text>] [--labels <json>] [--session <id>] [--json] [--wait-ms <n>] -- <program> [args…]
```

The argv form submits `{command: [program, ...args], timeoutMs?, name?}` through the same normalizer as a JSON spec. Arguments after `--` are literal arguments; shell expansion requires explicitly invoking a shell, for example `-- sh -c 'make && make test'`. `--spec` and `--` are mutually exclusive. `--timeout-ms` (a positive integer of milliseconds) and `--name` require the argv form. `--cwd` follows the existing run rule and resolves relative to the CLI's working directory. Labels, session display, JSON output, request conflicts, wait times and exit codes follow the existing request-id interface.

`describe --key <run id>` and `describe <wid>` expose top-level wake progress:

```json
{"wake":{"to":"<wid>/<key>","state":"applied","rev":1,"generation":2}}
```

`state` is `pending`, `applied`, `skipped` or `rejected`. A known completion revision and delivery generation appear as `rev` and `generation`; a skip or refusal includes `reason`. The completion revision counts `workflow-done` entries, matching the run's `finished:<wid>` attention revision. A wake run with pending delivery cannot be pruned (`wake pending`) and does not enter the lazy settled shortcut. A prune after delivery retains the wake receipt in its tombstone.

Each described caller call, and each call in `status <wid> --json`, can include:

```json
{"awaiting":[{"request":"build-42","wid":"<command workflow>","state":"running"}]}
```

`pending` means the run was admitted but has no workflow yet; `running` means its workflow has not ended; `finished` means it ended but its wake is undecided. Entries are ordered by admission, limited to the caller's current revision, and disappear after the latest wake is decided. The field is absent when empty. The reader indexes wake runs by caller address in the orchestrator ledger and reads only matching run journals.

A sealed described call also includes `sealedAt`, the millisecond timestamp of the seal of its latest generation. An unsealed generation omits it. After a follow-up opens a new generation, it stays absent until that generation seals, then reports the new seal's timestamp.

`pi-durable-subagents version` and `pi-durable-subagents --version` print `pi-durable-subagents <package version>` and exit successfully.

When the executor records processes it sent SIGKILL to at an agent call's seal, `describe` shows `endedAtSeal: [{pid, command}]` on that call's latest generation. Entries are concatenated in journal order, capped at 20; `endedAtSealMore` counts the remainder, including any unlisted processes recorded by the executor. These fields are absent when nothing was recorded. A record means dsa sent SIGKILL, not proof that the signal caused the process's death. This projection accepts the executor's journal entries and ignores unrelated future entry types.

Caller wakes require a 1.1.0 orchestrator. After upgrading the installed CLI to 1.1.0, restart a still-running 1.0.45 orchestrator before submitting a new wake run: the CLI refuses with `the running orchestrator 1.0.45 predates run --wake (new in 1.1.0)` and restart guidance, before recording anything. This uses the existing version check: the running orchestrator must predate both 1.1.0 and the CLI's loaded version to be refused. Retrying an already recorded request retains its first outcome; a matching version or no running orchestrator passes (the next orchestrator starts on the installed version). They do not add delivery guarantees beyond the existing follow-up mechanism: storage and an available orchestrator are required, a stop or retired revision can prevent delivery, and a held caller waits for resume. The normal platform containment limits still apply.

Existing tests changed: none. New regression coverage is in `test/unit/orchestrator/engine/wake.test.ts`, `test/unit/cli/wake.test.ts`, and `test/pi/e2e/wake.test.ts`.
