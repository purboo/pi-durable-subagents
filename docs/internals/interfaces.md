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
| `withdrawn` | `custom` entry `CT.withdrawn` with `{rid, rids}`; this is also the withdraw request's receipt |

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

## Wave 2b contracts: the orchestrator (O1a engine and O1b executor)

The orchestrator is the single process that owns every workflow journal,
every execution and every pool (P2). It is built in two parallel parts that
meet at the parent-owned `src/orchestrator/contract.ts` (`Executor`,
`CallTicket`, `Ledgers`, `OrchestratorConfig`). The `JT` entries listed in
`types.ts` are cross-domain: other domains read them. Entries private to the
orchestrator are named and documented by their writer, in a header comment at
the top of the file that writes them.

### O1a · Engine (`src/orchestrator/main.ts`, `engine.ts`, `evaluator-client.ts`, `store.ts`)

**`main.ts`, the process entry:**

1. Read `home` from `dsaHome()`.
2. Call `OsLock.tryAcquire(orchLock(home))`. If the lock is held, exit 0.
3. Open `orchestrator.jsonl` and `config.json`.
4. Construct the Executor (O1b's default export factory, `createExecutor(ledgers)`)
   and the Engine.
5. Recover, then loop.
6. Exit after K6 (10 s) when there is no unfinished workflow, `busy()` is
   false and the inbox is empty.

**Intake.** The engine watches `orchInbox(home)`, plus a poll every 1 s as a
fallback. It runs `planDecisions` and commits the records to
`orchestrator.jsonl` (`JT.admitted`, `applied`, `rejected`, `withdrawn`) in
order. Its domain `decide` handles each request kind as follows:

| Kind | Handling |
|---|---|
| `run` | Create workflow `wid` (a ULID), revision `@1`. Pin the script or the compiled fan-out (via `compileFanout`), the args, the declared inputs (copied), and the discovered agents (`discoverAgents(cwd)`, as JSON) under `pinnedDir`. Write the first journal entry, then `JT.created {rid, wid, origin: req.from}` in the ledger. Start the workflow. |
| `send` | Resolve `to` to the call's current generation, then call `executor.forward`. |
| `withdraw` | The kernel lifecycle handles the "orch" level. Withdrawing a forwarded rid is passed to `executor.forward`. |
| `stop` | `executor.stop`. |
| `resume` | (Re)start any unfinished workflow. |
| `drain` | Set a flag so that no new dispatch happens. |
| `revise` | Reject with `not-implemented-yet`; that belongs to O2. |

**Evaluator client.** Spawn one evaluator host, `node <src|dist>/evaluator/host.ts`,
and speak `OrchToEval`/`EvalToOrch`. If the host dies, increment `ev` for
every running workflow and replay them all (P10).

**Workflow journal entries owned by the engine:**

| Entry | Written when |
|---|---|
| `wf-created {rid, origin, cwd, revision}` | the workflow is created |
| `ev {n}` | a new evaluator incarnation starts |
| `call {pos, key, gen, spec, fingerprint}` | a call is proposed |
| `exposed {pos}` | **before** the matching `expose` is sent |
| `value {n, kind, value}` | `now()` or `random()` is answered |
| `emit {pos, value}` | the script emits a value |
| `JT.done` | the workflow ends |
| `JT.attention {item: finished}` | the workflow ends |

The fingerprint is a `contentHash` over the spec, the agent definition and
the pinned inputs it references.

**Live operation.**

1. For each new proposal, commit `call`.
2. Build a `CallTicket`.
3. `await executor.run(ticket)`.
4. Commit `exposed {pos}`.
5. Send `expose`.

The sealed `CallResult` comes from the `JT.sealed` entry for that call.

**Replay (P11).** Start a new `ev`, then:

- **Values.** Answer `need` from the logged `value` entries in order.
- **Re-proposals.** Each re-proposal must equal the logged `call` at the
  same `pos` (key plus fingerprint). A mismatch parks the workflow:
  `JT.done {status: "parked", error}`.
- **Logged exposures.** Re-send them in logged order. Each one waits until
  its `pos` has been re-proposed.
- **Running, unsealed calls** (logged but not yet exposed): call
  `executor.run` again. The executor makes this idempotent from the
  journal.
- **The frontier** is reached when every logged exposure has been sent and
  the evaluator is `idle`. If any logged call has still not been
  re-proposed at that point, park.
- **Beyond the log**, proposals are live.

**Tests (`test/unit/orchestrator/engine/`).** Use a fake Executor that seals
synthetic results, so no real pi is needed. Cover:

- intake ordering and identity conflicts at "orch";
- `run`, which writes `created` and pins;
- live order versus replay order with the rolling-DAG fixture;
- an engine crash (killed process) mid-run, followed by replay with no
  duplicate `executor.run` for sealed calls;
- a mismatch parks the workflow;
- the missing-output frontier parks the workflow;
- host death followed by ev+1 replay;
- idle exit;
- a second engine exits on the held lock.

### O1b · Executor (`src/orchestrator/executor/`, with default export `createExecutor(ledgers): Executor`)

**Per call.** Execution id: `${callId}#${attempt}.${epoch}`.

1. Commit `JT.exec {exec, call}`.
2. Hold a provider slot in `orchestrator.jsonl` (`hold {pool: provider,
   slot, exec}` / `release`). Capacity comes from `config.providers`; the
   provider comes from the resolved model (`resolveModel` with pools; pick
   the first candidate that has a free slot, without blocking while holding
   another slot). When no slot is free, the call waits without holding
   anything.
3. Write the system prompt (the agent body) to the call directory.
4. Publish the task request (kind `task`, `MessageBody{message: spec.task}`)
   through the orchestrator `Outbox` (sender `"orch"`, to `callId`) into
   `callInbox`.
5. Spawn through `Containment.spawn`: `<pi> --mode rpc --session <callSession> -e <extension entry> ...buildPiArgs(...)`.
   - The extension entry is `src/agent/extension.ts`, or the `dist` `.js`
     equivalent.
   - The environment carries `DSA_HOME`, `DSA_EXEC`, `DSA_CALL`,
     `DSA_INBOX`, `DSA_JOURNAL` and, if there is a schema, `DSA_SCHEMA` (the
     schema written to a file).
   - A continuation (a new epoch on the same session) passes no model flags
     (C5).

**Observation.** Read RPC stdout as JSON lines and track:

- `agent_settled`;
- `message_start` (the model in use);
- `tool_execution_*`;
- `message_end` usage.

Run a tracker scan every K10 (1 s). Commit each newly discovered identity as
`tracked {exec, pid, start}`.

**Settle (P9).** On `agent_settled` or an observed process death:

1. Close stdin.
2. `Containment.fence(exec, tracked)`.
3. Commit `JT.fenced {exec}`.
4. Read the final session and take its current segment (the entries after
   `CT.exec {exec}`).
5. Decide the outcome:
   - a `CT.report` → seal from the report;
   - otherwise, the last non-empty assistant text of a settled turn (not
     aborted, not an error) → seal `ok`, using
     `buildCallResult({output: fullText})`;
   - otherwise it is a loss. While the number of losses is below K2 (5):
     commit `loss {exec}`, start epoch+1 on the same session, and publish
     `continue` (`MessageBody`, listing the dangling tool calls as
     unknown). Once losses reach K2: seal `failed: lost ×N`.
6. Seal by committing `JT.sealed {call, exec, result}`, guarded by V2. Then
   release the slots.

**Stop.** A decided stop fences the execution and seals `stopped` through
the same V2-guarded transition.

**Forward (P7).**

- `send` to a sealed call → reject `call-sealed`.
- Otherwise: commit `forward {rid, rid2, dest}` with the full envelope,
  `rid2 = forwardRid(...)`. Publish `rid2` into the child inbox through the
  orchestrator `Outbox`, which provides the outbox republish behaviour of
  P38.
- A model string becomes `ModelBody`, using `parseModel`.
- Withdrawing a forwarded rid forwards `withdraw{rids: [rid2]}`.

**Attention, questions only in O1b.** Watch each running child session file.

- A `CT.question` appears → commit `JT.attention {item: {id:
  "q:<call>:<qid>", rev, kind: "question", text, wid, call, qid, session}}`.
- The child session later shows that question answered → commit
  `JT.attentionResolved`.

**Recover.** Before the engine replays a workflow:

1. Fence every `JT.exec` that has no `JT.fenced`, using the persisted
   `tracked` identities and the tag.
2. Re-derive pool holdings: a hold whose exec is fenced is treated as
   released.

Unsealed calls are settled when `run()` is called again: report first (P9),
then continue.

**Tests (real pi with the faux provider; `test/pi/executor/`).** The child
agent C1 is still being built. Tests that need child-side consumption must
skip while `src/agent/child.ts` is the placeholder. Write them now, run them
again after integration, and mark them clearly. Cover:

- spawn plus settle with plain text → seal `ok` with the full text;
- an empty reply → loss → continue on the same session → `ok`;
- K2 losses → `failed`;
- a report from the session is used;
- SIGKILL of the child mid-tool → fence kills the orphan → continue;
- stop → `stopped`, and no second seal;
- forward of a steer and a withdraw;
- recovery after the executor's own process is killed: the report already in
  the session is sealed without a new model call;
- provider slot capacity 1 with two calls → serialised, never two holders.

## Wave 3 contracts

Baseline: the integration commit that adds this section. New pins:
`RunBody.usageBudget`, `RunBody.maxCalls`, `CallTicket.workflowBudget`,
`Executor.retire`, and shutdown semantics (fence, never seal). P20 and the
integration-target pool are not shipped (D43).

Every leaf in this wave works as follows:

- Keep cross-file effects inside the files it owns.
- Document private journal entries in that file's header comment.
- Add tests that would fail without the change.
- Leave anything not listed in its section to later leaves.

### X1 · Executor lifecycle (`src/orchestrator/executor/`, `test/pi/executor/`, `test/unit/orchestrator/executor/`)

Add new logic in new modules (for example `time.ts`, `memory.ts`,
`sweep.ts`). Keep the edits to `index.ts` to the hook points.

1. **Shutdown and observation fixes.**
   - `shutdown()` fences every active execution and returns without
     sealing anything. After restart, `recover` and `run` continue the
     calls.
   - Record only `message_end` (with usage and message id),
     `tool_execution_start`/`end` (tool name and id only, no result
     payloads) and `message_start` (provider/model) as observations. Never
     store `tool_execution_update` events.
2. **Active time (P18, V6) and timeout.**
   - Measure on a monotonic clock.
   - The evidence horizon advances on child RPC events, on session-file
     growth, and, while a tool call is open, on a tracker scan showing CPU
     progress (`ProcessTable` rows for tracked pids; add a CPU-time field
     only inside your modules if the platform does not provide one; read
     `/proc/<pid>/stat` or `ps -o time=`).
   - Exclude `ask` (an open question), slot/memory waits and
     backoff/continuation gaps.
   - Commit a checkpoint `time{exec, active}` every K3 (10 s), plus a final
     one at fence.
   - After a crash, the unobserved tail is not charged.
   - `spec.timeoutMs`: when active time across all executions of the call
     reaches it, decide a timeout: fence, then seal `timeout` (precedence
     as for stop).
3. **Stall (K4 = 10 min).** No RPC event, no session growth and no CPU
   progress for K4, with no open `ask`, raises
   `JT.attention{kind:"stall", id:"stall:<call>", rev:n}`. New activity
   resolves it, and the next stall uses rev n+1. At most one is open per
   call.
4. **Budgets (P31, V8).**
   - Usage is the sum of `message_end` usage, deduplicated by message id,
     over all executions of the call. Reconstruct it from sessions on
     recovery.
   - **Per-call `spec.budget`:** once reached, settle at the next
     boundary: fence, then seal `budget`. Overshoot is recorded truthfully.
   - **`ticket.workflowBudget`:** the sum over all calls of the workflow.
     Once reached, refuse new dispatches (seal `failed`, error
     `workflow budget reached`) and refuse loss continuations (same seal).
     Running children are not stopped.
   - Raise `JT.attention{kind:"budget"}` once per workflow when its budget
     is reached.
5. **Memory admission (P29, V1).**
   - Before each spawn, read available memory (Linux
     `/proc/meminfo` MemAvailable; macOS `vm_stat`), commit
     `mem{available}` to `orchestrator.jsonl`, and hold the pool `memory`
     only if `available − reserve ≥ perChild` (K9 from `config.memory`;
     defaults 2048/300 MB).
   - Never wait while holding the provider slot. Acquire the memory hold
     first or together, with no hold-and-wait.
   - Release it with the execution. Never revoke existing holds.
6. **Pool skip (K7) and switch timeout (K5).**
   - Three consecutive losses on one pool candidate skip that candidate
     for 10 min, within the pool. Journal this as `skip{pool, model, until}`.
   - The default `switchTimeoutMs` becomes 300000 (K5).
7. **Retirement.**
   - `retire(widRev)` per the contract.
   - At seal (P27), every forward to the call that has no child receipt
     gets `forward-retired{rid, rid2, reason:"retired-without-child-receipt"}`.
8. **Sweep (P23).** Every K1 (30 s), kill tagged or tracked processes
   belonging to fenced or retired executions; the tracker rescan uses
   `Containment.fence`.

**Tests** (real pi with the faux provider where the child matters; unit
tests otherwise):

- shutdown then restart continues the call, with no `stopped` seal;
- `tool_execution_update` events are not journaled;
- a silent CPU-burning bash tool advances active time and triggers
  `timeoutMs`;
- `ask` waiting is not charged;
- a stall item, then a new item after new activity;
- per-call budget → `budget`;
- workflow budget refuses the second dispatch;
- memory refusal waits without holding a provider slot (inject the reader);
- K7 skip;
- `retire` fences and never seals;
- `forward-retired` after a seal;
- the sweep kills a tagged straggler.

### E2 · Engine extensions (`src/orchestrator/engine.ts`, `store.ts`, `main.ts`, `evaluator-client.ts`, `test/unit/orchestrator/engine/`)

1. **Budget plumbing.** Pin `RunBody.usageBudget` at admission and pass it
   as `CallTicket.workflowBudget`.
2. **Spawn budget (P36).**
   - `RunBody.maxCalls`, defaulting to `config.k.spawnBudget` and then 300.
   - A proposal beyond the budget is not dispatched. Commit
     `refused{pos, key, reason:"spawn-budget"}` and expose a synthesized
     result `{status:"failed", ok:false, error:"spawn budget exceeded", output:""}`.
   - This must be deterministic on replay.
3. **Revision (P14).** Handle `revise` (`ReviseBody`):
   1. `executor.retire(oldWidRev)`;
   2. retire the old evaluator worker;
   3. pin the new script and/or args as revision r+1, with the same
      staging-before-admission rule;
   4. start the evaluator.

   **Reuse:** when a proposal's fingerprint equals a sealed call of an
   earlier revision under the same key, expose that sealed result without
   dispatching. Commit `reused{pos, from}`.

   **Stale requests:** requests that name an old revision (`to` containing
   `wid@<old r>`) are rejected with `stale-revision` (V3). `stop`,
   `resume` and `status` apply to the current revision.
4. **Status snapshot.** The parent provides
   `src/orchestrator/snapshot.ts` (`snapshotFromEntries`,
   `workflowSnapshot`, `allWorkflows`). It is pure and reads journals only.
   U1 and L1 import it.

   E2 owns it from now on and extends it for:
   - `name` in `wf-created`, which E2 adds from `RunBody.name`;
   - `revised{revision}`;
   - `refused` and `reused` positions.

   **Ledger bloat fix:** `create-intent` must reference the staged snapshot
   (`staging/<rid>/snapshot.json` hash), not embed the pins. Inputs can be
   large, and `orchestrator.jsonl` is read in full on every start.
5. **Resume.** `resume{wid?}` re-admits parked workflows: a parked
   workflow whose cause is gone (for example an evaluator limit) restarts
   with ev+1. Always record `resumed{n}`.

**Tests:** the spawn budget is refused deterministically across replay;
budget plumbing reaches the ticket; revise reuses matching seals and
dispatches only changed calls; old-revision requests are rejected;
snapshot shapes are checked against journals written by the real engine
with the fake executor; resume of a parked workflow.

### U1 · UI (`src/ui/`, `test/pi/ui/`, `test/unit/ui/`)

Implement `design/ui.md`: the main-session line, the list (`↓` on an empty
editor), and the watch view with `←`/`→`, thinking, interacting (model
switch and steer go through M1's existing `subagents` send path, so they
are durable), and notes (P16, via M1's `presentNote`).

- **Data.** It comes only from journals and child session files:
  `workflowSnapshot`, plus tailing `x/<key>@<gen>/session.jsonl` for the
  watch view. Use pi's exported TUI components and message renderers
  (root exports only).
- **Registration.** `src/agent/main.ts` is parent-owned now. Export
  `registerUi(pi, deps)` from `src/ui/index.ts`; the parent wires it into
  `registerMain` during integration. If you need one line in `main.ts` to
  test this, describe it in your report instead of editing the file.
- **Degradation (P21).** If a UI surface is unavailable (no TTY, RPC
  mode), register nothing and never throw.
- **Tests:**
  - Unit-test the pure view models (list grouping, status phrases,
    durations, done rows).
  - Run one isolated real-pi TUI test, either a pty or
    `--mode interactive` with a scripted terminal if feasible. Otherwise
    render the components to strings and snapshot them.
  - Provide one screenshot-like text capture of the list and the watch
    view as evidence.

### L1a · CLI (`src/cli/`, `test/unit/cli/`, `test/pi/cli/`)

The `pi-durable-subagents` binary is `src/cli/main.ts`; `package.json`
already points `bin` at `dist/cli/main.js`. Subcommands:

| Subcommand | Behaviour |
|---|---|
| `smoke` | Check C1/C2/C3 surfaces: process-table read, tag visibility, spawn + fence of a tagged child, lock, `publishFile`, pi binary present and its version. Report execution and UI capability (P21); exit non-zero if any execution surface fails. |
| `tail [wid]` | Follow the workflow journal(s) as human-readable lines, using `workflowSnapshot`. |
| `status [wid] [--json]` | Print `workflowSnapshot`. |
| `resume [wid]`, `drain`, `stop <wid\|callId>`, `stop-all` | Durable requests through a CLI sender Outbox (sender id `cli:<user>@<host>`). Start the orchestrator the same way M1's starter does: `spawn(process.execPath, [entry])` detached, with the lock check. `stop-all` = `drain` + `stop` for every unfinished workflow; journals stay resumable. |
| `install-service`, `uninstall-service` | Optional starter service (P1): a systemd user unit (Linux) or a launchd agent (macOS) that runs `pi-durable-subagents resume` at login and every K1. `uninstall` removes it. |

Not in this leaf: `chaos`, which comes later with X2.

**Tests:** argument parsing; `status`/`tail` against journals made by the
real engine with the fake executor; `drain`/`stop` request envelopes and
outbox republish; `smoke` on this machine; service file generation (render
only, never install into the real user's home: use a temp HOME).

## Wave 4 contracts

New pins (commit 91964e1):

- `CallEffects` in `src/orchestrator/contract.ts`;
- `CallTicket.originSession`, `CallTicket.continueFrom`, `CallTicket.opening`;
- `RunBody.origin`, which the main agent always fills from its session file and current leaf.

### X2b · Call effects (`src/orchestrator/executor/effects/`, `test/unit/orchestrator/effects/`, `test/pi/effects/`)

The default export is `createEffects(ledgers): CallEffects`. The executor
wiring belongs to X2a; you only implement and test the interface. Put
private journal entries in the workflow journal and document them in the
header comment.

- **Worktree (P32).** For `spec.isolation === "worktree"`:
  1. Commit `wt-intent{call, path, branch, base}`. The path is
     `<cwd>/.dsa/<wid>/<key>`, the branch is `dsa/<wid>/<key>`, and the base
     is `git rev-parse HEAD` in the call cwd at first prepare (recorded).
  2. `git worktree add -b <branch> <path> <base>`.
  3. Commit `wt-created{call}`.

  Then return the path as the cwd. On a repeat, reconcile with
  `git worktree list --porcelain` plus the branch head: reuse an existing
  worktree; create it if the intent has no worktree.

  `afterSeal`: on `ok`, remove the worktree only if
  `git status --porcelain` is empty (`wt-removed`). A dirty worktree is kept
  and reported through `JT.attention{kind:"unknown"}`, whose text names the
  path. Keep everything on failure. The branch is always kept. A non-git
  cwd is an error: `prepare` throws and the executor seals `failed`.
- **Fork (P33).** For `spec.context === "fork"` with `t.originSession`:
  1. Build a new pi session file at `sessionPath`. It gets a fresh header
     (new id, cwd = the call cwd, version copied from the origin header) and
     the origin's message and model entries in branch order, re-parented as
     a linear chain. Drop every `dsa-*` custom entry.
  2. Publish it no-replace with kernel `publishFile`. If an identical
     result already exists, that counts as done.

  Without `originSession`, throw `fork requested but the run has no origin
  session`. Study pi's session JSONL format in
  `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.*`
  (root-export types only in code; the format knowledge may come from
  reading `dist`).
- **Gate (P30).** Accepted forms are a string, or `{command, output?:"json",
  schema?, timeoutMs?}`.

  1. Commit `gate-intent{call, id:"gate:<call>#<n>"}`, where n is
     1 + the number of earlier intents of that call.
  2. Run `sh -c <command>` in the call cwd through `Containment.spawn`, with
     exec = the gate id. Pass env `DSA_RESULT` (a path to the result JSON),
     `DSA_CALL` and `DSA_OUTPUT` (the call's output text in a file).
  3. Record `gate{id, exit, json?}`.

  The outcome:

  | Condition | Seal |
  |---|---|
  | non-zero exit | `gate-failed` |
  | invalid JSON, or schema failure (use `src/agent/child/schema.ts` `validate`) | `gate-failed` |
  | timeout | fence, then `gate-failed` |
  | `ctl.signal` abort | fence, return the result unchanged |

  When the gate passes, put its JSON in `result.data.gate`.

  `recover(journal)`: fence every gate id that has an intent but no `gate`
  record, then record `gate{id, unknown:true}`. `beforeSeal` then turns
  that into status `unknown` and never re-runs the gate (A5).
- **Outputs (P19).** For `spec.output`:
  - **Relative path:** publish the output text immutably as
    `artifactsDir/<key>@<gen>/<n>-<basename>` with `publishFile`, and
    atomically point `latest` at it (symlink tmp + rename + dir fsync).
  - **Absolute path:** write it best effort: tmp, fsync, rename, dir fsync.
    If the existing file's hash differs from the last hash we wrote, skip it
    and add a `JT.attention{kind:"unknown"}` naming the conflict.

  Add the paths to `result.artifacts`. Use `paths.artifactsDir`.

**Tests:** use real git in temp dirs, real `sh` processes, and pi-format
session fixtures. Cover the crash windows (intent with no effect, effect
with no record) and idempotent repeats.

### X2a · Generations, hibernation, effects wiring (owns `src/orchestrator/executor/index.ts`, `engine.ts`, `store.ts`, tests)

- **Generations (P37).** Engine: a `send` (steer or follow-up) to a sealed
  call opens generation g+1.
  1. Allocate gen = 1 + the maximum gen for (wid, key) across revisions.
  2. Commit `generation{rid, key, gen, from: <sealed callId>}` as the
     `send`'s resolution (A3: a retry of the same rid returns the same
     generation).
  3. `executor.run(ticket{continueFrom, opening})`.

  Later sends are forwarded to g+1 in admission order. This also works
  after `JT.done` of the workflow: the generation lives outside the script.
  Its seal produces `JT.attention{kind:"finished"}` for the origin, naming
  the call. Starter and idle exit must treat an unsealed generation as
  pending work, and recovery re-runs unsealed generations.

  Executor: the first execution of g+1 copies the session of g (no-replace
  publish) and delivers `opening` as its task (kind steer/follow-up becomes
  a `task` request, receipt as usual).
- **Hibernation (P28).**
  - **Enter:** when a child has had an open question (`CT.question` without
    an answer) for K8 (2 min, `config.k.hibernateMs`), commit
    `hibernated{call, qid, rev}`, fence (this is not a loss), and release
    the provider and memory holdings.
  - **Answer:** `forward` of an `answer` (cond qid/rev) to a hibernated
    call. If it matches the open qid@rev, commit
    `answer-bound{call, qid, rev, rid}` and resume. A duplicate or stale
    answer is rejected (`already-answered`/`stale-rev`); an answer to a
    retired question gets `retired`.
  - **Resume:**
    1. Reacquire the holdings without hold-and-wait.
    2. Commit `resumed{call, rid}`.
    3. Run a new execution whose request is a `continue` whose message
       states the question and the answer.

    The child's receipt for that message is the answer's receipt.
    Recovery: if the session already has that receipt, do not deliver it
    again.
  - **Other cases:** stop, timeout, budget and retire still settle or
    retire a hibernated call. Time spent hibernated is not active time.
  - **Child side:** for the question to close in the child history, the
    `continue` request carries `cond:{qid, rev}`. If the child needs a
    change to mark the question answered on such a receipt, ask the parent
    (`src/agent/child*` is parent-owned).
- **Effects wiring.**
  - Construct `createEffects(ledgers)`. Until X2b lands, use a local no-op
    stub with the same interface in a separate file that the parent
    replaces.
  - Call `prepare` before the first execution of each call generation, and
    use its cwd.
  - Call `beforeSeal` on non-stop outcomes, passing an AbortSignal that
    fires on a stop/timeout/budget decision.
  - Call `afterSeal` after the seal, and `recover` in `executor.recover`.
- **Engine pinning.** Stage `RunBody.origin` at admission: the branch to
  `leafId` (following `parentId`), keeping only `message` and
  `model_change` entries, written to `pinned/origin.jsonl`. Pass it as
  `ticket.originSession`.

**Tests:**

- real pi tests: send to a sealed call opens g+1 on the same session and
  seals it; a retry of the same rid gives the same generation;
- hibernation: enter, answer, resume, with no loss counted; a duplicate
  answer is rejected; a crash after `answer-bound` and before delivery
  delivers exactly once; stop while hibernated;
- the origin pin;
- the effects call order, with a recording stub.

### L1b · `chaos` (`src/cli/chaos/`, `test/pi/chaos/`; one registration line in `src/cli/main.ts`)

`pi-durable-subagents chaos [--scenario <n>] [--keep] [--json]` runs the
AC2 fault suite offline in about a minute, on the real product stack:
orchestrator, executor, evaluator, and real child pi processes. It needs
only the `pi` binary on PATH.

**Isolation.** Everything runs in a temp root:

- `DSA_HOME`;
- `PI_CODING_AGENT_DIR`, whose `settings.json` loads the shipped scripted
  provider `src/cli/chaos/provider.ts` (a pi extension built on
  `fauxProvider` from `@earendil-works/pi-ai`, which is resolvable inside
  pi extensions) as `defaultProvider`/`defaultModel`;
- the project cwd with `.pi/agents/{writer,reviewer,integrator}.md`.

Never touch the user's `~/.pi` or real `DSA_HOME`. `--keep` keeps the temp
root and prints its path.

**Workflow under test.** A 3-leaf rolling DAG, writer → reviewer →
integrator, in the style of `exec-template.js`: the reviewer parses a
`LEAF:` line from the writer, and the integrator parses a `REVIEW:` line.
The main session submits it through the real `subagents` tool. That main
session is a real pi RPC session with this extension and a scripted main
model.

**Scenarios.** Each injects one fault and asserts the outcome:

| # | Fault | Expected outcome |
|---|---|---|
| 1 | Stream drop: a provider error mid-turn | Continues the same session; partial tool results kept |
| 2 | Silent timeout: a CPU-burning silent tool with `timeoutMs` | Seals `timeout` (tracker evidence), and the script handles it |
| 3 | Empty reply | Continuation, then ok |
| 4 | Main pi restart: kill the main session mid-run, restart on the same session | Work continues; one `finished` presentation |
| 5 | The child asks; the main session steers while the question is open | The steer interrupts; the question stays open; a later answer completes |
| 6 | Two steers, where the second declares `replaces` the first, published in reverse order | Only the second applies; the first is tombstoned or withdrawn |
| 7 | Refusal by verdict: the reviewer returns a rejecting `REVIEW:` | The integrator is never dispatched |
| 8 | Dependency failure: the writer fails after K2 losses | Dependents skipped |
| 9 | SIGKILL of the orchestrator mid-run; the starter restarts it | No sealed call is re-executed; the running call continues on its session |

Faults are injected through the scripted provider: steps in the task text,
as in `test/harness/faux-provider.ts`, plus process kills by the driver.

**Global invariants**, checked from the journals and sessions after every
scenario:

- **Duplicate runs = 0:** no call is sealed twice; no request rid has two
  receipts in any session; no sealed call gets a later execution.
- **Lost results = 0:** expected outputs are present in the workflow
  result.
- **Restarted from scratch = 0:** every continuation reuses the session
  file of the previous execution, so the session only grows.
- **AC4:** wakes in the main session ≤ leaves × 2 + questions; no stale
  reminder, meaning no presented `item@rev` that was already resolved at
  presentation time.

**Output.** One summary in the style of README `design/copy.md` (killed
host ×N · dropped streams ×N · …, then the invariant lines and
`all 9 scenarios pass`); `--json` gives machine-readable output. A failure
prints the scenario, the invariant, and the evidence paths, and exits
non-zero.

**Tests.** `test/pi/chaos/chaos.test.ts` runs the full suite once (it may
take a few minutes; give it an explicit timeout) and one scenario through
the CLI entry.

If a scenario exposes a product defect, do **not** fix product code. Stop
and report it to the parent with the evidence path; the parent owns the
fix.
