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
| Two subagents would write in the same worktree | Only one runs there at a time. A call that can write (its tools include `edit` or `write`, which pi's default tools do) holds its git worktree's writer lock from its launch until it ends, also while it waits for an answer. Another writer for that worktree waits in order, and status shows `waiting for writer lock: <root> held by <wid>/<key>`. `writer: false` (a call that does not write there), `isolation: "worktree"` and `"writerLock": "off"` opt out. |
| A subagent waits for an answer for a long time | It releases its model slot and memory, then resumes exactly once when you answer. The question survives orchestrator restarts (also forced ones) and crashes, including one that hits before the subagent released its slot. |
| A subagent's work ends (finished, stopped, or cut off) | Every process its tools started ends with that execution, also ones started with `nohup`, `setsid` or `&`: they carry the execution's tag (see the limit below). Anything that must outlive the subagent has to be started by you or the parent session. A command run under `hold` is no exception: a forced restart stops it and its lease is released. |
| A subagent runs in a worktree you made (`isolation: "none"`, the default, with `cwd`) | Durable Subagents never creates, cleans, moves or deletes that directory or its branch, also not on `prune`; `prune` deletes only its own state and the worktrees it created for `isolation: "worktree"`. |

## Use it

The main agent gets one tool, `subagents`. You ask in plain language, and
the agent calls it:

```text
subagents({ action: "agents" })
subagents({ agent: "worker", task: "Fix the flaky lease test" })
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
workflow's row when they fit). `status` with a wid
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
`{ tasks: [{ task: "…" }, { task: "…" }], agent: "reviewer" }`. A top-level
`task` beside a list is refused (agent + task is a single call); other call
fields there, and any of them beside a workflow script, are refused rather
than ignored.
When a call of a new run already waits for its worktree's writer lock as the
run reply is written, the reply names it: `writerWait: ["<wid>/<key> held by
<wid>/<key> (<root>)"]` with a hint that `writer: false` or
`isolation: "worktree"` opts out. The reply does not wait for this.

Every run is asynchronous. The agent is woken once, when the workflow
finishes (the notice carries each subagent's result) or when a subagent asks
it something. Each verb means one thing, and a refusal says what would work:

| Verb | Applies to | Effect |
|---|---|---|
| `run` | — | Start one subagent, `tasks` in parallel, a `chain`, or a workflow script. An unknown agent name is refused before anything starts, with the list of agents. |
| `send steer` | a running subagent | Reaches it at its next safe point. To a finished one: refused, use `follow-up`; To one waiting on its question: it interrupts the question, and the subagent usually asks again; `answer` answers it. |
| `send notify` | any subagent | Tells it a decision without disturbing it. The reply's `delivery` says how: `steered` (running: it gets the note at its next safe point, like a steer), `held-until-answer` (waiting on its question: never interrupts it; it gets the note at the first safe point after the answer) or `noted` (not running: nothing starts; the note is recorded, and the call's next follow-up opens with it). |
| `send follow-up` | a finished subagent | Continues the same session as a new generation (`key@2`). With `model` (a model or a pool's name), that generation runs on it. |
| `send answer` | an open question | Answers it once. |
| `send model` | any subagent | A running one switches at its next request; one asking, hibernated or waiting for a slot launches on it when it runs again. A pool's name picks its first model that is not used up (and, for a running call, has a free slot); the reply names the model picked, and a call from that pool stays in it. |
| `stop` | a subagent or a workflow | Final: `stopped`, usage kept, edits left as they are. |
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

The result has `ok`, `status`, the full `output` text and the structured
`data`.

A script is replayed after a crash. Finished calls are not run again, and a
changed script is detected rather than silently mixed. Keep scripts
deterministic: use `now()`/`random()`, not `Date`/`Math.random`.

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

Subagents that another pi session or the CLI started never get rows in this
dock; while they run, the summary line adds a count, e.g.
`elsewhere: 4 running (cli 2, 1 session 2)` (dropped first when the line is
tight, and shown alone when this session has nothing running).

Press `↓` on an empty editor, or type `/subagents`, to open the list, a floating panel: this
session's workflows (sessions are independent), newest first, every
subagent with its model, what it is doing and for how long, and its latest
line. Finished ones stay there,
dimmed, with their conclusion.

Live workflows of other sessions and the CLI follow in one group at the end,
`Other sessions (2 workflows, 4 running)`, folded until you press `Enter` on
it. Each shows its wid, name, origin (`cli:<user>@<host>` or a short session
id), labels and live calls. You can watch them, but not change them here:
steer, stop, model, answer and follow-up are refused with a hint to use the
session or CLI that started them (or the tool's `send` with an explicit
address). `"ui": { "otherSessions": false }` hides both the count and the
group.

The list is also where you act. The footer shows the keys for the selected
row: `Enter` watch, `s` steer, `f` follow-up, `x` stop (asks `y` first),
`m` model, `a` answer. A one-line input opens at the bottom (paste works),
and the result shows right there: `✓ applied` or the reason it was not.

`Enter` opens a subagent full screen: its task, thinking, tool calls and
output, rendered with pi's own components. `←`/`→` switch between the
subagents of one workflow. Scrolling up pauses following; pi's
`↓ Jump to latest message · End` badge (or `End`, or a click) brings you back.

Typing steers the subagent you are watching (`Alt+Enter` queues a
follow-up instead), or answers it if it is asking you something. `/model`
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
pi-durable-subagents run --request <id> --spec <file|-> [--labels <json>] [--cwd <dir>] [--json] [--wait-ms <n>]
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
pi-durable-subagents hold <resource> [--shared | --slots <n>] [--max-wait <s> | --no-wait] [--note <text>] -- <command…>
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
`subagents` tool's run form (`{agent, task, model?, schema?, …}` or
`{tasks: […], name?, usageBudget?, maxCalls?}`); `context: "fork"` needs a pi
session and is rejected.

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
not part of the digest. A retry of the same id from another session therefore
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
`spec_digest`, and `labels` when the run has any. Live calls also show what
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
until the answer) is `asking`, not waiting. Once the answer arrives the call
launches again, and from then on it waits like any call (for a slot, the
writer lock, …) even though `describe` still lists the question as open until
the new execution reads it (its `state` stays `asking`). A drained call
(no execution running) is never `silent`; a sealed call never waits. `provider-exhausted`, `writer-lock`, `lease` and `slot` are queues
that clear by themselves; `silent` and `unconfirmed-stop` may need a look.

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
none), `readBytes` (bytes the process read since it started, from
`/proc/self/io`; absent where there is none), `pid` and `at` (when it was
written). The orchestrator writes these to `orchestrator-stats.json` every
10 s; they are shown only while that process runs.

