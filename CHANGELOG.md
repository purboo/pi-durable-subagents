# Changelog

## 1.0.14

- The running orchestrator's version is visible. `status` shows it
  (`orchestrator: 1.0.14 (pid …)`), and when it is not the version a pi
  session loaded (after an update, running work stays on the old one), that
  pi says so once and `status` adds a note: the orchestrator switches by
  itself about 10 s after all work ends. To switch sooner without stopping
  running calls: `drain`, wait until `status` no longer shows the old
  version, then `resume` from a pi session started after the update.
- Two subagents editing the same worktree are pointed out. When two calls
  that have not finished both used `edit` or `write` under the same git
  worktree, the main session that started them gets one reminder per pair,
  and `status` names the other call in `sharedWorktree`. A paused call that
  wrote still counts until it ends. Nothing is blocked; the reminder closes
  when either call ends. Writes made only through `bash`
  are not seen; calls with `isolation: "worktree"` have their own worktree.

## 1.0.13

- A subagent resumed after its execution was interrupted (the orchestrator
  restarted, the process died, a failover) is told that the processes its
  tools had started, background ones included, were stopped with it, and not
  to wait for them; an asker that hibernated while waiting is told the same
  with the answer. Before, it was told only to continue, and one slept on a
  test loop that no longer ran.
- The "no execution activity" alert names the tool command running and how
  long it has run (for example "running bash `make fault-matrix` for 14m"), so
  a long silent command reads differently from a stuck call.

## 1.0.12

- Slot, memory and model decisions read the orchestrator settings recorded in
  its ledger, the same state `status` reports, through one fold of that ledger
  shared by the executor and `status`; an orchestrator embedded with given
  settings records them as well. Journal readers use typed entries instead of
  casts. No change in behavior is intended.

## 1.0.11

- A gate whose processes outlive their fence is reported once: when the gate
  and the background sweep both recorded the failure at the same moment, a
  workflow could show the same "processes may still run" attention item twice
  (and the failure, the gate's unknown outcome and the resolution likewise).

## 1.0.10

- Provider failover for a used-up usage window. An error such as `503 No
  available accounts`, "usage limit" or "quota exceeded" (after pi's own
  retries) marks the provider used up instead of counting as a lost
  execution: a call in a pool continues in the same session on the pool's next
  model, and new calls skip the provider. After `k.probeMs` (15 minutes) the
  next call that wants it is admitted to it alone; when it answers, new calls
  and new generations go back to it. A call with a single model waits for the
  provider instead of failing. `status` lists used-up providers with their
  next try. Billing errors (402, insufficient balance) still fail at once.
  A short request rate limit ("429 … resets in 1 second") is not a used-up
  window and is retried as before. A follow-up naming a model runs on it even
  where the pool would start over.
- After a call moved to another model by a relaunch, the orchestrator now
  reads the session's model as pi restores it (from the last answer), so a
  later relaunch holds the slot of the provider it actually uses.

## 1.0.9

- `status` shows the model a call actually uses: the model of its last
  provider request. A requested switch not used yet shows as `switching`
  (also in the brief status), a switch the subagent refused as
  `switchFailed`. Before, `status` kept the model the execution started with,
  so a switch that had worked looked as if it had not.
- `send follow-up` with `model` runs the new generation on that model; it was
  ignored, and the generation continued on the session's model. A send that
  names a model replies with `model` and `effect`: `next-request` (a running
  call switches at its next request), `next-execution` or `next-generation`.
- `send model` to a call that is asking (hibernated) or still waiting for a
  slot is recorded and applied when it runs again, instead of being refused
  with `call-not-running`.
  A requested model applies once: afterwards the session and the pool choose
  as before. Withdrawing a follow-up that names a model withdraws the switch
  too.
- A provider's refusal of the content (terms of service, usage policy) fails
  the call at once with that error. It was retried as a lost execution five
  times and reported as `lost ×5`.

## 1.0.8

- pi stays responsive with a long history: the extension's polling in pi's
  main thread no longer re-reads it all. Workflow status folds only what a
  journal appended, the orchestrator ledger is indexed once per change, the
  attention check reads only this session's workflows, and an open question's
  card reads only what the child session appended. On a home with 60
  workflows and 356 calls, the dock refresh went from 4.5 ms to under 1 ms
  every half second, and an idle pi's busy time from about 4% to 1.5%.
- Calls finished more than 10 s ago keep their summary only; their transcript
  is read when shown. pi holds about 100 MB less and garbage collection no
  longer pauses typing.
- A change of `config.json` written twice quickly to the same size is no
  longer missed: the orchestrator compares the file's content.

## 1.0.7

- Changes to `config.json` (`defaultModel`, `pools`, `providers`, `memory`,
  `k`) apply without restarting the orchestrator: it checks the file about
  once a second and applies a valid change between slot admissions, so a call
  still waiting for a slot follows the new model, pool or limit. Slots already
  held are kept when a limit drops. An invalid change is refused and the
  settings in effect stay; `status` names the error until the file is valid
  again.
- `status` marks an asker whose execution hibernated with `hibernated: true`
  (CLI: "hibernated, no slot"): it holds no provider slot until it is
  answered. Both `status` forms list provider slots in use against their
  limits, and the config in effect.

## 1.0.6

- A follow-up on a finished workflow shows as running work: in the dock, the
  summary line, the list (no longer dimmed or hidden) and `status`. Quitting pi
  pauses it, and `resume` continues it; before, a resume refused it as finished.
- ↓ opens the subagent list only from pi's input editor. With `/model`'s
  selector, a dialog or another overlay in focus, ↓ moves in that list again.

## 1.0.5

- `status` without a wid is brief: what runs, what asks (with the address to
  answer) and what failed, with finished workflows one line each; it used to
  return every call's usage and last line (tens of thousands of tokens on a
  busy home). With a wid, outputs are clipped; `key` gives one call's full
  result and `full: true` the previous complete detail.
