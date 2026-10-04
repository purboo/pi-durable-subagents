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

## Wave 2 contracts

The kernel APIs are available from `src/kernel/`: `journal.ts`, `ids.ts`,
`mailbox.ts` (`publishRequest`, `scanInbox`, `Outbox`), `lifecycle.ts`
(`reduceLifecycle`, `planDecisions`, `DecisionRecord`) and `guards.ts`. Read
them before you start. Paths come from `src/paths.ts`. Entry types read
across domains are `CT` and `JT` in `src/types.ts`. The extension entry
`src/agent/extension.ts` is parent-owned: it calls `registerChild(pi)` when
`DSA_EXEC` is set and `registerMain(pi)` otherwise.

### C1 · Child session agent (`src/agent/child.ts`, plus helpers in `src/agent/child/`)

The child domain's log is its own pi session file (C5). Lifecycle records
map onto session entries as follows:

| Lifecycle record | Session entry |
|---|---|
| `admitted` | `custom` entry `CT.admitted` with `{rid, from, sseq, hash, kind}` |
| `applied` | the effect entry itself, carrying `rid` (see below) |
| `rejected` | `custom` entry `CT.rejected` with `{rid, reason}` |
| `withdrawn` | `custom` entry `CT.withdrawn` with `{rids}` |

How an applied request is recorded depends on its kind:

| Kind | Applied entry |
|---|---|
| `task`, `steer`, `continue` | `custom_message` entry `CT.msg`, with `details` `{rid, kind, from}`; the content is the text shown to the model |
| `model` | `custom` entry `CT.model` with `{rid, provider, model}`, after `pi.setModel` |
| `answer` | the `ask` tool result, whose `details` include `{rid, qid, rev}` |

To rebuild lifecycle state, read `ctx.sessionManager.getEntries()`.

**Environment.** The child reads `DSA_EXEC`, `DSA_CALL`, `DSA_INBOX`,
`DSA_JOURNAL` and optionally `DSA_SCHEMA`.

**Launch gate (P23).** At `session_start`, read a snapshot of the workflow
journal (`readJournalSnapshot`). The child is current only if:

- the last `JT.exec` entry for `DSA_CALL` is `DSA_EXEC`; and
- there is no `JT.fenced` entry for `DSA_EXEC`.

If it is current, append `custom` `CT.exec` `{exec}`. Otherwise do nothing
further and call `ctx.shutdown()`.

**Consumption points (C6).** All of them funnel through one in-process
queue:

- `session_start`;
- `turn_end` and `agent_before_settle`, which return
  `{entries: [custom_message…], continue: true}` when something is applied;
- an idle trigger: `fs.watch(DSA_INBOX)`, then, only if `ctx.isIdle()`,
  `pi.sendMessage(customMessage, {triggerTurn: true})`;
- inside `ask`.

At each point the child:

1. scans the inbox (`scanInbox`);
2. runs `planDecisions(records, candidates, decide)`;
3. writes the resulting records as session entries **in order**.

Inbox files are never deleted by the child.

**Domain decide.**

- `task`, `steer`, `continue` → apply.
- `model` → apply via `ctx.modelRegistry.find(provider, id)` then
  `pi.setModel`. If the model is not found, reject with `unknown-model`.
- `answer`:
  - apply only while `ask` is blocked on `cond.qid@cond.rev`;
  - defer if the question is open but not blocked;
  - reject `already-answered` if the question is closed.
- Any other kind → reject `unsupported`.

**`ask({question})` (P8).**

1. Append `CT.question` `{qid, rev, question}`. `qid` is stable per question
   text within the execution; `rev` starts at 1 and increments on re-ask.
2. Block, consuming through the queue:
   - a matching answer → the tool returns the answer text, with `details`
     `{rid, qid, rev}`;
   - a steer → the tool returns `{interrupted_by: "steer", open: qid}` plus
     the steer text, with `details` `{rid}`. The question stays open.
3. Honour the tool's abort signal.

**`report` (P24).** Register this tool only when `DSA_SCHEMA` is set.

1. Validate the payload against the JSON schema, using a small built-in
   validator that covers `type`, `required`, `properties`, `items`, `enum`
   and `additionalProperties`. No new dependencies.