### Resource leases

Benchmarks, timing measurements and big builds need the machine to
themselves. Instead of each subagent polling for an idle machine, wrap the
command:

```sh
pi-durable-subagents hold machine -- make bench          # exclusive
pi-durable-subagents hold machine --shared -- npm test   # with other shared holders, never with an exclusive one
pi-durable-subagents hold machine --max-wait 600 --note "profile" -- ./measure.sh
pi-durable-subagents hold build --slots 4 -- cargo test   # at most 4 at a time
```

- The lease covers one command, not a whole call: a subagent that thinks
  or waits for an answer holds nothing.
- Requests are served strictly in order. An exclusive request waits for
  everything before it, and keeps later shared requests out (no starvation).
  A waiting `hold` prints who holds the resource; `--max-wait` gives up with
  exit 75 without running the command.
- `--slots N` (an integer of at least 1; not with `--shared`) makes the
  resource a counting semaphore: a request runs once fewer than N holders
  (slot or shared) hold it, no exclusive request is ahead of it, and no
  earlier request of any kind still waits, so it never overtakes a waiter.
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
  owner treats any queued request as interference. It also leaves the
  resource alone: unlike a queued waiter, it does not end processes left
  by a holder whose `hold` was killed, and is refused while they remain.
- The command runs without a shell (write `-- sh -c '…'` for one) in its
  own process group; signals to `hold` go to it and its exit status is
  returned. When it exits, whatever it left in its process group is ended
  before the lease passes on.
- The lease lives as long as the `hold` process or its command lives, so a
  killed `hold` does not hand the machine over while the command still
  runs. If `hold` is killed and its command has exited, processes the
  command left in its group still hold the lease; the next waiter ends them
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
- Leases are cooperative: processes started without `hold` are not held
  back, and a daemon that leaves the process group is not covered.

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
  "writerLock": "queue"
}
```

- **Pools:** a model can name a pool (the `model` of a call, a `run --spec`
  file or a model send). The first candidate with a free slot is
  used, and a candidate that keeps failing is skipped for 10 minutes. The
  order is the preference: list the provider you want to use first.
- **A used-up provider** is not sent new calls until its next try, 15 minutes
  after it last refused (`"k": { "probeMs": 900000 }`). Then one call at a
  time goes to it, so finding out costs no extra request. A call that moved to
  another provider stays there for the rest of its generation (switching back
  mid-task would lose the prompt cache); a follow-up starts on the first
  candidate again. `status` lists each used-up provider with its next try,
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
  progress.
- **Memory:** new subagents wait while memory is short. Running ones are
  never stopped for memory.
- **Writer lock:** `"queue"` (default) runs one writing call per git
  worktree (outside git: per directory) at a time; the others wait in order.
  `"off"` lets them run together and only reminds you of edits seen in the same
  worktree. Writes that do not go through a writing call (your own, or a
  `writer: false` call's bash) are not constrained.
- **onQuit:** `"pause"` (default) pauses a session's running workflows when
  you quit that pi; `"continue"` lets them run on in the background.
- **Changes apply without a restart:** the orchestrator re-reads the file
  when it changes. A new slot limit, pool or default model applies to the next
  slot acquisition; slots already held are kept when a limit drops. An
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
long measurement, belongs outside the subagent's processes (for example
`systemd-run --user … pi-durable-subagents hold machine -- …`), with the
subagent only watching it.
The restart ledger records the reason and initiator; after the next start,
`status` shows who forced it and why for 24 hours.

An orchestrator reads requests only after it has recovered its workflows, so
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
  cannot be found.
- Model and tool behaviour belong to the models and tools you use.

## License

MIT © purboo. The builtin agent definitions are adapted from
[pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT, © Nico
Bailon); see `agents/LICENSE`.
