# Durable Subagents for pi

**Subagents that never lose work, and never do it twice.**

Streams drop. Requests time out. Models return nothing. You quit pi. Your
laptop reboots. Durable Subagents keeps going: it picks every subagent up
where it stopped, in the same session. Every request is decided once and
every step is finished at most once (what a tool did to the outside world
before a crash is the one thing it cannot undo; see
[What we do not promise](#what-we-do-not-promise)).

```text
$ npx pi-durable-subagents chaos
  killed host ×1 · dropped streams ×1 · empty replies ×6 · out-of-order steers ×1
  duplicate runs ........ 0
  lost results .......... 0
  restarted from scratch  0
  AC4 wakes / reminders . pass
  all 9 scenarios ....... pass
```

You can run this yourself, offline, in about 2 minutes. It runs a three-step
writer → reviewer → integrator workflow through the real product (a real pi
main session, the orchestrator, real subagent pi processes and a scripted
model). It injects one fault per scenario, then checks the journals and
sessions: nothing ran twice, nothing was lost, and nothing restarted from
scratch.

## Install

```bash
pi install npm:pi-durable-subagents
# or straight from GitHub (no build step; runs the TypeScript sources)
pi install git:github.com/purboo/pi-durable-subagents
```

This needs pi 1.0.x and Node.js 22.19 or later. It has been tested with
pi 1.0.2 on Linux. The CI configuration covers Linux and macOS.

The `pi-durable-subagents` command line (below) is optional. Run it without
installing through `npx pi-durable-subagents …`, or install it once with
`npm i -g pi-durable-subagents`. Use the global install if you want the
optional login service (`install-service`): a service must not point into
the npx cache, so `install-service` refuses to run from there.

## What happens when…

| Situation | What Durable Subagents does |
|---|---|
| The stream drops, or the model returns nothing | Continues the **same** session. Finished tool results are kept. |
| A step runs past its `timeoutMs` (even inside a silent tool) | Stops it cleanly as `timeout`. Only time spent working counts; waiting for you does not. |
| You quit pi (Ctrl+D, `/quit`, closing the terminal) while subagents run | That session's workflows pause: nothing more is spent, nothing is lost. When you come back, pi says so; `resume` (or `r` in the list) continues them in the same sessions. Set `"onQuit": "continue"` to let them run on instead. |
| pi crashes or is killed (`kill -9`) while subagents run | The work keeps running. When you come back, the session that started the work is told what needs you. |
| The machine or the orchestrator dies mid-run | The next pi you open resumes the work. Finished results are kept and nothing runs twice. The resumed subagent is told that processes its tools had started (background ones included) were stopped, so it checks them instead of waiting for them. |
| You steer a subagent while it is asking you a question | Your message reaches it, in order. Nothing is rejected or lost. |
| Two steers arrive out of order and the second replaces the first | Only the second one applies. |
| A step is refused, or a dependency fails | The workflow stops that branch cleanly. Nothing is retried in vain. |
| A provider's usage window runs out (`No available accounts`, usage limit, quota exceeded, a daily quota at 0) | Found at the second refusal in a row, while pi is still retrying. A call in a pool continues **in the same session** on the pool's next model (within pi's next retry or two); new calls skip that provider. After 15 minutes the next call that wants it tries it once; when it answers, new calls and new generations use it again. A call with a single model waits for it instead of failing. Billing errors (402, insufficient balance) still fail at once. |
| A gateway answers HTTP 200 with a quota notice ("your usage window is used up") | Matched against the provider's `exhaustedPatterns` (see [Configuration](#configuration)): the provider is avoided until its next probe, like a quota error, the message never becomes the result, and the call continues on the pool's next usable model. Without one the call fails with `model-unavailable:` and the matched text (clipped to 200 characters). |
| A pool does not resolve (it names itself, it is empty, or one of its entries is not a model) | That call fails at once with `model-unavailable: pool "<name>" does not resolve: <reason>`. It is a configuration error of the call, not of the orchestrator: other calls are unaffected. |
| Two subagents would write in the same worktree | Only one runs there at a time. A call that can write (its tools include `edit` or `write`, which pi's default tools do) holds its git worktree's writer lock from its launch until it ends, also while it waits for an answer. Another writer for that worktree waits in order, and status shows `waiting for writer lock: <root> held by <wid>/<key>`. `writer: false` (a call that does not write there), `isolation: "worktree"` and `"writerLock": "off"` opt out. |
| A subagent waits for an answer for a long time | It releases its model slot and memory, then resumes exactly once when you answer. A forwarded answer prevents planned hibernation. If an execution was stopped after consuming the answer, recovery continues the same session without another answer. The question survives orchestrator restarts (also forced ones) and crashes, including one that hits before the subagent released its slot. |
| A subagent's work ends (finished, stopped, or cut off) | Every process its tools started ends with that execution, also ones started with `nohup`, `setsid` or `&`: they carry the execution's tag (see the limit below). For work that must outlive its turn, the subagent can start a durable command call with `run --wake caller -- …` (below). A `hold` run directly by its tools is no exception: a forced restart stops it and its lease is released. |
| A subagent runs in a worktree you made (`isolation: "none"`, the default, with `cwd`) | Durable Subagents never creates, cleans, moves or deletes that directory or its branch, also not on `prune`; `prune` deletes only its own state and the worktrees it created for `isolation: "worktree"`. |

## Use it

The main agent gets one tool, `subagents`. You ask in plain language, and
the agent calls it:

```text
subagents({ action: "agents" })
subagents({ agent: "worker", task: "Fix the flaky lease test" })
subagents({ command: ["npm", "test"], cwd: "./repo", timeoutMs: 1800000 })
subagents({ tasks: [{ agent: "scout", task: "…" }, { agent: "reviewer", task: "…" }] })
subagents({ chain: [{ agent: "worker", task: "…" }, { agent: "reviewer", task: "Review: {previous}" }] })
subagents({ workflow: "./batch.js", args: { … }, usageBudget: { costUsd: 20 } })
subagents({ action: "send", to: "<wid>/<key>", kind: "steer", message: "Don't touch the tests yet" })
subagents({ action: "send", to: ["<wid>/a", "<wid>/b"], kind: "notify", message: "Config is TOML from now on" })
subagents({ action: "status" })
```

`status` without a wid is brief: what runs, what asks (with the address to
answer) or failed, and one line per finished workflow, each with its run
`labels` clipped to 60 characters (the `/subagents` list shows them on a
workflow's row when they fit). A workflow's `status` is its run's result;
`active: true` means a latest-generation call is still queued, running or
asking, including a follow-up on a finished run. `status` with a wid
shows one workflow with outputs clipped; add `key` for one call's full result,
or `full: true` for everything. `tail: N` gives the last N lines of each call's
result instead, and `grep: "<regex>"` only its lines matching a case-sensitive
JavaScript regular expression (both: grep first, then the last N); either is
unclipped up to 4000 characters per call, which suits a receipt on the last
line of each output. An invalid regex is an error. The regex runs in the
process that asks (the pi session or the CLI), so avoid nested quantifiers
such as `(a+)+`, which can take seconds on one line; to bound its cost it
tests only the first 2000 characters of a line and the last 5000 lines of an
output (the reply then starts with `[n earlier lines not searched]`). When a run replies `{submitted: {rid}}`
(its workflow was not created within 10 s), the rid works wherever a wid does.
A call's `model` in `status` is the model its last provider request used; a
requested switch not used yet shows as `switching`, a refused one as
`switchFailed`. A send naming a model replies with `model` and `effect`
(`next-request`, `next-execution` or `next-generation`).
A provider's refusal of the content (terms of service, usage policy) fails the
call at once with that error instead of retrying it.
With `tasks` or `chain`, top-level `agent`, `model`, `timeoutMs`, `budget`,
`isolation`, `context`, `tools`, `skills`, `once` and `writer` apply to every
step that does not set its own, e.g.
`{ tasks: [{ task: "…" }, { task: "…" }], agent: "reviewer" }`. A command
step takes only `timeoutMs` and `writer` of them, plus `env` and `rerun`,
which apply to command steps only (see [Command calls](#command-calls)). A
top-level `task` or `command` beside a list is refused (each is a single
call; put it in a step); other call fields there, and any of them beside a
workflow script, are refused rather than ignored.
When a call of a new run already waits for its worktree's writer lock as the
run reply is written, the reply names it: `writerWait: ["<wid>/<key> held by
<wid>/<key> (<root>)"]` with a hint that `writer: false` or
`isolation: "worktree"` opts out. The reply does not wait for this.

Every run is asynchronous. The agent is woken once, when the workflow
finishes (the notice carries each subagent's result) or when a subagent asks
it something. Each verb means one thing, and a refusal says what would work:

| Verb | Applies to | Effect |
|---|---|---|
| `run` | — | Start one subagent, a command call, `tasks` in parallel, a `chain`, or a workflow script. An unknown agent name is refused before anything starts, with the list of agents. |
| `send steer` | a running subagent | Reaches it at its next safe point. To a finished one: refused, use `follow-up`; To one waiting on its question: it interrupts the question, and the subagent usually asks again; `answer` answers it. |
| `send notify` | any subagent | Tells it a decision without disturbing it. The reply's `delivery` says how: `steered` (running: it gets the note at its next safe point, like a steer), `held-until-answer` (waiting on its question: never interrupts it; it gets the note at the first safe point after the answer) or `noted` (not running: nothing starts; the note is recorded, and the call's next follow-up opens with it). |
| `send follow-up` | any subagent | A finished one continues in the same session as a new generation (`key@2`); the reply names it (`generation`, `call`). A running one gets it after its current turn; the reply says `delivery: forwarded` and names the running generation (`call: <wid>/<key>@<gen>`). With `model` (a model or a pool's name), the generation that takes it runs on it. |
| `send answer` | an open question | Answers it once, at the first chance: as the result of the question it waits on, or (when it no longer waits on that question, say after a steer) as a message at its next safe point. An answer to an earlier question while it waits on a later one ends the later one: that question is withdrawn (`superseded`, the subagent is told to ask again if it still needs it) and takes no answer. |
| `send model` | any subagent | A running one switches at its next request; one asking, hibernated or waiting for a slot launches on it when it runs again. A sealed one records a choice for its next follow-up, without starting anything or reserving a slot. An accepted manual choice persists across later generations until another manual choice replaces it (see [Model switching](#model-switching)). |
| `stop` | a subagent or a workflow | Final: `stopped`, usage kept, edits left as they are. A command call's whole process tree ends. |
| `drain` / `resume` | existing workflows | A reversible hold; runs started later are not held. |

Notes recorded for a call that is not running are durable and pending until
its next follow-up, whose opening message carries all of them, in order, before
its own message:

```text
Notes recorded after your last turn:
- Config is TOML from now on
- Keep the old parser for one release

<the follow-up's message>
```

Each note is delivered once, also across orchestrator restarts and retried
requests. A notify accepted for a running call that seals before it gets the
note becomes a pending note too. `status` shows them on the call
(`b@1 ok "..." · 2 notes pending`; JSON `notesPending`).

A follow-up queued into running work is not lost when that generation ends
before taking it: the next generation opens with it, after any pending notes,
as if it had been sent just after the end. A follow-up sent to the finished call
in the meantime opens that generation and takes the queued ones along (in the
order sent, before its own message). A retry of the same request then names the
generation it went into. Only a stop drops it, because a stop is final; a
withdrawn follow-up is gone too.

`to` may list several calls for `steer`, `notify`, `follow-up` and `model`
(`answer` takes one). Each call gets its own request and is decided on its
own: an unknown or refused target does not affect the others, and the reply
has one entry per target (`targets`, plus a `summary` line each). With
`request: "<id>"`, the target at position i (1-based, in the order given) is
sent as `<id>:<i>`, so a retry with the same list gets the same outcomes and
sends nothing twice. Each of those requests records the whole list, so another
message, another list (longer, shorter or reordered) or a single send under
that id is a `request-conflict`, and nothing of it is sent. The list is compared
as written: retry with the same addresses (the same run id or `wid/key` form),
or the retry is a conflict too.

`notify` is new in 1.0.28: after upgrading, restart the orchestrator
(`pi-durable-subagents restart` or the tool's restart action) before using it.
While an older orchestrator runs, a notify is refused with that advice and
nothing is sent (an older orchestrator would accept it and drop it).

### Asking the parent

A child uses `ask` to ask its parent a question and wait for an answer or
steering message. `{question: string}` still works by default. For a decision
that the parent can act on, name the decision, options and evidence:

```json
{
  "question": "The local repair is verified; should I keep this scope?",
  "decision_needed": "Choose the repair scope.",
  "options": [
    {"label": "Local fix", "scope": "ask projection", "cost": "one verification run", "risk": "low", "preferred": true},
    {"label": "Defer the repair"}
  ],
  "facts": ["commit 5ad9ee3", "run AK", "log sha abc"],
  "tried": ["reproduced the projection loss"],
  "classification_candidates": [
    {"label": "projection loss", "evidence": ["digest drops fields"], "unproven": ["restart path"]}
  ]
}
```

`question` is always required and must be a string. The optional fields are:

- `decision_needed`: one sentence naming the decision you need; required and
  nonblank whenever any structured field is present.
- `options`: at most 9 objects with required `label` and optional `scope`,
  `cost`, `risk` (strings) and `preferred` (boolean). At most one may be
  preferred; the parent sees numbered labels, with `(preferred)` on that one.
- `facts` and `tried`: at most 20 strings each; give durable evidence (commit,
  run id, log sha) and what you have already tried.
- `classification_candidates`: at most 9 objects with required `label` and
  optional `evidence` and `unproven` arrays of strings, separating evidence
  from explanations not yet proved. These nested arrays have no additional
  item-count limit.

Every string in a structured ask, including `question`, is at most 2000
characters. An ask is structured when any optional field above is present,
or when `askRequireDecision` is true (see [Configuration](#configuration)).
Default question-only asks keep the 1.1.0 behaviour, including no new
question-length limit. Empty arrays are allowed; omitted fields stay absent,
and text is preserved, not trimmed or coerced.

Wrong types, exceeded limits, multiple preferred options or a missing decision
produce a tool error starting `ask refused:` before any question entry,
attention item, waiter or revision is created. A missing decision says exactly:

```text
ask refused: decision_needed is required (one sentence naming the decision you need), then options
```

The child can correct it and ask again. Parent-facing asking notices, the
agent tool's status text, and CLI status/describe text show the decision first,
then numbered option labels, then the original question. Plain questions still
display as before. The supplied fields survive sessions, digests, attention
and orchestrator restarts; question identity (`qid`, based on execution and
question text), answer, steer and hibernation semantics are unchanged. JSON
fields are described under [Driving dsa from a program](#driving-dsa-from-a-program).

### Model switching

In 1.2.0, an accepted manual `send kind:model` becomes the logical call's
choice for every later follow-up generation (g+1, g+2, …), including calls
initially launched from a pool. Another accepted manual model switch, or a
follow-up specifying `model`, replaces it. Refused, withdrawn or replaced
requests never become choices; automatic failover never becomes a choice.

A concrete `provider/id[:thinking]` remains concrete. A pool name remains a
pool choice, resolved again at each generation's launch using the current pool
configuration. Pool availability, slot, skip and failover rules still apply.
A concrete choice follows the existing 1.1 explicit-model launch path: it has
no pool to widen into, so an exhausted provider waits for availability/probing
and provider slots, not an invented fallback pool. Live-switch capacity
admission and reservations are unchanged.

To a sealed call, `send kind:model` records the choice and replies with
`model` and `effect: "next-generation"`; it creates no generation, starts no
child and reserves no slot. Send a follow-up to continue. Until then, `status`
retains the last actual `model` and shows the pending choice as `switching`.
Opening the next generation consumes the pending indicator, not the choice.
Sealed model requests use the existing sealed follow-up acceptance path,
including done and stopped workflows; address, stale-revision, command-call
and pin-validation refusals still apply. This does not resume a stopped
workflow by itself.

The choice is persisted before the applied reply and survives orchestrator
restarts; a retry with the same request id returns the first outcome. Legacy
model forwards without the new optional `choice` retain their 1.1
execution-only semantics; upgrading does not make an old switch sticky.

### The exact fork

`context: "exact"` runs a call as a continuation of the *calling* pi session's
last provider request: the parent capture supplies every field of that request
byte for byte (system prompt or instructions, tools, tool choice, model,
thinking, max tokens, prompt cache key, metadata), and the child's own
conversation is appended to the parent's conversation. The child's agent
definition, context files and skills never reach the provider. This is the
third context value next to `"fresh"` (a call with no context of its own) and
`"fork"` (a call that inherits the parent's effective context as pi sends it):
the fork copies the parent's *messages*, the exact fork copies the parent's
*whole request* and adds the child's turns to it.

The parent session is the one that starts the call. It writes its latest
provider payload to `$DSA_HOME/exact/<sessionId>.json` (mode 0600, atomic
replace, off the request path); the file holds the serialized provider payload
and the request's identity (the session id, provider, model, api, thinking and
the time of the request), never headers and never credentials. The orchestrator
removes capture files that were not modified for 7 days when it starts.
`"exactCapture": false` turns the capture off: no file is written and an exact
run falls back (`no-capture`).

A run whose specs are known (the call, `tasks`, `chain`) takes its context
from that spec. A workflow script's specs are built while it runs, so there
the context is read from the script's source: a script that quotes `"exact"`
(or has `"exact"` as one of its `args`) is an exact run, and it needs an
origin session like any other exact run.

An exact run pins the capture of its origin session at admission, so a later
capture never changes a pinned run, and a follow-up of the call reuses it. The
call launches on the captured provider, model and thinking: it holds that
provider's slot and waits for it like any launch, and it has no pool failover
(a provider that is used up makes the call fail as a concrete model would).

Two things are refused at admission: a call with `context: "exact"` that also
names a `model` (`context "exact" runs on the origin model; remove model`), and
an exact run without an origin session (`context "exact" needs an origin
session: run it from a pi session, or give --origin-session <pi session id>`).
From the CLI, `--origin-session <pi session id>` names that session; it is
accepted only for `context: "exact"` calls.

The tools the model sees are the parent's. The call's own tools (the spec's
tools or the agent's, plus the protocol tools) are the allow-list, enforced
when the model calls a tool: a tool outside the allow-list, a tool the capture
lists but the exact child cannot execute, and always `subagents` (no
recursion) are refused with a result starting `tool refused in exact fork:`,
and the child continues. A request on another provider, model or api than the
capture is not sent: the call fails with `exact-mismatch: <detail>`. Anthropic
cache breakpoints of the parent's conversation are kept; the child's own
markers are kept only while the request stays within the provider's limit of
four, the child's earliest one first.

A call that cannot be exact at launch runs as `context: "fork"` and records
why:

| reason | when |
|---|---|
| `no-capture` | the origin session has no capture (the capture is off, or the session made no request yet) |
| `api:<name>` | the capture's api cannot be spliced (only `anthropic-messages` and `openai-responses` can) |
| `model-unknown` | the captured provider is not configured for the orchestrator |
| `no-payload-hook` | the child transport never offers the payload hook (detected at the first request) |

The decision is taken once per call: a rebuilt call never retries exact later.

`describe` of such a call adds an `exact` field (the mode, the reason of a
rebuilt call, the pinned capture's sha256, size and time, the provider and
model, the age of the capture at the launch, and the usage of every provider
request). The status text and the finished-call notice show one line:

```text
exact: cache 97% (148.2K/152.6K) · $0.031 · age 41s
exact: rebuilt (no-capture) · $0.031
```

The cache share is that of the first request (`cacheRead / (input +
cacheRead)`). A provider's cache window is a few minutes: an exact fork of a
parent that has been idle for longer is exact but reads little cache, and the
ratio shows it.

### Forked context

`context: "fork"` pins the parent's *effective* context, the one pi itself
sends to the model, rather than every message on the session branch.

On a compacted branch the fork pins the latest compaction (its summary, shown
as pi presents it, plus its `systemMessage` when it has one), the entries kept
from its `firstKeptEntryId` on, and every entry after it — exactly as pi's
session-context builder selects them. Raw messages from before the compaction
are not copied, and system messages inside the kept range are dropped, as pi
drops them. On an uncompacted branch nothing changes from 1.2: the `message`
and `model_change` entries of the branch are pinned byte for byte.

dsa's own `dsa-*` receipts are never pinned, on either kind of branch, and
neither are the entries pi does not send to the model (thinking-level changes,
labels, session info). The child keeps its own thinking level. The pin is
taken at admission, as before: a compaction in the parent after admission does
not change a pinned run, and a follow-up generation reuses the child's own
session.

### Workflow scripts

A workflow is a plain script. These are the globals it can use:

| Global | Meaning |
|---|---|
| `runs.run(key, spec)` | Run one subagent |
| `runs.all([...])` | Run several |
| `emit(value)` | Report progress |
| `args` | The workflow's arguments |
| `runs.input(name)` | A declared input file |
| `now()` / `random()` | Logged, so the run can be replayed |

The script's `return` value is the workflow result. A workflow script is a
single file: it cannot `import` or `require` other modules.

`spec` fields:

- `agent`, `task`, `model` (`provider/id[:thinking]` or a pool name), `cwd`;
- `timeoutMs` (active time), `output` (a relative path becomes an artifact);
- `schema` (a structured `report`);
- `gate` (a command, or `{command, output: "json", schema, timeoutMs}`);
- `isolation: "worktree"`, `context: "fork"`, `budget`;
- `writer` (`false`: the call does not write in its cwd's worktree, so it does
  not take that worktree's writer lock; `true`: it does, whatever its tools).

A spec with `command` instead of `agent` and `task` is a
[command call](#command-calls).

A workflow script's specs are built while it runs, so the context of such a
run is read from the script's source: a script that quotes `"exact"` (or has
`"exact"` as one of its `args`) is an exact run and needs an origin session
(see [The exact fork](#the-exact-fork)). A run whose specs are known — the
call, `tasks`, `chain` — takes its context from that spec.

The result has `ok`, `status`, the full `output` text and the structured
`data`.

A script is replayed after a crash. Finished calls are not run again, and a
changed script is detected rather than silently mixed. Keep scripts
deterministic: use `now()`/`random()`, not `Date`/`Math.random`.

### Command calls

A command call runs a command instead of an agent: no model, no provider slot,
no tokens. It is a call like any other: it has a key and an address
(`<wid>/<key>`), it can be a step of `tasks` or `chain` or a `runs.run` of a
script, and when it ends it wakes the session that started it like any
finished call. Use it for a long build, a test suite or a wait that should not
keep an agent (and its slot) busy.

```text
subagents({ command: ["npm", "test"], cwd: "./repo" })
subagents({ command: "make -j8 && ./bench > bench.txt", timeoutMs: 3600000, env: { CI: "1" } })
subagents({ chain: [{ command: ["npm", "test"] }, { agent: "worker", task: "Fix what failed:\n{previous}" }] })
```

| Field | Meaning |
|---|---|
| `command` | An array runs a program with those arguments, never shell syntax: its first element is looked up in the command's `PATH` (exit 127 when there is none), and a shell builtin is not run as a builtin (`["exit", "7"]` looks for a program named `exit`). A string runs through `/bin/sh -c`. |
| `cwd` | Its directory, resolved like an agent call's. |
| `timeoutMs` | Wall-clock time from its start, including time the orchestrator was down (see the result table). |
| `env` | Variables added to the environment (`DSA_*` names are reserved). |
| `rerun` | `true`: when the process vanished without an exit record (the machine restarted), start it once more instead of ending `unknown`. For idempotent commands. |
| `writer` | `true`: take its worktree's writer lock (default `false`). |
| `key` | Its key in `tasks`/`chain`, as for agent steps. |

Other call fields (`agent`, `task`, `model`, `tools`, `schema`, `gate`, …)
are refused in a command call, and `env`/`rerun` in an agent call. stdin is
empty; stdout and stderr go, interleaved, to `output.log` in the attempt's
directory. The command sees the orchestrator's environment plus `env`,
`DSA_CALL` (its call id), `DSA_EXEC` (its attempt) and `DSA_HOME`, so a
`pi-durable-subagents` command inside it (`hold`, `run`, `send`) addresses
the same home; it cannot force a restart. After merging `env`, the command's
`PATH` is `env.PATH`, else the orchestrator's `PATH`, with `$DSA_HOME/bin`
appended once as the last entry. Custom and inherited tools keep precedence,
and the CLI shim is still found. Empty entries and earlier copies of the
shim directory are removed; an explicitly empty PATH searches only that
directory, not the current directory or system tools. Agent PATH is unchanged
(the shim stays first).

| The command | Result |
|---|---|
| exits 0 | `ok` |
| exits with another status or is killed by a signal | `failed`, error `Command exited <status>` / `Command killed by <SIG>` |
| ends after its deadline (start + `timeoutMs`), or still runs then | `timeout`, error `Command timed out after <ms> ms` |
| is stopped (`stop`) | `stopped` |
| vanished without an exit record, no `rerun` | `unknown`, error `Command ended without an exit record` |

`data` is `{exitCode, signal, durationMs}` and `output` the last 16 KiB of
`output.log`. Only `stop` controls a command call (it ends the whole process
tree); `steer`, `follow-up`, `answer`, `model` and `notify` are refused with
`command call: <kind> is not supported (stop it, or start a new call)`.

The deadline counts from the command's start, also while no orchestrator
runs: a command that ended in time is `ok` (or `failed`) even when the
orchestrator records it later, and one that ended after its deadline is
`timeout` (with its exit in `data`) although nothing had to stop it.

A command outlives the orchestrator: a restart (also a forced one), an idle
exit or a crash leaves it running, and the next orchestrator takes it over or
records its result if it ended meanwhile. The restart busy list does not count
it.

A subagent can start a command that must outlive its own turn, then end the
turn instead of waiting in a tool:

```sh
pi-durable-subagents run --request build-42 --wake caller -- npm test
```

When the workflow ends, the caller gets a follow-up with its status, each
call's status and duration, command exit code or signal when known, and an
output tail. Its first line is:

```text
Durable run build-42 (<wid>) that you started with --wake caller finished: done.
```

A sealed caller continues as a new generation; a running one gets the usual
forwarded follow-up, reopened after its turn if it did not take it.
Each workflow completion has one durable wake decision, reused
after retries and crashes. The ordinary finished notice to the CLI origin
is unchanged. Every derived agent system prompt includes this lifecycle
reminder; the pinned agent definition is not changed.

A hold (`drain`, `stop-all`, a quit pi) prevents starting, never stops what
started. A command call that has not started yet (also one waiting for its
worktree's writer lock) waits while its workflow is held and starts after
`resume`. One that has started runs to its end; its result is recorded and
delivered to its workflow as without the hold, also after an orchestrator
restart (`start` and the pi session's starter start an orchestrator for it):
a workflow that is then complete finishes and sends its notice, and a call it
wants next waits for `resume`. The one `rerun` of a lost command is a new
start, so under a hold it waits for `resume` too.

In a chain, a command step gets no `{previous}` (its command is not changed);
an agent step after a command step gets the command's output as `{previous}`.
`status`, `describe` and the `/subagents` view show a running command call
with `command: <command>`, its pid and how long it runs instead of a model;
`describe` also names its `output.log`. A finished one shows its status and
exit code.

### Watch any subagent like the main agent

While subagents work, a small dock sits above the editor: one quiet row per
working subagent (what it is doing and for how long; it spins while there is
fresh activity and stops when the agent goes quiet), a question first and
highlighted, and a summary line (`1 asking · 3 working · 12/40 done · ↓ subagents`).
When the work ends it shrinks to one sentence and leaves after ten minutes. Set
`"ui": { "dock": "line" }` (one line) or `"off"` in `~/.pi/durable-subagents/config.json`;
`"ui": { "dockAt": "below" }` puts it below the editor instead. pi stacks the
lines above the editor in extension load order, so to keep the dock above
another extension's editor bar (a powerline bar, for example), list
pi-durable-subagents before that extension in `packages`.

Press `↓` on an empty editor, or type `/subagents`, to open the list, a floating panel: this
session's workflows (sessions are independent), working ones first (newest
first), every subagent with its model, what it is doing and for how long, and
its latest line. Finished ones follow, most recently ended first, dimmed, with
their conclusion. A workflow's only subagent is named after the workflow (its
`name`, else its label values, e.g. `ipc-qa c4811f14`); in a
fan-out, a generated key (`tasks:0`) shows as its agent (`worker 1`,
`reviewer`). The key remains the address for `send` and the CLI. A session's workflows include runs started
through the CLI by a process this session launched (a background driver, a
script run from its bash tool): pi exports `DSA_SESSION`, and `run` names that
session (see `--session` below). Other sessions' and a terminal's runs are
not shown.

A queued subagent says why it does not start, as far as the orchestrator has
recorded it, and `queued` alone when nothing is known:

| phrase | meaning |
| --- | --- |
| `queued: orchestrator starting (12s)` | the orchestrator is still recovering workflows after a start; nothing is dispatched yet (`status` shows `orchestrator: <version> (pid N, starting 12s)`, the summary line `3 queued: orchestrator starting (12s)`) |
| `queued: <provider> usage window used up` | every provider it can start on is used up |
| `queued: waiting for the writer lock of <root>` | another call writes in the same worktree |
| `queued: waiting for a free slot (<provider> 4/4)` | every provider it can start on is full |
| `queued (answered)` / `queued (answered): <reason>` | an answered asker waiting to run again, with the reason when one is recorded (as above) |
| `paused · r resumes` | a drained workflow |

The CLI and the tool's status (`queued` per call) say the same.

The list is also where you act. The footer shows the keys for the selected
row: `Enter` watch, `s` steer, `f` follow-up, `x` stop (asks `y` first),
`m` model, `a` answer. A one-line input opens at the bottom (paste works),
and the result shows right there: `✓ applied` or the reason it was not.

`Enter` opens a subagent full screen: its task, thinking, tool calls and
output, rendered with pi's own components. `←`/`→` switch between the
subagents of one workflow. Scrolling up pauses following; pi's
`↓ Jump to latest message · End` badge (or `End`, or a click) brings you back.

Typing steers the subagent you are watching (`Alt+Enter` queues a
follow-up instead), answers it if it is asking you something, and continues
it (a follow-up) if it has finished. `/model`
switches its model. Steers, answers and model switches are journaled as
coming from you, and the main agent sees a note at its next turn.

### Quiet by design

The main agent is interrupted only when there is something to decide:

- a question;
- a finished workflow;
- a stalled subagent (the alert names the command it is running and for how long, so a long silent command reads differently from a stuck call);
- an unknown outcome;
- a call waiting for another call's writer lock on its worktree (once, with the holder);
- two unfinished calls observed editing the same worktree when one of them does not take the writer lock (a reminder);
- a reached budget.

Each one arrives once. A reminder that was already resolved is shown as
resolved, never as open.

## Your pi-subagents scripts, unchanged

Agent files, discovery and precedence follow `pi-subagents` 0.75.0. That
covers user, project and package agents, `model:thinking`, `tools` and
`skills`. The same builtin agents are included; an agent file of the same name
in your user or project agents overrides one.

| Agent | Use it when you want... |
|---|---|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks. |
| `researcher` | Web/docs research with sources and a concise brief. |
| `evidence-auditor` | An independent check that important research claims are supported by their sources. |
| `worker` | Implementation: edits files, validates, asks instead of guessing on unapproved decisions. |
| `reviewer` | Code review and small fixes against the task, tests, edge cases and simplicity. |
| `oracle` | A second opinion before acting; challenges assumptions without editing. |
| `delegate` | A lightweight general delegate that behaves close to the parent session. |

`researcher` and `evidence-auditor` search with whatever web extension your pi
has installed (for example [pi-web-access](https://www.npmjs.com/package/pi-web-access)).
Without one they can still read given URLs with `curl`, and say that search was
unavailable.

| pi-subagents | Durable Subagents |
|---|---|
| `subagent({workflow: './x.js', async: true})` | `subagents({action: 'run', workflow: './x.js'})`; always asynchronous |
| `runs.run`, `runs.all`, `emit`, `args`, `return` | the same |
| `tasks: [...]`, `chain: [...]` | the same |
| `action: 'steer'`, supervisor `reply` | `send` (`steer`, `answer`) |
| `resume` an ended subagent | `send` to it: a new generation continues the same session |
| `contact_supervisor` in the subagent | `ask` |
| `outputSchema` | `schema` (the subagent calls `report`) |
| `context: 'fork'`, `gate`, `worktree: true` | `context: 'fork'`, `gate`, `isolation: 'worktree'` |
| `usageBudget`, `maxSubagentSpawnsPerRun` | `usageBudget`, `maxCalls` |

**Not supported:** external CLI agents, missions, schedules, intercom,
`acceptance` policies (use `gate`), and nested subagents.

A real rolling-DAG batch generated by a production template ran here
unchanged, with zero edited lines.

## Command line

```text
pi-durable-subagents version            print pi-durable-subagents <package version> (also --version)
pi-durable-subagents smoke              check this machine and this pi (offline, < 60 s)
pi-durable-subagents chaos              run the fault suite (offline, about 2 minutes)
pi-durable-subagents drill failover [--keep] [--json]
                                        rehearse pool failover in a temporary home (offline, about 30 s)
pi-durable-subagents status [wid] [--json]
pi-durable-subagents status <wid> [--tail <n>] [--grep <regex>] [--json]
                                        each call's last n lines and/or its lines matching regex
pi-durable-subagents events <wid> [--json]   the meaningful timeline of one workflow
pi-durable-subagents events --all [--since <cursor>] [--limit <n>] [--json]
                                        milestones of every workflow, read with a cursor (see below)
pi-durable-subagents tail [wid] [--json]
pi-durable-subagents start              start the orchestrator if work is pending; sends nothing
pi-durable-subagents resume [wid]       continue unfinished or parked work (undoes drain / stop-all)
pi-durable-subagents drain              hold existing workflows: running calls finish, nothing new starts in them
pi-durable-subagents stop <wid|call>
pi-durable-subagents run --request <id> [--wake caller] --spec <file|-> [--labels <json>] [--session <id>] [--origin-session <id>] [--cwd <dir>] [--json] [--wait-ms <n>]
pi-durable-subagents run --request <id> [--wake caller] [--cwd <dir>] [--timeout-ms <n>] [--name <text>] [--labels <json>] [--session <id>] [--json] [--wait-ms <n>] -- <program> [args…]
                                        start a run under a caller-chosen id; safe to retry (see below)
pi-durable-subagents send --request <id> --to <run-id|wid/key> [--to ...] --kind follow-up|answer|steer|notify|model
                         [--call <key>] [--qid <qid> --rev <n>] --message <text|@file> [--model <m>] [--json]
pi-durable-subagents stop --request <id> <run-id|wid|wid/key|call> [--json]
pi-durable-subagents describe --key <run-id> | <wid> [--json]
                                        full read-only state of one run (never starts the orchestrator)
pi-durable-subagents stop-all           pause every existing workflow now; journals stay resumable
                                        (runs you start afterwards are not held)
pi-durable-subagents prune [wid] [--older-than <days>]
                                        delete finished workflows (done, failed, stopped); prints count and bytes freed
pi-durable-subagents restart [--force <token> --reason <text>]  switch to the installed version (see "Updating Durable Subagents")
pi-durable-subagents hold <resource> [--shared | --slots <n>] [--priority <n>] [--yield] [--expect <duration>] [--max-wait <s> | --no-wait] [--note <text>] -- <command…>
                                        run one command while holding a resource lease (see below)
pi-durable-subagents leases [--json]    who holds and who waits for each resource
pi-durable-subagents doctor [--json]    read-only health check; exits 1 when something needs you
pi-durable-subagents install-service    optional: run `start` at login and every 30 s (systemd / launchd)
pi-durable-subagents uninstall-service
```

The service only runs `start`: it never resumes work you drained or
stopped. Install the CLI globally (`npm i -g pi-durable-subagents`) before
`install-service`.

### Driving dsa from a program

A program (a CI job, a script, another agent) should name its requests with
`--request <id>`: 1–124 characters `[A-Za-z0-9][A-Za-z0-9._:-]*`, unique per
`DSA_HOME` across `run`, `send` and `stop`. The id is the identity: the first
submission under an id is decided once and every retry with **the same
content** gets that first outcome; a retry never starts a second workflow or
a second follow-up. The run id is also the workflow key: `send --to <run-id>`
and `describe --key <run-id>` find the workflow without knowing its wid.

The content is hashed into `spec_digest` (the request kind, its body and, for
answers, the question id and revision). Persist the exact spec bytes you
submit and retry with those bytes: the run's `cwd` is part of the content
(`spec.cwd`, else `--cwd`, else the current directory, made absolute), so
retry from the same place or pass it explicitly. The `spec` file is the
`subagents` tool's run form (`{agent, task, model?, schema?, …}`,
`{command, cwd?, timeoutMs?, env?, rerun?}` or
`{tasks: […], name?, usageBudget?, maxCalls?}`); `context: "fork"` needs a pi
session and is rejected. `context: "exact"` is available here with
`--origin-session <pi session id>`, which names the session whose capture the
run pins (see [The exact fork](#the-exact-fork)); without it an exact run is
refused, because the capture comes from that session.

The `run -- …` shorthand submits `{command: [program, ...args], timeoutMs?,
name?}` through the same normalizer. Arguments after `--` are literal; use
`-- sh -c 'make && make test'` for shell syntax. `--spec` and `--` are mutually
exclusive. `--timeout-ms` (positive integer milliseconds) and `--name` require
the argv form; `--cwd`, labels, session display and request-id exit codes
work as before.

`--wake` takes only `caller` and needs a valid `DSA_CALL`, supplied inside a
subagent call. Without it, the CLI refuses before submitting anything:
`--wake caller needs DSA_CALL: run it from inside a subagent call`.
The caller must be an agent call in an existing, unpruned workflow's current
revision; invalid callers are rejected with `wake caller: …`, with no new
workflow. A command call cannot receive a wake; the main-session `subagents`
tool has no wake option. The stored `RunBody.wake: {to: "<wid>/<key>"}` is
part of the digest; `RunBody.caller` (the full `DSA_CALL`) is provenance, not
part of it. Retrying from another generation of the same caller therefore
keeps the request identity. Requests without wake keep their digests.

Caller wakes need a 1.1.0 orchestrator. After upgrading the CLI, restart a
still-running 1.0.45 orchestrator: a new wake request exits 1 before recording
anything, with `the running orchestrator 1.0.45 predates run --wake (new in 1.1.0)`
and restart guidance, not a silently ignored flag. This gate applies
when the running version predates both 1.1.0 and the loaded CLI; an already
recorded request retains its first outcome. With no running orchestrator,
the next one starts on the installed version.

| exit | meaning | `--json` reply |
| --- | --- | --- |
| 0 | decided and applied (a retry gets the same answer) | run: `{request, wid, created, spec_digest, writerWait?, hint?}` (`writerWait: [{call, heldBy, cwd}]`: calls already queued behind a writer lock); send/stop: `{request, applied, generation?, call?, spec_digest}` |
| 1 | decided and rejected (`reason`), or refused before submission (usage error, invalid spec, unknown agent: this invocation submitted nothing) | `{request, applied: false, reason, spec_digest?}` (`spec_digest` once the content could be hashed) |
| 3 | `request-conflict`: the id already names other content; nothing was sent | `{request, error, wid?, spec_digest, state}` (the original's digest and state) |
| 75 | not decided yet: submitted but undecided in `--wait-ms` (default 60 s), submitted and then a later step failed (`reason` says which), or a lock was busy (`reason: "busy"`); an id already recorded is never refused again (the same content gets its first outcome, its agents are not rechecked; other content is a conflict); retry with the same id | `{request, pending: true, reason?}` |

`created` is false when the id had already been decided before the command
ran. A conflicting id stays conflicting forever, also after `prune`: the
tombstone keeps the final status, the id and the digest. Any sender's retry
completes a submission another one recorded but did not publish (it died in
between), so a retry with the same content always converges.

A send with several `--to` (not for `answer`) sends `<id>:1` ... `<id>:n`, one
per target in the order given, and prints one line per target (`--json`:
`{request, targets: [{to, request, applied, ...}]}`). The same id with another
message or list (also a longer one) is a conflict and sends nothing. Its exit code is 3 when the
id or one target names other content, else 75 when one target is not decided
yet, else 1 when one was rejected, else 0. A notify's reply adds `delivery`
(`steered`, `held-until-answer` or `noted`) and a `note` that says what it means.

From the `subagents` tool, `request` works the same, with one difference: a
run's origin session (what `context: "fork"` copies, and where notices go) is
not part of the digest. Only a run that can fork copies the origin branch: its
script quotes `"fork"` or a string in its `args` is `"fork"`; any other run
copies nothing, and a call of it that builds `context: "fork"` some other way
fails with "fork requested but the run has no origin session". A run that asks
for `context: "exact"` copies the origin branch too (a rebuilt exact call runs
as a fork) and pins the capture of its origin session. A retry of the same id from another session therefore
gets the first session's workflow, its notices and its forked context. A
retried answer may leave out `to`, `qid` and `rev`: it addresses the question
the first attempt answered.

`describe` reports one of `absent` (never seen), `pending` (submitted, not
decided — typically no orchestrator is running; `start` or a retry starts it),
`rejected` (with `reason`), `running`, `asking` (open questions with their
full text, `qid`, `rev` and the `to` address to answer), `sealed` (finished:
`status` plus every call's unclipped `output`, `error` and schema `data`) or
`pruned` (`pruned: {status, endedAt}`; workflows pruned before 1.0.21 have
only `endedAt`), with `wid`, `request` and
`spec_digest`, and `labels` when the run has any. A command call has
`command` (its command on one line, clipped), `attempt`, `log` (its
`output.log`) and, while it runs, `pid` and `elapsed`. Live calls also show what
they wait for (slot, writer lock, lease, exhausted provider; see "Labels and
why a call does not move"). `lastFence: {at, exec, reason}` appears only
when an execution was cut off: it had not ended its turn when it was fenced,
did not hibernate on a question (also when recovery finds it cut off while only
its question's `ask` ran), and was not ended on purpose (stop, timeout,
budget). Every execution ends with a fence, so an ordinary end is not
reported; a `once` call sealed `unknown` or a call sealed after repeated losses
is. The reason is a best-effort reading of the journals: `restart-force` when a forced restart listed the execution,
`orchestrator-crash` when the orchestrator died uncleanly while it ran, else
`process-died`.

For structured asks, each `describe` `questions[]` item adds the supplied
`decision_needed`, `options`, `facts`, `tried` and `classification_candidates`
alongside `qid`, `rev`, `to`, `call` and `text`; `text` remains the original
question, not a rendered summary. This applies to both CLI describe forms
and the program `describe()` API. Full `status <wid> --json` attention items
retain the metadata; compact status clips `decision_needed` like question
text. The agent tool's brief `asking[]` adds clipped `decision_needed` and
`rev` only for structured questions, even in a mixed list. Plain-question JSON
keeps its 1.1.0 shape and serialization, without inserted defaults. Machine
JSON stays separate from the decision-first text rendering.

A wake run's `describe` adds `wake: {to, state, rev?, generation?, reason?}`:
`state` is `pending`, `applied`, `skipped` or `rejected`; `rev` counts workflow
completions and `generation` names the delivery generation when known. A
stopped caller is skipped (`caller stopped`); a pruned or retired caller or
broken pins can reject delivery. Skips and rejections are final. A pending
wake prevents prune (`wake pending`) and lazy settlement; pruning after
delivery keeps its receipt.

Each described caller call, and each call in `status <wid> --json`, can have
`awaiting: [{request, wid?, state}]`: `pending` means admitted but no workflow
yet, `running` means not completed, `finished` means completed with the wake
still undecided. Entries are ordered by admission, limited to the caller's
current revision and removed once the latest wake is decided; absent when
empty. Reading this indexes caller addresses in the ledger and reads only
matching run journals, not every workflow.
A sealed described call also has `sealedAt`, its latest generation's seal
timestamp in milliseconds; an unsealed generation omits it.

For an agent call, `describe` can show `endedAtSeal: [{pid, command}]`, the
SIGKILL targets recorded by fences of its latest generation, in journal
order, at most 20, and `endedAtSealMore` for the rest. Each `ended` journal
entry lists at most 20 targets plus optional `more`; command lines are
clipped to 200 characters, empty when unreadable (Linux `/proc`, macOS `ps`).
The direct pi child is excluded; command calls and gates have no such
records. These fields are absent when nothing was recorded. They diagnose
signal targets, not proof of death (see the limits below).

A call with `context: "exact"` (or one that was rebuilt as a fork) has an
`exact` field in `describe`: `mode` (`exact` or `rebuilt`), the `reason` of a
rebuilt call (`no-capture`, `api:<name>`, `model-unknown`, `no-payload-hook`),
the pinned capture's `captureSha256`, `captureBytes` and `capturedAt`, its
`provider` and `model`, `ageMsAtLaunch`, and the usage of every provider
request (`requests`, `input`, `cacheRead`, `cacheWrite`, `output`, `costUsd`,
with `firstCacheRatio` for the first request). A call with another context has
no such field.

```sh
pi-durable-subagents run --request build-42 --spec build-42.json --json
# exit 75: retry later with the same id and bytes
pi-durable-subagents describe --key build-42 --json
pi-durable-subagents send --request build-42-a1 --to build-42 --kind answer \
  --qid <qid> --rev <rev> --message "yes"
```

#### Events across workflows

`events --all` reads one durable log of milestones of every workflow
(`$DSA_HOME/events.jsonl`, written only by the orchestrator), so a program
without a daemon can poll it and react to completions and questions without
reading every workflow. Output is JSON lines (with or without `--json`).

```sh
pi-durable-subagents events --all                          # {"head":"<epoch>:<seq>","more":false}
pi-durable-subagents events --all --since <cursor> --limit 500
```

Every event has `id`, `cursor`, `ts` (when the milestone happened), `type`,
`wid`, `request` (the run id, when the run was created by `run --request`),
`labels` (the run's labels, when it has any), and for call events `key`,
`gen` and `call` (`<wid>@<rev>/<key>@<gen>`):

| type | fields |
| --- | --- |
| `submitted` | `name?` — the workflow was created |
| `started` | `exec` — the first execution of a call (generation) began |
| `asking` | `qid`, `rev`, `question` (full text), `to` (`<wid>/<key>`, the answer address) |
| `answered` | `qid`, `rev`, `by`, `via?`, `digest` (sha256 hex of the UTF-8 answer), `length` (its length in UTF-16 code units, as JavaScript counts) — never the text; `describe` has it |
| `sealed` | `status` (`ok`, `failed`, `gate-failed`, `stopped`, `timeout`, `budget`, `unknown`, …), `error?` (unclipped), `data` when its JSON is at most 16 KiB, else `data_omitted: <bytes>` (read it with `describe`) |
| `fenced` | `exec` (the execution cut off), `reason` (`restart-force`, `orchestrator-crash`, `process-died`), `at` — an execution was interrupted and the call resumed in a new one: the processes its tools had started are gone |
| `workflow-done` | `status`, `error?` |

Readers must ignore types they do not know (`waiting`/`moving` follow).
`by` is the sender of the answer: `session:<id>` for a pi session (with
`via: "ui"` when it came from the subagent list), `call:<wid>/<key>` for a
subagent answering through the CLI (its `DSA_CALL`; provenance, not
authority), `cli:<user>@<host>` for any other CLI use, else `unknown`. `fenced` is emitted when the call's next execution begins (right
after recovery, before it waits for a slot) and only when the fence
interrupted work, exactly as `describe`'s `lastFence`: a turn that had ended,
a hibernated question, an answer's resume or a seal are no `fenced`. A `once`
call cut off in a tool is never resumed: it gets `sealed` with status
`unknown` and no `fenced`. A call with no next execution has no `fenced`; its
`sealed` carries the outcome (`describe`'s `lastFence` still names the fence).

Cursors are `<epoch>:<seq>`; `--since c` returns the events after `c` in log
order, at most `--limit` (default and maximum 1000), then
`{"head": …, "more": …}`. With `more: true`, `head` is the cursor of the last
event printed: pass it as the next `--since`. With `more: false`, `head` is
the log's head; it may name a seq that no event has (every orchestrator start
skips 1000 seqs, so a seq you saw in a write that a power cut undid is never
reused), and it is still a valid cursor. Without `--since` only the head is
printed. When no log exists yet, the command starts the orchestrator (which
creates it from everything still on disk) and waits up to `--wait-ms`
(default 60 s), else prints `{"pending": true}` and exits 75; when the log
exists it never starts anything.

Delivery is at least once, without gaps: after a crash the orchestrator
derives again from its last durable watermark, and an event derived again has
the same `id` (a new cursor). Deduplicate by `id`, not by cursor (keeping
ids for the retention window is enough), and persist your cursor only after
you applied the events of a page.

Retention: an event is dropped only when it was logged more than 7 days ago
(`"k": { "eventRetentionMs": … }` in `$DSA_HOME/config.json`) and its workflow is
finished in its current revision (done, failed or stopped — not parked) with
no open question and no unsealed call, or was pruned. The log is compacted at
orchestrator start and at most hourly; to compact now while a question is open
(which keeps the orchestrator from idle exit), run `restart` without `--force`. A cursor of another epoch (the log was
replaced: a corrupt log is kept aside as `events.jsonl.corrupt-<ms>` and a new
one starts), below the highest dropped seq, or beyond the head gets exit 4
and one line `{"error":"cursor-expired","head":"…","oldest":"…"}` (`oldest`
is the smallest cursor still accepted). To recover, run `describe --key` for
every run you have not closed (it reports `sealed`, `asking` with the full
question, `pruned`, …), rebuild your state from those answers, then continue
with `--since <head>` from that reply. A malformed cursor or option exits 1
with `{"error":"invalid-arguments","message":…}`.

#### Labels and why a call does not move

`run --request <id> --spec <file> --labels '{"node":"n1","attempt":"2"}'`
(tool: `labels: {…}`) attaches your own labels to a run: a flat JSON object
of at most 32 keys `[A-Za-z0-9_.:-]{1,64}` with string values of at most 256
characters, at most 4096 bytes of JSON. They are part of the content: the
same id with other labels (or none) is a `request-conflict` (exit 3). Give
them only with `--labels`; a `labels` field in the spec file is refused.
Invalid labels exit 1 and submit nothing, and the orchestrator rejects a
request that carries invalid ones (`invalid-labels: …`). `describe` returns
them as `labels` (also after `prune`), and every event of the run carries
them.

`--session <pi session id>` shows the run in that pi session's dock and
`/subagents` list as one of its own; without it, `run` takes `$DSA_SESSION`,
which a pi session exports to every process it starts (a subagent's
processes never pass it on). It decides where the run is listed (the dock,
`/subagents` and that session's `status`), and you act on it there like on
any row; the run still belongs to its sender: that session's main agent gets
no completion notices for it, quitting that pi does not pause it, and the
session is not part of the content, so a retry from another session gets the
first outcome. An invalid `--session` exits 1; an invalid inherited value
is ignored.

When an unsealed call does not move, its `waiting` in `describe` adds
`reason`, `detail` (the status line for that cause, e.g. `waiting for a slot:
probe 1/1`) and `since` (ms: when that cause started). The event log has the
same: `waiting {reason, detail, since}` when the reason appears or changes,
`moving {after}` when it clears (also when the call ends), checked every
`k.waitCheckMs` (default 5 s; read when the orchestrator starts, unlike the other
`k` settings a `config.json` change does not apply it until a restart); a
change of detail alone is no event. The first reason
that applies wins:

| reason | the call … |
| --- | --- |
| `unconfirmed-stop` | had processes that did not exit after SIGKILL; it starts nothing until they are gone (look at them) |
| `provider-exhausted` | runs on, or can only be admitted to, providers whose usage window is used up |
| `writer-lock` | waits for another call that writes in the same worktree |
| `lease` | waits for a resource lease (`hold`, below) |
| `slot` | is queued for a provider slot or memory headroom (at once when its providers are full, else after 3 s) |
| `silent` | is running (launched, not stopped) without visible activity: the stall notice of that execution, with the command running and for how long |

A call whose current execution asked a question (also while it hibernates
until the answer) is `asking`, not waiting. Once its answer is bound, it is
`queued` with `answered: "<qid>"` and no open question, retaining
`hibernated: true` while it holds no slot until its next execution starts.
It waits like any queued call (for a slot, the writer lock, ...), except while
a drain holds its workflow: then it waits for `resume`, not for a slot, and
`status` does not say it waits for one. Its `answered` event is logged when the
answer is bound. A drained call
(no execution running) is never `silent`; a sealed call never waits. `provider-exhausted`, `writer-lock`, `lease` and `slot` are queues
that clear by themselves; `silent` and `unconfirmed-stop` may need a look.

An open question with an unconfirmed answer forward carries
`answerForwarded: {rid, qid, rev, at}` in JSON status. After 30 seconds, text status
says `asking: answer forwarded <age> ago, not delivered` instead of plain `asking`.

### Housekeeping

Journals are never compacted, so state only grows. `prune` removes finished
workflows: the named one, or all of them (only those that ended more than
`--older-than` days ago, if given). Parked and running workflows, and
workflows with a follow-up still open, are never pruned; naming one prints
why. The ledger keeps a one-line record of each pruned workflow, and it
never comes back. `doctor` shows disk use, workflows by status, the largest
journals, parked work, old open questions, and leftovers; each finding
comes with one command to fix it.

Finished workflows cost the orchestrator nothing while nobody touches them:
once a workflow has ended (or parked) with no follow-up or execution open,
its journal file is closed and nothing reads it periodically. A follow-up,
resume, revise, stop or prune reopens it as needed. `status` and `doctor`
show what the running orchestrator costs on one line,

```text
orchestrator: 1.0.28 (pid 4242) · 3 live / 190 workflows, 3 journals open, 0.4 passes/s, read 12 MB
```

and `status --json` / `doctor --json` carry it as `orchestratorStats`:
`workflows` (not pruned), `liveWorkflows` (with work still open),
`openJournals` (journal files held open), `passesPerSecond` (intake passes
that ran, averaged over the last minute; an idle orchestrator runs almost
none), `readBytes` (bytes the orchestrator's own threads read since it
started, summed from `/proc/self/task/*/io`; absent where there is none.
Not `/proc/<pid>/io` of the orchestrator: Linux adds every reaped child's I/O
to its parent there, so it grows by whatever the subagents and their builds
read, in a burst each time a call ends), `pid` and `at` (when it was
written). The orchestrator writes these to `orchestrator-stats.json` every
10 s; they are shown only while that process runs.

A pi session reads only its own workflows. Which workflows are its own comes
from the orchestrator ledger, so its dock and list never open the journals or
transcripts of other sessions' workflows, however many the machine has. While
an orchestrator runs, a pi session does not look for pending work at all;
without one, it looks until it finds the first unfinished workflow and keeps
none of the journals it read. `node scripts/bench-ui.ts --owner=main:<pi
session id>` measures what a session pays on its main thread for a given
`DSA_HOME` (read-only). The measurement uses a temporary cache; pass
`--cache-home=<temporary directory>` to reuse it across runs, and run with
`node --expose-gc` to measure RSS after released history is collected.

Readers keep digests of settled workflows and facts of final calls in
`DSA_HOME/cache`. These are rebuildable: deleting the cache costs one slower
read. Digests are keyed by journal identity and reducer code; final facts by
call seal, session identity and deriving code. A settled journal is released
after each pass. Polling skips its journal IO while the ledger stays unchanged,
for at most five seconds. Turn boundaries check immediately for late attention.
Ledger changes force a journal check;
final sessions are also rechecked within five seconds. Only an explicitly
opened final call keeps its transcript. Prune removes the workflow's caches.
`DSA_CACHE_HOME=<directory>` places the derived cache under that directory
instead of `DSA_HOME`, without changing where authoritative data is read.

### Where the orchestrator starts

Whatever needs it first starts the orchestrator: a pi session, a CLI
command, the optional service, or the orchestrator itself after a restart.
It must not depend on that caller's environment or lifetime:

- **pi is resolved once, by the starter.** `DSA_PI_BIN` when set (it must
  be the absolute path of an executable file), else the first `pi` on the
  starter's `PATH` (a package-manager shim stays the shim). The orchestrator
  receives it as `DSA_PI_BIN` and launches every subagent with that path, not
  with whatever `pi` its inherited `PATH` finds. Its start records it in the
  ledger (`orchestrator{pi}`, `null` when none was found) and `doctor` shows
  it as `pi: <path>`.
- **The CLI does not start an orchestrator without pi.** When neither
  `DSA_PI_BIN` nor `PATH` has one, the command fails with an error naming
  both; a request it already sent stays pending and runs once an orchestrator
  starts from an environment that has pi (any pi session starts one). A pi
  session starts it regardless; the orchestrator then looks pi up on its own
  `PATH`. `install-service` writes the `pi` it finds into the service as
  `DSA_PI_BIN`, since a service manager's `PATH` rarely has it.
- **Its own scope on Linux.** A oneshot systemd unit, a cron job or a CI step
  ends every process in its cgroup when it finishes, a detached orchestrator
  included. On Linux with a systemd user manager (`systemd-run` on `PATH`,
  `XDG_RUNTIME_DIR` set) and lingering enabled for the user
  (`loginctl enable-linger`, i.e. `/var/lib/systemd/linger/$USER` exists),
  the starter therefore runs it as
  `systemd-run --user --scope --collect -- node <entry>`, in a transient
  scope of its own, after a quick probe that such a scope works. Otherwise
  (macOS, no systemd, no lingering, a failing probe) it starts as a plain
  detached process, as before: without lingering the user manager stops its
  scopes at logout, while a detached process survives it under the usual
  `KillUserProcesses=no`. `DSA_SCOPE=off` turns the scope off.
- **A launch the environment breaks does not use up the call.** When a
  subagent's `pi` cannot be launched because it is missing or not
  executable (`ENOENT`, `EACCES`), the call does not fail: its slots are
  released, it stays queued, its workflow journal records
  `spawn-env-failed{exec,command,error}`, and one `environment` alert says
  what failed, which `pi` it ran and how to fix it. The launch is retried
  every minute, and at once when the orchestrator restarts; the alert is
  resolved when a launch works. Stop the call to give up. Other launch
  errors still fail the call.
- **Every exit says why.** The ledger's `orchestrator-exit` carries
  `reason`: `idle` (no work for `k.idleExitMs`), `restart` (an applied
  restart request), `signal` (with `signal`, e.g. `SIGTERM`) or `error`
  (with the clipped `error`). A process killed outright (SIGKILL, a crash)
  records nothing. While none runs, `doctor` shows
  `orchestrator: not running; last exit: signal SIGTERM 5m ago`, or
  `no exit recorded (killed or crashed)`.
- Temporary files of interrupted writes (a full disk, say) are removed when
  a write fails, and the orchestrator's start removes those older than
  10 minutes from `$DSA_HOME/bin`.

### Resource leases

Benchmarks, timing measurements and big builds need the machine to
themselves. Instead of each subagent polling for an idle machine, wrap the
command:

```sh
pi-durable-subagents hold machine -- make bench          # exclusive
pi-durable-subagents hold machine --shared -- npm test   # with other shared holders, never with an exclusive one
pi-durable-subagents hold machine --max-wait 600 --note "profile" -- ./measure.sh
pi-durable-subagents hold build --slots 4 -- cargo test   # at most 4 at a time
pi-durable-subagents hold machine --priority 50 --expect 25m -- ./measure.sh
pi-durable-subagents hold machine --shared --yield -- ./advisory-check.sh
```

- The lease covers one command, not a whole call: a subagent that thinks
  or waits for an answer holds nothing.
- Waiters rank by `--priority N` (integer -100..100, default 0), higher
  first, then sequence. Incompatible granted holders always block. An
  exclusive request waits behind every ranked-ahead waiter; a shared one
  behind exclusive waiters. Higher priorities can overtake lower waiters,
  never incompatible holders; equal priorities keep the existing FIFO
  rules. Low priorities can starve. Every final grant is checked under the
  resource lock. A waiting `hold` prints who holds the resource; `--max-wait`
  gives up with exit 75 without running the command.
- `--slots N` (an integer of at least 1; not with `--shared`) makes the
  resource a counting semaphore: a request runs once fewer than N holders
  (slot or shared) hold it, no exclusive holder blocks it, and no
  ranked-ahead request of any kind still waits.
  Shared requests are not limited by slots but occupy them, and they do not
  queue behind a slot waiter, so a stream of shared requests can keep it
  waiting; use one mode and one N per resource name. `leases` shows
  ``build 3/4 held: pid 123 `cargo test` (slot, 2m), ...; waiting: 2 (first: pid 456, 30s)``,
  `leases --json` adds `slots` and `held` to the resource,
  and a waiting `hold` prints its position and `held k/N`.
- `--no-wait` (same as `--max-wait 0`) takes the lease now or not at all.
  It decides under the resource's lock. If it can run now, its request is
  written already granted. Otherwise nothing is written, and it exits 75
  naming who holds or waits, without running the command. It is never
  listed as a waiter, even for a moment, so it can probe a resource whose
  owner treats any queued request as interference. It can pass lower-priority
  waiters; equal- or higher-priority waiters block it by the same mode rules
  (a counted request waits behind every such waiter). It also leaves the
  resource alone: unlike a queued waiter, it does not end processes left
  by a holder whose `hold` was killed, and is refused while they remain.
- `--yield` makes a holder stop its command and descendants when a live
  waiter is blocked by it, even a lower-priority one. Compatible waiters
  and no-wait probes do not trigger it. Detection is within the poll
  interval plus one second; cleanup runs before release, then `hold` exits
  75. The command is not resumed or retried.
- `--expect` records an estimate, not a timeout or reservation: whole
  seconds, optionally `s`, `m` or `h` (`90`, `90s`, `25m`, `2h`), from one
  second through seven days (`604800s` or `168h`). Holder text shows
  `3m of ~25m`, waiter text `expects 25m` (the first waiter for counted
  listings). `leases --json` includes optional ticket fields `priority`,
  `yield: true` and `expectMs`; unused fields stay absent, old priority is 0.
- The command runs without a shell (write `-- sh -c '…'` for one) in its
  own process group, with `DSA_HOLD=<resource>:<seq>`; `DSA_EXEC` and
  `DSA_CALL` are unchanged. Signals to `hold` go to its group, and the exit
  status passes through unless it yields. Before release on command exit,
  yield, a forwarded signal followed by exit, or wrapper cleanup, the group
  and exact-tagged descendants are ended: TERM, grace, KILL and rescans,
  bounded to five seconds. If tags survive, it releases anyway and prints
  `hold: <n> processes tagged <tag> survived; releasing`.
- The lease lives as long as the `hold` process or its command lives, so a
  killed `hold` does not hand the machine over while the command still
  runs. If `hold` is killed and its command has exited, processes the
  command left in its group or with its tag still hold the lease; the next
  queued waiter ends them before proceeding, with the same cleanup bound
  (on macOS, a process that took over the command's pid is waited for, not
  ended). State is one small file per request under
  `$DSA_HOME/leases/<resource>/`; no orchestrator is needed, and the user's
  own shell can take part.
- A lease taken outside any call (your shell, a `systemd-run --user` unit)
  does not depend on the orchestrator: a restart, forced or not, leaves it
  held, and it is released when its `hold` and command end. A lease taken
  inside a call ends with that call's processes when the call is fenced.
- Subagents find the command on their `PATH` (the orchestrator puts a shim
  in `$DSA_HOME/bin`), and their leases are tagged with their call:
  `status` shows `lease: machine held by <wid>/<key> …; waiting: …` and
  `(holds lease machine)` / `(waiting for lease machine 3m)` on call lines.
  Tell a subagent in its task to run measurements under
  `pi-durable-subagents hold machine -- …`.
- Linux finds tags in `/proc/<pid>/environ`, including descendants in new
  groups or sessions. macOS uses `ps` when it exposes the tag, otherwise
  falls back to group-only cleanup. Clearing the tag and leaving the group
  can escape. Tags are not a security boundary; separate DSA homes should
  use distinct resource names to avoid identical tags.
- Priorities and yield take effect once every hold wrapper for the resource
  runs 1.1.0; upgrading the orchestrator alone does not update wrappers.
  Leases remain cooperative: processes started without `hold` are not held
  back.

Programs may treat exit 75 with any of these stable line forms as no check
verdict (identity and duration text in the middle varies):

```text
hold: <resource> is not free now (…); not running the command (exit 75)
hold: <resource> still held by … after …; not running the command (exit 75)
hold: yielded <resource> to <who> after <age>; the command was stopped (exit 75)
```

The first two never started the command; the yield line stopped it, so its
partial output is not a completed result.

## Configuration

State lives in `~/.pi/durable-subagents`; set `DSA_HOME` to move it.
`config.json` there is optional:

```json
{
  "defaultModel": "provider/id",
  "onQuit": "pause",
  "pools": { "fast": ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"] },
  "providers": { "anthropic": { "slots": 4 } },
  "memory": { "reserveMb": 2048, "perChildMb": 300 },
  "writerLock": "queue",
  "askRequireDecision": false,
  "exactCapture": true
}
```

- **Pools:** a model can name a pool (the `model` of a call, a `run --spec`
  file or a model send). The first candidate with a free slot is
  used, and a candidate that keeps failing is skipped for 10 minutes. The
  order is the preference: list the provider you want to use first.
- **Waiting before spilling over:** a pool entry can also be
  `{ "model": "<provider/id[:thinking]> or pool name", "afterMs": <ms> }`. A
  waiting call takes it only after it has waited `afterMs` for a slot; until
  then it waits for the entries before it. In
  `"opus": ["a/strong", "b/strong", {"model": "c/weaker", "afterMs": 600000}]`
  a call uses `c/weaker` only after 10 minutes without a free `a` or `b` slot.
  A nested pool's `afterMs` applies to every model it lists (the larger value
  wins when nested twice). It does not apply to a call that continues its own
  session's model or was asked for a model, and a running call that moves off
  a used-up provider skips such entries, as does a model send that names the
  pool.
- **Resumed pool calls:** keep their session's model for its prompt cache, but
  after 2 minutes queued on its full provider try another free provider in the
  same pool. Set `"k": { "resumeSpillMs": 120000 }` to change the wait;
  `0` spills immediately, `null` or a negative number keeps waiting indefinitely.
  The same model id on another provider is preferred, then pool order; the new
  entry's thinking level and `afterMs` apply. This continues the same session
  but gives up the old provider's prompt cache. Explicit models and models
  requested by the parent do not spill. The timer restarts for each execution,
  including recovery after an orchestrator restart, like `afterMs`.
  `status` shows the queued provider, elapsed wait and free pool providers,
  then the recorded spill and how long it waited (`poolWait` / `spill` in JSON).
- **Selected model unavailable:** before delivering work, the child verifies
  that pi activated the selected model (including catalog aliases and display
  names). Missing auth or a different model stops that execution; a pool call
  tries another entry and skips the unavailable entry for that call for 10
  minutes. A single-model call fails with the selected model, pi's fallback
  and the reason. `status` retains `modelUnavailable`; an unexpected answering
  model also shows `used Y, selected X` (`modelMismatch` in JSON).
- **A used-up provider** is not sent new calls until its next try, 15 minutes
  after it last refused (`"k": { "probeMs": 900000 }`). Then one call at a
  time goes to it, so finding out costs no extra request. A call that moved to
  another provider stays there for the rest of its generation (switching back
  mid-task would lose the prompt cache). Automatic failover is not a sticky
  choice: a follow-up starts from pool order again unless a manual choice
  stands. A manual pool choice resolves that pool again; a concrete choice
  has no fallback pool and waits for its provider. `status` lists each used-up
  provider with its next try,
  and `events <wid>` shows the move as a model `forward` naming the target
  (`model=<provider>/<id>`) and the provider it left (`failover=<provider>`);
  a model you send shows only its target.
- **Rehearsing failover:** `pi-durable-subagents drill failover` runs the
  real CLI, orchestrator and subagent pi processes in a temporary home, with
  two offline providers in a pool: the first refuses with a used-up window
  (`503 ... No available accounts`), the second answers. It checks, step by
  step, that a call moves to the second provider, that `status` lists the
  first with its next try, that a second call starts on the second provider,
  that after the probe interval (25 s here) the next call probes the first
  provider and finds it available, and that this call ends on it. Each step
  prints pass/fail and its time; the exit code is 0 only when all pass. Your
  home, providers and credentials are not used. `--json` prints the result as
  one object; `--keep` keeps the temporary directory and prints its path.
  Interrupted (Ctrl-C), it stops what it started and cleans up the same way
  (exit 130, or 143 for SIGTERM).
- **Provider slots:** never exceeded, including while a model switch is in
  progress. When several calls wait for a provider, a freed slot goes first to
  a call that ran before (resumed after an answer, a follow-up generation, a
  call recovered after a restart; its session and prompt cache are ready),
  then to the workflow origin (pi session or CLI) that holds fewer of that
  provider's slots, then to the call that has waited longest. A call yields
  only to waiters that found the provider full on a recent attempt, so a slot
  is not held back for a waiter that has gone, though it can stay free for up
  to about three tracker periods (`k.trackerMs`) until that waiter no longer
  counts as recent. The
  `afterMs` wait and the precedence of a call that ran before are computed
  anew for each execution: a call launched again (after a loss or a launch
  that failed) starts its wait over. `status` names the holders per origin when more than one
  holds a provider: `anthropic 4/4 (3 cli:alice@host, 1 session 01a11a3b)`.
- **Memory:** new subagents wait while memory is short. Running ones are
  never stopped for memory.
- **Writer lock:** `"queue"` (default) runs one writing call per git
  worktree (outside git: per directory) at a time; the others wait in order.
  `"off"` lets them run together and only reminds you of edits seen in the same
  worktree. Writes that do not go through a writing call (your own, or a
  `writer: false` call's bash) are not constrained.
- **Required ask decisions:** `"askRequireDecision": true` requires a nonblank
  `decision_needed` on every child ask and applies the structured-ask string
  limits, even when no other metadata is given. This boolean key defaults to
  false, is validated and participates in the orchestrator config hash.
  It is snapshotted when each child execution starts: changing it affects
  executions started afterwards, not a child already running; a resumed
  execution receives the current setting. False keeps question-only asks valid.
- **Quota notices in a successful answer:** `"exhaustedPatterns": ["额度已使用完毕"]` on a
  provider treats a message that says the usage window is used up as a quota
  failure, even when the gateway answered with HTTP 200. Each entry is a
  JavaScript regular expression, matched case-insensitively against an
  assistant message's combined text; a message that carries a tool call is
  never matched. A match marks the provider exhausted (avoided until its next
  probe), the message never becomes the call's result and the next model
  never sees it, and the call continues on the next usable model of its pool.
  Without one the call fails with `model-unavailable:` and the matched text
  clipped to 200 characters. Choose patterns specific to the gateway's notice:
  a broad pattern can also match an ordinary answer quoting it. An invalid
  expression is rejected when the configuration is loaded, with an error naming
  the provider; a pattern that still reaches a child is skipped there instead
  of breaking the child. The patterns are snapshotted when an execution
  starts, so a configuration change applies to later executions.
- **The exact capture:** `"exactCapture": false` stops the extension from
  writing the capture of the top-level sessions' provider requests
  (`$DSA_HOME/exact/<sessionId>.json`). An exact call then runs as a fork and
  says why (`no-capture`). The default is true; the key is validated and
  participates in the orchestrator config hash.
- **onQuit:** `"pause"` (default) pauses a session's running workflows when
  you quit that pi; `"continue"` lets them run on in the background.
- **Changes apply without a restart:** the orchestrator re-reads the file
  when it changes (`askRequireDecision` reaches a child at execution start,
  not mid-execution). A new slot limit, pool or default model applies to the
  next slot acquisition; slots already held are kept when a limit drops. An
  invalid change is not applied, and `status` reports it next to the settings
  still in effect (`config: <hash> since …`) and the slots held per provider.

## Switching back

Durable Subagents registers the tool `subagents`, so it can be installed
next to `pi-subagents` (tool `subagent`). To switch back:

1. Optionally, run `pi-durable-subagents drain` (running work finishes) or
   `pi-durable-subagents stop-all` (pauses everything; resumable later).
2. Optionally, run `pi-durable-subagents uninstall-service`.
3. In `~/.pi/agent/settings.json`, replace `npm:pi-durable-subagents` with
   `npm:pi-subagents` under `packages`. New sessions use it.

Journals and pending questions stay on disk. If you install Durable
Subagents again later, `resume` picks the work up.

## Survives pi upgrades

It uses only pi's public CLI, RPC and extension API, through root exports.
On load, it checks the pi exports and API methods it uses.

- If an execution surface is missing, Durable Subagents disables itself
  with one exact message. Running work is untouched. A subagent that
  starts on such a pi exits with that message, and its step fails after
  the usual retries instead of hanging.
- If a UI surface is missing, only the watch view is disabled.

`smoke` runs the same checks inside your pi.

## Updating Durable Subagents

Running work stays on the version it started with until you restart the
orchestrator. When the orchestrator runs another version than the one a pi
session loaded, that pi says so once, and `status` shows the running version
with a note. The orchestrator exits about 10 s (`k.idleExitMs`) after all
work ends: every workflow is finished in its current revision (done, failed,
stopped or parked) or held by `drain`. A workflow with an open question is not
finished, so a call hibernated on its question keeps the orchestrator running
(it holds no slot and costs little). The next start runs the new version. To switch sooner:

```sh
pi-durable-subagents restart          # or the subagents tool: action "restart"
```

The orchestrator refuses while any execution runs (a subagent process, or a
gate before a call's seal). The refusal groups executions by session with ages,
the leases each one holds (mode, how long, command, note: what a fence would cut
short) and a token for that exact set. Leases held outside those executions are
listed apart, since the restart leaves them held; no new execution starts while
it decides, so nothing slips in between. Calls waiting
for your answer (hibernated), waiting for a provider slot, or held by a drain
do not block it. Otherwise it exits and its successor starts at once from the
installed files and resumes every workflow: an asker keeps its question, a
queued call launches on the new version.

To interrupt those executions deliberately, first show the user the refusal's
list and obtain their explicit approval, then use its token and a non-empty
reason (at most 500 characters):

```sh
pi-durable-subagents restart --force <token> --reason "<why>"
# tool: {action:"restart", force:"<token>", reason:"<why>"}
```

A changed execution set is refused with a fresh list and token. With no live
executions no token is needed. Bare force cannot fence live executions, and the
tool rejects `force:true`. Subagents cannot force a restart, even from bash:
it would fence themselves and other sessions' work. That guard reads the
environment on purpose (`DSA_EXEC`/`DSA_CALL` and the request's initiator
call): it is a rail against accidents and instructions, not a security
boundary — a subagent runs as the same OS user and could signal the
orchestrator anyway. Force fences running
executions; they resume on the new version from their sessions, like after a
crash, so a tool call that was running is repeated or reported as interrupted.
A running execution cannot be handed over to the new orchestrator: each
subagent is a pi process the orchestrator drives over its stdin and stdout, and
those pipes end with the old process. A crash is no different: the successor
fences every execution that still runs (an execution that had already ended is
not counted as interrupted). Work that must survive a forced restart, such as a
long measurement, belongs outside the subagent's processes: use a durable
command call (`run --wake caller -- …`) or an external launcher such as
`systemd-run --user … pi-durable-subagents hold machine -- …`, with the
subagent only watching it.
The restart ledger records the reason and initiator; after the next start,
`status` shows who forced it and why for 24 hours.

An orchestrator reads requests only after it has recovered its workflows. Its
start costs the unfinished work plus a small check per finished workflow, not
the size of finished history: a call whose recovery completed is recorded in its
journal and not read again until something concerns it, and a settled workflow
(ended, nothing open) opens without decoding its journal, from a rebuildable
record in `DSA_HOME/cache/settled`; the journal is read when a request needs it.
Pinned files of a finished workflow are verified when a resume, revise or
follow-up uses them; a changed file refuses that request (`pin-failed`). A
follow-up generation that is already open when its files no longer verify (at a
restart, say) is sealed `failed` without starting a subagent, with an error
starting `pin-failed: ` that names the file; the workflow ends again, and once
the file is restored a later follow-up runs. The first start after upgrading
makes a one-time pass that writes these records and receipts (tens of seconds
on a large home). The ledger's `orchestrator` entry has `recovery: true`, and a
`recovered` entry with the time taken follows when recovery ends. So
a `restart` sent to one that just started waits for it (and says so); if no
orchestrator reaches the request in time, `restart` exits 75 and the request
stays pending — it is decided later, so do not send another.

To restart only when the machine is quiet, `drain` first (running calls finish
and nothing new starts in existing workflows), retry `restart` until it is
accepted, then `resume`. Never kill the orchestrator process: other sessions'
running calls would be interrupted without a check. An orchestrator from 1.0.17
or earlier does not know the restart request; `restart` then checks the
journals itself with the same token, reason and subagent checks and ends it with
SIGTERM, which is not atomic: a call launched in between is fenced and resumes.
The old orchestrator cannot record the new audit fields. A pi session started before the update still
loads the old extension; start a new one.

### Upgrading to 1.3.0

Restart the orchestrator on 1.3.0 and start a new pi session to load the new
extension before relying on the exact fork, the forked compaction context or
`exhaustedPatterns`; a child that is already running keeps the settings it
was started with. Existing journals, request digests and decisions keep their
meaning. A call with another context has no `exact` field, and a request
without the new fields keeps its digest.

An exact call needs a parent session that captured a request: a session that
made no provider request yet, or one with `"exactCapture": false`, produces a
rebuilt call (a fork) whose reason is shown in `status` and `describe`. A
fork on a compacted branch now pins the compaction's summary and kept entries
instead of the raw messages before it; an uncompacted branch is unchanged.

### Upgrading to 1.2.0

Restart the orchestrator on 1.2.0 and start a new pi session to load the new
extension before relying on structured asks or sticky model choices; an
already running child keeps its execution-start ask setting. Existing
journals, request digests and decisions keep their meaning. Plain asks keep
their JSON unchanged, and old model forwards remain execution-only. New live
manual model forwards carry optional `choice` (the original model or pool
name); sealed choices use `model-choice {rid, call, model}` entries. New
generation records carry optional `choice` and put it in `spec.model` (a
concrete choice also uses the existing generation `model` override). These
records are scoped to the call and revision, not another key or revision.

## What we do not promise

- Call specs are checked strictly when a call is first proposed: an unknown or
  misspelled field makes that call fail with a message naming it, instead of
  being ignored. A `revise` of an older, looser script therefore fails those
  calls loudly; calls already finished before the revision are kept as they
  were.
- A subagent whose processes cannot be killed (for example stuck in the
  kernel) keeps its model slot and memory reservation until a later sweep
  proves it gone, because it may still be calling the provider. You get one
  "outcome unknown" notice; other work keeps running.
- A tool that already ran inside a subagent may run again after a crash, if
  its result never reached the session. Make external side effects
  idempotent, or mark the step `once: true`: when an execution is cut off
  while a tool call is running (its result never arrived), the step then
  ends as `unknown` instead of repeating it. Cut off between tool calls, a
  `once` step continues like any other (nothing was left half done). A
  step cut off while its only unfinished tool call is the question it asked
  is not `unknown` either: it keeps waiting and resumes with the answer, also
  an answer given while dsa restarted. If it was cut off while another tool
  call ran beside the question, a `once` step still ends as `unknown`. A follow-up on an `unknown` step continues the
  same session as its next generation.
- After a crash, the model call that was in flight is paid for again.
- Process containment uses process tags plus a 1-second tracker. A process
  that clears its tag and leaves the process tree within its first second
  cannot be found. Lease tag discovery on macOS depends on `ps` exposing
  environments; otherwise only the command's group is covered. Even on
  Linux, lease cleanup releases after five seconds with a warning if tagged
  processes survive.
- Caller wakes use ordinary follow-up delivery, not a stronger guarantee:
  durable storage and an available orchestrator are needed, a held caller
  waits for resume, and stop, retired revisions or broken pins can prevent
  delivery. A wake lists at most 20 calls (then `… N more`), with at most
  4000 characters total, dropping earlier output to fit; agent results never get invented exit
  codes. `describe` and `status` retain the command result's last 16 KiB,
  not its whole output; read the command's log for the full interleaved text.
- Ended-process diagnostics are best effort, with a total 500 ms budget per
  fence; failed or timed-out recording does not prevent cleanup. A record
  lists SIGKILL targets, not proof of death: a process may exit or its pid
  may be reused before signalling, and identity rechecks can skip it.
  An append already in progress can finish after the budget expires.
  Recovery without a persisted direct-child identity omits roots (including
  orphaned descendants) from diagnostics but still fences them. Command
  lines can contain sensitive arguments, like other workflow diagnostics.
- The exact fork splices the payload of a request. A provider that refuses a
  request whose conversation does not start at the beginning of a conversation
  refuses it; the call fails with the provider's own error. The exact fork is
  one conversation deep: the child's own conversation grows with its turns,
  while the parent's conversation stays the one the capture holds. A capture
  of a session that compacted its context carries the compacted conversation,
  and a provider's cache window is short: an exact fork of a parent that has
  been idle for a while is exact but reads little cache.
- Model and tool behaviour belong to the models and tools you use.

## License

MIT © purboo. The builtin agent definitions are adapted from
[pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT, © Nico
Bailon); see `agents/LICENSE`.
