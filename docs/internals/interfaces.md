# Internal interfaces and module map

This is the contract that parallel implementers code against. Shared types live
in `src/types.ts`. Changing that file, or the behaviour described here, needs
parent approval.

The normative design is in the private `design/` directory of the main
checkout: `principles.md` (axioms A1–A5, guards V1–V8, contracts C1–C12) and
`spec.md` (policies P1–P38, parameters K1–K11). Section and policy numbers
below refer to those documents.

## Ground rules for every module

- **Language and tooling.** TypeScript using only erasable syntax: no enums,
  no namespaces, no parameter properties. Node ≥ 22.18 runs `.ts` directly in
  tests. Import with explicit `.ts` extensions.
- **pi imports.** pi packages may be imported only through their root exports
  (`npm run lint:imports`). Do not use the SDK's `createAgentSession`.
- **No new runtime dependencies** without parent approval.
- **Isolation in tests.** Tests never touch `~/.pi`. Use `test/harness/pi.ts`,
  which gives each pi its own config dir with the faux provider, and temp
  directories for `DSA_HOME`.
- **Durability.** Every durable write goes through `src/kernel/` (framed
  journal appends; no-replace file publication).
- **Done means.** `npm run typecheck`, `npm run lint:imports`, and the
  module's own tests all pass.

## Module map and ownership

| Module | Path | Owner | Depends on |
|---|---|---|---|
| Shared types | `src/types.ts` | parent | — |
| Kernel: journal, ids, mailbox, lifecycle, guards | `src/kernel/` | wave 1 · K1 | types |
| Platform: lock, process table, containment | `src/platform/` | wave 1 · P1 | types |
| Evaluator host: sandbox, runs API, scheduler | `src/evaluator/` | wave 1 · E1 | types |
| Compat: agents, model strings, fan-out, results | `src/compat/` | wave 1 · A1 | types |
| Child session agent | `src/agent/child.ts`, `src/agent/extension.ts` | wave 2 | kernel |
| Main session agent: tool, outbox, attention, starter | `src/agent/main.ts` | wave 2 | kernel |
| Orchestrator | `src/orchestrator/` | wave 2–3 | kernel, platform, evaluator, compat |
| UI: list and watch | `src/ui/` | wave 3 | agent |
| CLI: chaos, smoke, tail, resume, drain, stop-all | `src/cli/` | wave 3 | all |

## Wave 1 contracts

### K1 · Kernel (`src/kernel/`)

**`journal.ts`** (A1, C11)

- `openJournal(path): Promise<JournalHandle>` (see `types.ts`).
- On-disk line format: `<crc32 as 8 lowercase hex> <json>\n`. The JSON
  carries `seq` (dense, starting at 1), `ts` and `type`.
- On open, a torn or CRC-mismatched **tail** is truncated, and the file is
  `fsync`ed after truncation. A bad line anywhere other than the tail is an
  error (corruption): throw. Do not silently skip it.
- `append` writes one line, calls `fsync` on the file, and resolves only after
  that. When it creates the file, it also `fsync`s the directory.
- Appends from one process are serialised internally. Exclusion across
  processes is the caller's job (the orchestrator lock).
- Also provide `readJournalSnapshot(path): Entry[]`. It is used by other
  domains, which only read; it tolerates a torn tail and never writes.

**`ids.ts`**

- `ulid()`: monotonic within a process.
- `contentHash(obj)`: sha256 over a canonical JSON encoding (sorted keys).
- `forwardRid(rid, widRev, key, hash)`: deterministic, per P7.

**`mailbox.ts`** (P3, P38, C11)

- `publishRequest(inboxDir, req)` writes a temp file, `fsync`s it, `link`s it
  to `<rid>.json` (failing if the name exists), then `fsync`s the directory.
  If the target already exists with identical content, it returns
  `"exists-identical"`. If the content differs, it returns `"conflict"`.
- `scanInbox(inboxDir): Request[]` returns the parsed requests, skipping temp
  files and files that fail to parse (it reports them instead).