- A run's rid (from `{submitted: {rid}}`) works wherever a wid is expected.
- With `tasks` or `chain`, top-level `model`, `timeoutMs`, `budget`,
  `isolation`, `context`, `tools`, `skills` and `once` are defaults for every
  step; other fields there, or any call field beside a workflow script, are
  refused instead of silently ignored. Invalid fields report the value
  received.
- A call that keeps running without producing output tokens or tool results
  (for example, retrying against an exhausted provider) raises a
  "no progress" alert after 10 minutes (`k.progressMs`), with the last
  provider error. A call that ends on an explicit quota or billing error fails
  at once with `Provider error: …` instead of being relaunched; other lost
  executions report their last error.
- Attention reaches the main agent with the call's address; a question says
  how to answer it.
- `resume` without a wid names workflows that other sessions hold paused.

## 1.0.4

- The TUI no longer stalls pi with a long subagent history. Its 500 ms refresh
  re-read and re-derived every historical call's session and scanned journals
  once per call, taking over a second per refresh with a few hundred finished
  calls; it now reuses per-call facts and a journal index (about 5 ms).
- Main-session polling, attention cards and transcript cards reuse derived
  state per journal and per width instead of rescanning the session every
  200 ms, so typing stays responsive in long sessions.
- Faster startup: thinking summaries no longer use a regex that went
  quadratic on long unpunctuated thoughts (200 KB took 43 s), and finished
  calls' sessions are read when first shown or in small idle slices rather
  than all at startup.

## 1.0.3

- Recovery delivers a call's task when an earlier execution ended before its
  subagent received it (for example, an orchestrator restart while the call
  waited for a provider slot). It used to send only "Continue the task", and
  the fresh subagent had to guess what the task was.

## 1.0.2

The first published release (1.0.0 and 1.0.1 were prepared but never
published).

- Durable subagent workflows for pi. Requests, executions and results are
  journaled; a crash of pi, the orchestrator or the machine resumes the same
  sessions without running a finished call again.
- `subagents` tool for the main agent: `agents`, `run` (single call, `tasks`,
  `chain`, or a workflow script with `runs.run` / `runs.all` / `emit` / `args` /
  `runs.input`), `send` (steer a running subagent, follow up a finished one,
  answer, switch model; `replaces` supersedes an earlier send), `stop`,
  `revise`, `resume`, `drain`, `status`. Each verb has one meaning; every
  refusal names what would work (agent names, call addresses). The
  completion notice carries each subagent's result.
- Questions (`ask`) and structured reports (`report`) inside subagents;
  hibernation releases slots while a question waits; generations continue an
  ended subagent's session.
- Model pools, provider slots and memory admission that are never exceeded;
  active-time timeouts; per-call and workflow usage budgets; worktree
  isolation, fork context, gates and output artifacts.
- Quitting pi (Ctrl+D, `/quit`, a closed terminal) pauses that session's
  running workflows so nothing more is spent; `resume` continues them in the
  same sessions. A crash or `kill -9` lets them run on. `"onQuit": "continue"`
  keeps them running after a quit too.
- TUI: summary line and dock above the editor, a framed list (`↓` or
  `/subagents`) with a live preview per agent that doubles as a control surface
  (steer, follow-up, stop, model, answer, resume from the list), watch view with
  the streaming response, steering, model and thinking switches; interaction
  cards in the main transcript.
- CLI: `smoke`, `chaos` (nine offline fault scenarios), `status`, `events`,
  `tail`, `start`, `resume`, `drain`, `stop`, `stop-all`, `prune`, `doctor`,
  `install-service`, `uninstall-service`.
- Compatible with pi-subagents 0.75.0 scripts and agent files (builtin agents
  adapted under MIT); `researcher` and `evidence-auditor` use whichever web
  extension is installed.
- Requires Node.js 22.19 or later and pi 1.0.x.
- Model and thinking menus search fuzzily, by id or display name (`bedrock opus`
  finds `amazon-bedrock/claude-opus-4-5`). A requested model switch shows at
  once ("old → new, at the end of this step") until the subagent applies it.
- Calls waiting for a provider slot show as queued, with the model they asked
  for; the summary counts them apart from working ones.
- The dock is installed once per session: listed before another extension's
  editor bar (such as a powerline bar) in `packages`, it sits above that bar.
  `"ui": { "dockAt": "below" }` puts it below the editor.
- `/subagents` opens the list, like `↓` on an empty editor.
- A top-level `cwd` is the run's directory: relative workflow, input and call
  paths resolve against it.
- Install from npm, or from GitHub without a build step:
  `pi install git:github.com/purboo/pi-durable-subagents`.
