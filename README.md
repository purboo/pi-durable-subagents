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
| A provider's usage window runs out (`No available accounts`, usage limit, quota exceeded) | Found at the second refusal in a row, while pi is still retrying. A call in a pool continues **in the same session** on the pool's next model (within pi's next retry or two); new calls skip that provider. After 15 minutes the next call that wants it tries it once; when it answers, new calls and new generations use it again. A call with a single model waits for it instead of failing. Billing errors (402, insufficient balance) still fail at once. |
| Two subagents would write in the same worktree | Only one runs there at a time. A call that can write (its tools include `edit` or `write`, which pi's default tools do) holds its git worktree's writer lock from its launch until it ends, also while it waits for an answer. Another writer for that worktree waits in order, and status shows `waiting for writer lock: <root> held by <wid>/<key>`. `writer: false` (a call that does not write there), `isolation: "worktree"` and `"writerLock": "off"` opt out. |
| A subagent waits for an answer for a long time | It releases its model slot and memory, then resumes exactly once when you answer. |

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
subagents({ action: "status" })
```

`status` without a wid is brief: what runs, what asks (with the address to
answer) or failed, and one line per finished workflow. `status` with a wid
shows one workflow with outputs clipped; add `key` for one call's full result,
or `full: true` for everything. When a run replies `{submitted: {rid}}`
(its workflow was not created within 10 s), the rid works wherever a wid does.
A call's `model` in `status` is the model its last provider request used; a
requested switch not used yet shows as `switching`, a refused one as
`switchFailed`. A send naming a model replies with `model` and `effect`
(`next-request`, `next-execution` or `next-generation`).
A provider's refusal of the content (terms of service, usage policy) fails the
call at once with that error instead of retrying it.
With `tasks` or `chain`, top-level `model`, `timeoutMs`, `budget`, `isolation`,
`context`, `tools`, `skills` and `once` apply to every step that does not set
its own; other call fields there, and any of them beside a workflow script,
are refused rather than ignored.

Every run is asynchronous. The agent is woken once, when the workflow
finishes (the notice carries each subagent's result) or when a subagent asks
it something. Each verb means one thing, and a refusal says what would work:

| Verb | Applies to | Effect |
|---|---|---|
| `run` | — | Start one subagent, `tasks` in parallel, a `chain`, or a workflow script. An unknown agent name is refused before anything starts, with the list of agents. |
| `send steer` | a running subagent | Reaches it at its next safe point. To a finished one: refused, use `follow-up`; To one waiting on its question: it interrupts the question, and the subagent usually asks again; `answer` answers it. |
| `send follow-up` | a finished subagent | Continues the same session as a new generation (`key@2`). With `model` (a model or a pool's name), that generation runs on it. |
| `send answer` | an open question | Answers it once. |
| `send model` | any subagent | A running one switches at its next request; one asking, hibernated or waiting for a slot launches on it when it runs again. A pool's name picks its first model that is not used up (and, for a running call, has a free slot); the reply names the model picked, and a call from that pool stays in it. |
| `stop` | a subagent or a workflow | Final: `stopped`, usage kept, edits left as they are. |
| `drain` / `resume` | existing workflows | A reversible hold; runs started later are not held. |

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

Press `↓` on an empty editor, or type `/subagents`, to open the list, a floating panel: this
session's workflows (sessions are independent), newest first, every
subagent with its model, what it is doing and for how long, and its latest
line. Finished ones stay there,
dimmed, with their conclusion.

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
pi-durable-subagents status [wid] [--json]
pi-durable-subagents events <wid> [--json]   the meaningful timeline of one workflow
pi-durable-subagents tail [wid] [--json]
pi-durable-subagents start              start the orchestrator if work is pending; sends nothing
pi-durable-subagents resume [wid]       continue unfinished or parked work (undoes drain / stop-all)
pi-durable-subagents drain              hold existing workflows: running calls finish, nothing new starts in them
pi-durable-subagents stop <wid|call>
pi-durable-subagents stop-all           pause every existing workflow now; journals stay resumable
                                        (runs you start afterwards are not held)
pi-durable-subagents prune [wid] [--older-than <days>]
                                        delete finished workflows (done, failed, stopped); prints count and bytes freed
pi-durable-subagents restart [--force]  switch to the installed version (see "Updating Durable Subagents")
pi-durable-subagents hold <resource> [--shared] [--max-wait <s>] [--note <text>] -- <command…>
                                        run one command while holding a resource lease (see below)
pi-durable-subagents leases [--json]    who holds and who waits for each resource
pi-durable-subagents doctor [--json]    read-only health check; exits 1 when something needs you
pi-durable-subagents install-service    optional: run `start` at login and every 30 s (systemd / launchd)
pi-durable-subagents uninstall-service
```

The service only runs `start`: it never resumes work you drained or
stopped. Install the CLI globally (`npm i -g pi-durable-subagents`) before
`install-service`.

### Housekeeping

Journals are never compacted, so state only grows. `prune` removes finished
workflows: the named one, or all of them (only those that ended more than
`--older-than` days ago, if given). Parked and running workflows, and
workflows with a follow-up still open, are never pruned; naming one prints
why. The ledger keeps a one-line record of each pruned workflow, and it
never comes back. `doctor` shows disk use, workflows by status, the largest
journals, parked work, old open questions, and leftovers; each finding
comes with one command to fix it.

### Resource leases

Benchmarks, timing measurements and big builds need the machine to
themselves. Instead of each subagent polling for an idle machine, wrap the
command:

```sh
pi-durable-subagents hold machine -- make bench          # exclusive
pi-durable-subagents hold machine --shared -- npm test   # with other shared holders, never with an exclusive one
pi-durable-subagents hold machine --max-wait 600 --note "frame phase" -- ./measure.sh
```

- The lease covers one command, not a whole call: a subagent that thinks
  or waits for an answer holds nothing.
- Requests are served strictly in order. An exclusive request waits for
  everything before it, and keeps later shared requests out (no starvation).
  A waiting `hold` prints who holds the resource; `--max-wait` gives up with
  exit 75 without running the command.
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

- **Pools:** a model can name a pool. The first candidate with a free slot is
  used, and a candidate that keeps failing is skipped for 10 minutes. The
  order is the preference: list the provider you want to use first.
- **A used-up provider** is not sent new calls until its next try, 15 minutes
  after it last refused (`"k": { "probeMs": 900000 }`). Then one call at a
  time goes to it, so finding out costs no extra request. A call that moved to
  another provider stays there for the rest of its generation (switching back
  mid-task would lose the prompt cache); a follow-up starts on the first
  candidate again. `status` lists each used-up provider with its next try.
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
with a note. The orchestrator exits about 10 s after all work ends, and the
next start runs the new version. To switch sooner:

```sh
pi-durable-subagents restart          # or the subagents tool: action "restart"
```

The orchestrator refuses while any execution runs (a subagent process, or a
gate before a call's seal) and names each one with its session and age; no new
execution starts while it decides, so nothing slips in between. Calls waiting
for your answer (hibernated), waiting for a provider slot, or held by a drain
do not block it. Otherwise it exits and its successor starts at once from the
installed files and resumes every workflow: an asker keeps its question, a
queued call launches on the new version. `restart --force` (tool:
`force: true`) fences running executions instead of refusing; they resume on
the new version from their sessions, like after a crash, so a tool call that
was running is repeated or reported as interrupted.

To restart only when the machine is quiet, `drain` first (running calls finish
and nothing new starts in existing workflows), retry `restart` until it is
accepted, then `resume`. Never kill the orchestrator process: other sessions'
running calls would be interrupted without a check. An orchestrator from 1.0.17
or earlier does not know the restart request; `restart` then checks the
journals itself and ends it with SIGTERM, which is not atomic: a call launched
in between is fenced and resumes. A pi session started before the update still
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
  idempotent, or mark the step `once: true` (it then stops as `unknown`
  instead of repeating).
- After a crash, the model call that was in flight is paid for again.
- Process containment uses process tags plus a 1-second tracker. A process
  that clears its tag and leaves the process tree within its first second
  cannot be found.
- Model and tool behaviour belong to the models and tools you use.

## License

MIT © purboo. The builtin agent definitions are adapted from
[pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT, © Nico
Bailon); see `agents/LICENSE`.