- `Outbox` is a sender-side durable record, stored as a journal under
  `outbox/<senderId>.jsonl`. It provides:
  - `send(to, kind, body, cond)`: assigns the next `sseq` for `(from, to)`,
    persists the envelope, publishes it, and returns the `Request`;
  - `republishPending()`: republishes anything not yet observed as resolved;
  - `markResolved(rid)`: called once a durable terminal resolution has been
    observed; deletion is a log entry.
- The `sseq` high-water mark must survive the deletion of entries.

**`lifecycle.ts`** (A3, A4/V5, P5, P6) is a pure, I/O-free core shared by the
orchestrator and the session agents.

- **State.** It is rebuilt from committed decision records: `admitted{rid,
  from, sseq, hash, kind}`, `applied{rid}`, `rejected{rid, reason}` and
  `withdrawn{rids}`.
- **Admission.** Given candidate requests in any order, admit each sender's
  requests in strict `sseq` order, and hold when there is a gap. A duplicate
  `rid` with the same hash is a no-op. A duplicate `rid` with a different
  hash is rejected as `identity-conflict`, and the original stays bound.
- **Consideration.** Admitted, unresolved requests are considered in
  admission order:
  - `withdraw` is resolved immediately. Its pending targets are rejected as
    `withdrawn`, unseen targets get tombstones, and already-applied targets
    are unchanged.
  - A request whose rid has a tombstone is rejected as `withdrawn`.
  - `after: r`:
    - `r` was not admitted earlier → rejected as `malformed`;
    - `r` is not yet resolved → deferred;
    - `r` is resolved, whether applied or rejected → the condition is met.
  - All other requests go to a recipient-supplied
    `decide(req, view) → apply | reject(reason) | defer`, which implements
    V3/V4 and the domain logic.
- **Output.** It returns the list of decision records to commit, in order. It
  never performs effects.
- **Determinism.** The same inputs always produce the same decisions. Property
  tests must cover random arrival orders.

**`guards.ts`** (A4) contains pure predicates over `(state, transition)`:

- V1: capacity and headroom;
- V2: seal;
- V3: currency;
- V4: openness, including the hibernated case;
- V5: dependency (also used by the lifecycle);
- V6: monotone time;
- V7: single presentation;
- V8: budgets, with two levels.

Each predicate needs unit tests, and each test case must include a mutant
check: the guard removed means the test fails.

### P1 · Platform (`src/platform/`)

**`proctable.ts`** (C2)

- `ProcessTable.list()` returns pid, ppid, start token, `DSA_EXEC` tag and CPU
  time.
  - Linux: `/proc`. Read `environ` only for pids not seen before, using a
    cache keyed by `(pid, start)`.
  - macOS: `ps -E -o pid=,ppid=,lstart=,time=,command=` (or `sysctl
    KERN_PROCARGS2`). Parse the environment carefully.
- Unsupported platforms throw a clear capability error.

**`containment.ts`** (P22, P23, C1, C3)

- `spawn`: direct `child_process.spawn` with `DSA_EXEC` injected and stdio
  pipes. Record `(pid, start)` immediately.
- `scan(known)`: an execution's processes are those tagged with its exec, plus
  descendants of any of its known processes (by ppid chain), in each case
  identified by `(pid, start)`.
- `fence(exec, tracked)`: SIGKILL every live process that is tagged or
  tracked. Repeat scan-and-kill until both sets are empty. Bounded by a
  timeout, after which it rejects.
- **Required test:** a child that runs `setsid sleep` and is then SIGKILLed is
  still fenced by its tag. A tracked process that has cleared its tag is still
  fenced by its `(pid, start)` record.

**`lock.ts`** (C4)

- `OsLock.tryAcquire(path)` must be released by the OS when the holder dies,
  and must be non-blocking.
- No native addons. Suggested approach: a tiny long-lived helper process that
  holds `flock(2)` and exits when its stdin closes. Use `perl` (Fcntl) when it
  is available, with `python3` as the fallback. If neither is available, fail
  with a capability error.