2. If invalid, throw, so the model sees the errors.
3. Otherwise append `CT.report` `{exec, outcome, data}` and return
   `terminate: true` (C8).

**Tests (real pi via `test/harness/pi.ts`).** Start pi with `-e
src/agent/extension.ts` and the `DSA_*` environment set to temp paths. Use a
hand-written journal (written with kernel `openJournal`) and publish inbox
requests with kernel `publishRequest`. Cover:

- a task published before spawn starts a turn at boot;
- a steer published during a tool lands at `turn_end`;
- a restart on the same session file applies no duplicates;
- withdraw before delivery;
- `ask` + answer;
- `ask` interrupted by a steer;
- a model change takes effect on the next call (`message_start` model);
- a stale exec exits through the gate without writing anything;
- `report` with a schema terminates the run, and invalid payloads are
  rejected.

### M1 · Main session agent (`src/agent/main.ts`, plus helpers in `src/agent/main/`)

**Sender identity.** The sender id is `main:<pi session id>`. Requests go
through a kernel `Outbox` rooted at `outboxRoot(home)` to the orchestrator
inbox (`orchInbox(home)`). Call `republishPending()` at `session_start`.

**Tool `subagents` (P25 and the compatibility mapping).** Actions:

- `run`: `{workflow?: path, args?, tasks?, chain?, agent?, task?, model?, …CallSpec}`;
- `send`: `{to: callKey | CallId, kind: 'steer' | 'answer', message, qid?, rev?, replaces?: rid[]}`;
- `stop`;
- `revise`;
- `status`;
- `resume`;
- `drain`.

Notes on the actions:

- **`run`** waits up to 10 s for a `JT.created` entry with its `rid` in a
  snapshot of `orchLedger(home)`. It returns the `wid`, or `submitted{rid}`
  if the entry has not appeared.
- **`send` with `replaces`** publishes `withdraw{rids}` and then the new
  request with `after: <withdraw rid>` (AC2).
- **`status`** returns a fresh snapshot read from the journals: workflows
  whose origin is this session first, then the others.

**Starter (P1).** At `session_start`, before submitting, and every K1 (30 s):

1. If `orchLock(home)` is free (`OsLock.tryAcquire`, then release
   immediately) and there is pending work or a pending outbox, spawn the
   orchestrator detached: `process.execPath <orchestratorEntry>` with
   `DSA_HOME`.
2. `orchestratorEntry` is configurable through `DSA_ORCHESTRATOR_ENTRY`.
   The default is `src/orchestrator/main.ts`, or `dist/orchestrator/main.js`
   when running from `dist`.
3. Tests inject a fake orchestrator script.

**Attention (P15).**

1. Scan the workflow journals whose `JT.created.origin` is this session.
2. Collect every `JT.attention` item that has no `JT.attentionResolved` for
   the same `id@rev` and has not yet been presented in this session.
   "Presented" means a `CT.attention` `custom_message` with
   `details.items` containing it.
3. Present through one queue:
   - if `ctx.isIdle()`: `pi.sendMessage(…, {triggerTurn: true})`;
   - otherwise at the next `turn_end` or `agent_before_settle` boundary,
     with `continue: true`.

**Late refresh (P15).** In the `context` hook, for every presented question
item, read its child `session` file. If the question has been answered
there (an `ask` tool result whose `details` has the same `qid` and `rev`),
or `JT.attentionResolved` exists, rewrite the item's text in the outgoing
messages to `"(resolved: …)"`.

**Notes (P16).** Export `presentNote(text)` for the UI. It is presented at
the next boundary as `CT.note` and never triggers a turn.

**Tests (real pi).** Use main mode (no `DSA_EXEC`), a temp `DSA_HOME`, a
fake orchestrator entry script, and hand-written journals. Cover:

- the faux model calling the `subagents` tool with `run` publishes a correct
  request in `orchInbox`;
- the `created` receipt path, and the `submitted` path after a timeout;
- `send` with `replaces` produces `withdraw`, then the new request with
  `after`;
- an attention item is presented exactly once, including after a restart on
  the same session;
- an idle main triggers a turn; a busy main receives the item at `turn_end`;
- a resolved item is rewritten by the `context` hook;
- the starter spawns the fake orchestrator once when the lock is free, and
  never while it is held.