- **Required test:** SIGKILL the holder, after which a new process can
  acquire the lock. Two concurrent acquirers: exactly one succeeds.

### E1 · Evaluator host (`src/evaluator/`) (P10, P11)

**Process.** `node <dist>/evaluator/host.js` speaks JSON lines on
stdin/stdout, using `OrchToEval` and `EvalToOrch` from `types.ts`. It runs one
`worker_threads` worker per workflow, with `resourceLimits` set.

**Sandbox.** Inside each worker, the script runs in a `node:vm` context. The
only globals are:

- `runs`: `run(key, spec)` and `all([{key, ...spec}])`;
- `emit(value)`;
- `args`, deep-frozen;
- `now()`, `random()`;
- `runs.input(name)`;
- `Promise`, standard built-ins and `console`, which is captured and emitted
  as a log.

There is no `require` or `import`, no `process`, no filesystem and no timers.
The script body is wrapped as an async function, so top-level `await` and
`return` work. Nested async functions are allowed. `runs.input(name)` returns
the content of the pinned file passed in `start.inputs`.

**Proposals.** Each `runs.run` emits `call{pos, key, spec}` and returns a
promise. That promise settles **only** when an `expose{pos}` for it arrives.
`runs.all` maps over `runs.run`.

**Exposure scheduler.** Exposures received from the orchestrator are applied
one per macrotask, in arrival order. The host settles a promise and then
yields until the microtask queue has drained before applying the next one.
The orchestrator sends exposures in journal order, so live runs and replays
behave the same.

**Values.** `now()` and `random()` return values supplied by the
orchestrator: the host sends `need{n}` and waits for `value{n}`. Because the
call is synchronous inside the script, the worker blocks with `Atomics.wait`
on a SharedArrayBuffer until the value arrives.

**Idle.** When the worker has no pending exposures and no runnable microtasks
while it is awaiting promises, it sends `idle` (the replay frontier signal).

**Finish and limits.** `done{result}` carries the script's return value.
`error{kind: script | limit}` reports a throw or an exceeded resource limit.

**Required tests.** Drive the host with a fake orchestrator in tests:

- the real `exec-template.js` shape (`Promise.race` over `runs.run(...).then`,
  mutable counters) produces **identical proposal sequences** across two runs
  fed the same exposure order;
- top-level `return`;
- `args` is frozen;
- `now()` and `random()` are recorded and replayed;
- an infinite loop hits the CPU limit and reports `error{limit}`.

### A1 · Compat (`src/compat/`) (P34, P35, compatibility mapping)

**`agents.ts`** discovers agent definitions with the same roots, precedence
and frontmatter as the pi-subagents 0.75.0 package installed at
`~/.pi/agent/npm/node_modules/pi-subagents/` (read its source and docs; do
not import it). It returns normalised definitions with: `name`,
`description`, `model`, `thinking`, `tools`, `skills`, `systemPromptMode`,
`inheritProjectContext`, `inheritSkills`, `defaultContext`, `body` (the
system prompt), and `source path`.

**`model.ts`** parses `provider/id[:thinking]`. It also resolves pools: a
model string that names a pool from the config. Thinking levels are `off`,
`minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

**`fanout.ts`** compiles `tasks: [...]` (parallel) and `chain: [...]`
(sequential; `{previous}` is replaced with the previous step's `output`; a
failed step stops the chain and seals the rest as `skipped`) into a workflow
script source with deterministic keys.

**`result.ts`** builds a `CallResult`. `output` is the full final text,
untruncated. When a schema report exists, `output` is the report's text form
followed by the original text, so that legacy final-line parsers still work.
`ok` is true iff `status === "ok"`.

**Pi invocation arguments.** Provide a function that maps a normalised agent
definition plus a `CallSpec` to the `pi --mode rpc` arguments: system prompt
file, tool allowlist, skills, and model/thinking for the first execution only
(C5: a continuation passes no `--model`). Check the flags against
`node_modules/.bin/pi --help`.
