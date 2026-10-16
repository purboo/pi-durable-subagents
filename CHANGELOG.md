# Changelog

## 1.0.45

- 1.0.44 was tagged but never published: its release checks failed on macOS. 1.0.45 is the first release with
  command calls; on macOS, too, an argv whose program path does not exist ends with 127.
- Command calls: a call spec with `command` (an argv array, or a string for `/bin/sh -c`) instead of `agent`/`task`
  runs the command without a model, a provider slot or tokens, and wakes the session that started it like any finished
  call. Use it for a long build, a test suite or a wait that should not keep an agent busy. It works in every launch
  form (single call, `tasks`, `chain`, `runs.run` in a script, `run --request`) and takes `cwd`, `timeoutMs`
  (wall-clock from its start), `env` (added to the orchestrator's environment; `DSA_*` is reserved), `rerun` and
  `writer` (default `false`). See README, "Command calls".
- An argv array runs a program, never shell syntax: its first element is looked up on the command's `PATH` (127 when
  no program has it, 126 when the file is not executable), and a shell builtin name such as `exit` is not run as a
  builtin. A string runs through `/bin/sh -c`. The wrapper that records the exit status works under any `env` the
  command gets (`PATH` unset or bogus, `IFS`, locale).
- Result: exit 0 is `ok`, another status `failed`, past `timeoutMs` `timeout`, `stop` `stopped`; `data` is
  `{exitCode, signal, durationMs}` and `output` the last 16 KiB of the interleaved stdout/stderr log. Stop and timeout
  end the whole process tree, including detached descendants. Steer, follow-up, answer, model and notify are refused
  with one reason, from the tool and the CLI alike (an `answer` without `qid` included).
- The timeout counts from the command's start, also while no orchestrator runs: a command that ended in time is `ok`
  or `failed` even when its result is recorded later, and one that ended after its deadline is `timeout` (its exit
  status still in `data`).
- A command outlives the orchestrator: a restart (also a forced one), an idle exit, a crash, a quitting pi session or
  `stop-all` leaves it running; the next orchestrator takes it over, or records its result if it ended meanwhile. It
  never runs twice at once. A process gone without an exit record ends `unknown`, or with `rerun: true` starts once
  more. Restart refusals do not count command calls as busy and say how many keep running.
- A hold (`drain`, `stop-all`, a quitting pi) prevents a command call from starting and never stops one that started.
  One not started yet (also one waiting for its worktree's writer lock, and the one `rerun`) starts after `resume`.
  One that started runs to its end and its result is delivered as without the hold, also after an orchestrator
  restart: a held workflow with a running command counts as pending work, so `start` and a pi session start an
  orchestrator for it, and a workflow that is then complete finishes and sends its notice. A call it wants next waits
  for `resume`.
- In a chain, a command step gets no `{previous}` substitution; an agent step after it gets its output.
- Status, describe and the subagent view show a command call's command, pid, attempt, elapsed time and log path
  instead of a model.
- Fixed: an orchestrator started from inside a call (a subagent or a command running the CLI) inherited that call's
  identity (`DSA_EXEC`, `DSA_CALL` and the other per-call variables), so the end or stop of that call could also end
  the orchestrator. It now starts without them.
- Downgrade: once a command call has run, an older version is unsupported. Its orchestrator exits at startup with
  `Unknown pinned agent: undefined` and changes nothing; installing 1.0.44 again recovers.

## 1.0.43

Steady-state cost no longer grows with history. Behaviour, file formats and recorded decisions are unchanged.
Measured on a copy of a real home (2084 workflows, 51k orchestrator ledger entries):

- Orchestrator memory: after a restart and 60 s idle, RSS 751 MiB in 1.0.42 and about 320 MiB now (under 200 MiB a
  minute later); JS heap 468 MiB -> 91 MiB. A terminal workflow releases its pinned agents and sources after 1 s idle
  and reloads them, checked as before, when a request needs them; a damaged pin still seals only that follow-up
  `pin-failed`. The sweep keeps process identities only for executions that were never fenced (a fenced execution
  keeps its tag, so a straggler is still found and killed after a restart). The orchestrator's outbox keeps only
  pending requests in memory.
- Request intake costs the new work, not the history: the orchestrator folds its ledger incrementally and indexes open
  requests, and decisions get a read-only view instead of a deep copy. With one request every 5 s the orchestrator used
  26.6 CPU s/min in 1.0.42 and 1.7 now; a pass with nothing new fell from 264 ms to 0.5 ms.
- CLI request lookups filter journal lines by bytes before decoding them and remember, per file, which request ids a
  verified prefix does not contain (no envelopes are kept). `send`: 4.1 s -> 1.5 s CPU and 455 -> 130 MiB RSS; `run`
  3.7 -> 1.2 s; `describe --key` 1.7 -> 1.0 s. A cold `status` is unchanged.
- The pi session reads its own outbox incrementally instead of folding it on every poll.
- A restart reaches the evaluator in about 2.5 s. Upgrading from 1.0.42 needs no one-time pass (the first start took
  2.6 s on this home); upgrading from 1.0.41 still runs the one-time pass of 1.0.42 (about 40 s on this home).

## 1.0.42

- The orchestrator starts in seconds on a large home. Measured on a copy of a real home (2084 workflows, 432 MB of
  journals): a restart reached the evaluator after 82 s in 1.0.41 and after 3.5 s now; peak memory fell from 1.5 GiB
  to about 710 MiB. Recovery records a receipt per recovered call and skips calls whose receipt is still current;
  lookups that scanned every journal per call are indexed; pinned files of terminal workflows are checked when a
  request needs them rather than at every start.
- Settled workflows open without decoding their journals. A rebuildable record under `cache/settled/` (validated
  against the journal's inode, size, entry count and last line; any mismatch takes the full path and rewrites it)
  stands in until something reads or appends to the journal, which then decodes it in full. Only terminal workflows
  with nothing left for recovery to do are eligible.
- The first start after upgrading does a one-time pass that writes the receipts and records (about 40 s on the home
  above).
- A pinned file that changed no longer stops the orchestrator or leaves a generation hanging: the generation's call
  is sealed `failed` with `pin-failed: <file>` without starting a child, and a follow-up runs again once the file is
  restored. Resume, revise and follow-up of such a workflow are refused with `pin-failed`.
- `status` says why a queued call does not move: `orchestrator starting (<age>)` while the orchestrator recovers
  (also on the orchestrator line), the writer lock, a full provider (`waiting for a free slot (<provider> n/n)`) or a
  used-up usage window. Without evidence it says only `queued`; an answered asker shows `queued (answered)`.
- The orchestrator ledger records `recovery: true` on its start entry and a `recovered` entry with the recovery time
  and counts.

## 1.0.41

- An answer that races the planned hibernation no longer strands its call. In 1.0.40 the parent forwarded an answer,
  the call hibernated two seconds later, the child had already read the answer and was fenced, and the call showed
  `asking` for 49 minutes until a second answer arrived. Hibernation is now decided on the current journal inside the
  serial section and is refused while an answer forward to the call is pending or in flight. A call fenced while
  stopped on that `ask` (hibernated on the question, or the answer receipt is the last thing it did) is treated as
  answered and continues its session at once, live and after recovery; a call that kept working after the answer is
  judged by its own evidence as before (report, `once` with a dangling tool, losses). `status` flags an answer that
  was forwarded but not delivered within 30 seconds.
- A bound answer excuses losses only for the execution it was bound to and for the first launch that never started a
  child. A child that keeps dying before its first marker now stops at `lossBound` instead of relaunching without
  limit (a defect since before 1.0.40).
- A resumed pool call no longer waits a whole turn on its session's full provider. After `k.resumeSpillMs` (default
  120000; `0` at once; `null` or negative never) it continues the same session on another entry of its pool that has a
  free slot, preferring the same model id (compared by its last path segment, case-insensitively, without thinking
  suffix). Explicit models and models requested by the parent never spill. `status` shows the wait, the free pool
  providers and the spill. The wait timer restarts after recovery.
- A child never answers with a model dsa did not select. The child extension checks the active model at session
  start and before every turn; a mismatch (for example pi falling back to its default model because the selected
  provider has no credentials) stops the execution before its first request and records `model-unavailable` with
  the reason. A pool call fails over to the next entry and skips the failed one for ten minutes; a call with an
  explicit model fails naming both models. Virtual (routed) models must activate at launch; their answers name the
  routed physical model, shown as `routed Y`. Any other answer from an unselected model shows `used Y, selected X`.
  A refusal is rechecked once against fresh credentials of that provider first: pi can answer `setModel` from an
  availability snapshot that a startup refresh briefly replaced (seen after resumes on CI), which is not a missing
  credential.
- Slot waits are journaled once per wait episode; free providers are computed live for `status`.

## 1.0.40

- Readers keep rebuildable digests of settled workflows and facts of final calls in `DSA_HOME/cache`, keyed by
  journal or session identity and the deriving code. Prune removes these cache entries with their workflow.

- A pi session uses these digests for its own workflows, keeps unchanged workflow objects, and releases settled
  journals and fold state after each pass. An unchanged ledger permits at most five seconds without journal IO;
  a ledger change forces a check, and turn boundaries check immediately for late attention. Final call facts release
  their transcripts and recheck session identity within
  five seconds. Concurrent cache writes are atomic, checked, and cannot recreate a pruned workflow's cache.
- Pi readers fold the ledger's committed prefix in bounded chunks into compact per-home state, without retaining
  decoded history. Replacement and truncation rebuild it. Unchanged passes skip the workflow directory scan and
  reuse settled results and the ordered UI view by identity; the dock and open list do not request redundant renders.
  Incomplete creation or revision intents and unsettled workflows are still checked on the next pass.
- Workflows with pending undelivered follow-ups or unfinished recovery bookkeeping are not settled. Recovery-only
  follow-ups therefore appear on the next poll, even without a new ledger entry. Missing completion notices, pending
  forwards, fences, gates, successful worktree cleanup and retired questions also prevent the trust window.
- `scripts/bench-ui.ts` uses a temporary cache and reports steady RSS and live heap after history release. `--cache-home`
  reuses caches for a second run; `node --expose-gc` collects released history before and after steady-state polling.
- Measured against 1.0.39 on a home with 1,530 workflows, for a session owning 197 of them (load 1.3, warm cache): a
  steady refresh fell from 9.0 ms to 2.7 ms (p50), the steady RSS from 345 MiB to 145 MiB with a 26 MiB live heap, the
  first refresh from 1.2 s to 0.4 s and the session-start notice from 0.71 s to 0.12 s. With an empty cache the first
  refresh is unchanged (1.2 s) and the RSS stays near 300 MiB until the allocator returns memory.

## 1.0.39

- A pi session reads only its own workflows. Since 1.0.30 the UI shows only the workflows of its session, yet the pi
  process read, folded and cached every workflow journal of the machine every 500 ms. Ownership is now decided from
  the orchestrator ledger (the origin of a workflow's create-intent or `created`, or the session its run named)
  before any journal is opened, so other sessions' journals are never opened, stat'ed or cached by a pi process.
  Measured on a home with 1,132 workflows (load 16-27): the first refresh of a busy session fell from 9.4 s to 1.6 s,
  a steady refresh from 86 ms to 7 ms and the process RSS from 696 MiB to 325 MiB; a session without workflows went
  from 17.7 s to 0.4 s and 683 MiB to 166 MiB. A session that many runs name (here 759 workflows) still reads all of
  them, so its gain is smaller. `scripts/bench-ui.ts` measures this (read-only).
- Session start no longer scans every journal: the starter checks whether an orchestrator holds its lock first and
  scans only when none does; the scan stops at the first unfinished workflow and does not keep the journals it read.
  The paused notice at session start and the pause on quit read only the workflows the session started.
- A workflow directory the ledger does not know (only a hand-made or damaged home has one) is attributed by its
  journal's first entry, read once; a failed read is retried once the file changes.
- The CLI (`status`, `restart`) and the orchestrator are unchanged.

## 1.0.38

- An answer to any open question of a call reaches it. A call whose question was interrupted (by a steer) and that
  asked again in other words while waiting no longer orphans the answer to the first question: a waiting subagent
  takes it as the result of its current question, a hibernated one resumes with it (also when the answer was sent
  before it hibernated), and a subagent that is not waiting gets it as a message at its next safe point. Before, an
  answer to a question other than the one the subagent waited on was held until a later ask, usually forever, and
  then retired.
- One rule for answers: an answer (or the answer a hibernated asker resumes with) to an open question is delivered
  once, at the first chance, never held. A waiting subagent prefers the answer to the question it waits on when
  several are pending. Follow-ups sent before a pending answer still enter ahead of it, notifies after it.
- An answer to an earlier question that ends the wait on a later one supersedes the later question: the subagent is
  told it was withdrawn and to ask again if it still needs it, its attention item resolves `superseded` (at once when
  the answer is bound to a hibernated call), `status` no longer shows the call `asking`, and a later answer to it is
  refused `stale-rev`.
- A question revision gets at most one answer receipt. An answer sent before the call hibernated and bound to the
  hibernation is withdrawn from the subagent's inbox; any further envelope for an answered, superseded or stale
  revision is dropped with a receipt, so nothing waits on it. These records survive a crash between their writes: a
  supersession is derived from the binding that made it, an adoption whose withdrawal went out is completed first, and
  a bound answer the session had already closed is settled without waiting for a receipt. An answer bound to a revision
  the subagent has already asked again is not delivered: the call hibernates again and the parent is asked the newer
  revision.
- A follow-up generation no longer re-opens the questions of the session it continues (its subagent would refuse
  their answers). Items that 1.0.37 re-opened in a running generation are resolved `carried` at orchestrator start.
- Follow-ups queued while a call waited on its question reach the resumed model before the answer, in send order.

## 1.0.37

- The process table runs `ps` by its absolute path (`/bin/ps`), so an orchestrator started with a minimal PATH keeps
  working on macOS.
- Contains every change listed under 1.0.36, which was tagged but not published (its macOS CI failed on this).

## 1.0.36

- Slot precedence among waiting calls. When a provider slot frees, a call resuming earlier work (an answered
  question, a follow-up, a recovery) is admitted before a fresh call; among equals the origin holding fewer slots of
  that provider goes first, then the longest waiter. A waiter holds a slot back from others only while it is still
  trying; one that is gone (stopped, interrupted, or silent for about 3 tracker periods) is ignored.
- Pool entries can wait before a pool spills over to them: `{"model": "provider/id", "afterMs": 600000}` is used only
  after the call has waited that long for the entries before it. Failover and a model request that names the pool
  skip such entries. The wait and the resume precedence are recomputed for each execution.
- `status` names the slot holders of a provider by origin when more than one origin holds it.
- An answered question no longer shows its call as `asking` while the call waits for a slot: it is `queued` with
  `answered: "<qid>"` (and still `hibernated`). The question's attention resolves when the answer is bound, and the
  `answered` event is emitted then (journals written before 1.0.36 still emit it once, at resolution).
- A follow-up running on a finished run shows `active: true`. `status` keeps meaning the run's result, so scripts that
  read it are unaffected; the text renderings lead with `follow-up running (run done)`.
- The orchestrator no longer depends on whoever started it. The starter resolves `pi` to an absolute path and passes
  it as `DSA_PI_BIN`; `run` and `send` refuse with exit 75 when no `pi` can be found, and the submitted request stays
  pending. On Linux with a lingering systemd user manager the orchestrator runs in its own transient scope, so the end
  of a oneshot unit, cron job or CI step does not end it. Subagents get the orchestrator's node directory on their
  PATH.
- A launch that fails because `pi` is missing or not executable (ENOENT, EACCES) keeps the call queued, raises one
  `environment` alert, releases its slots and retries every 60 s (at once after a restart). Only one dispatch message
  is pending however many retries fail. Other launch failures stay terminal.
- The orchestrator records why it exited (idle, restart, signal, error); `doctor` shows the last reason. Stale
  temporary files in `$DSA_HOME/bin` are removed at start.

## 1.0.35

- Generation openings of one workflow are serialized. The reopen of undelivered follow-ups at orchestrator start, the
  one after each seal and a follow-up sent to a sealed call could each find the same key unopened and open its next
  generation twice (seen after a restart while a reopened generation sealed). A follow-up that finds a generation
  opened meanwhile is deferred and then reaches that generation.
- Releases publish to npm through trusted publishing (OIDC, no token) from the `npm` environment, with provenance.
  Workflows run with read-only permissions by default.

## 1.0.34

- A follow-up queued into running work is no longer lost when that generation ends before taking it. The next
  generation opens with it, after any pending notes. A follow-up sent to the finished call in the meantime takes the
  queued ones along, in the order sent (`generation.follows`). Restarts open it once. Only a stop drops it, because
  a stop is final; a withdrawn one is gone too. The executor marks such a forward `forward-retired` with reason
  `undelivered-follow-up`.
- The send reply says where a follow-up went. One that opened a generation has `generation` and `call`, from the CLI
  and now also from the pi tool. One queued into running work has `delivery: "forwarded"` and
  `call: "<wid>/<key>@<gen>"`. A retry of the same request names the generation it went into.
- Typing in the watch view to a finished subagent sends a follow-up. Before, it sent a steer, which the orchestrator
  refused with `finished:<status> — use kind "follow-up"`.

## 1.0.33

- A run copies its origin session branch only when it can use it: its script
  quotes `"fork"` or a string in its `args` is `"fork"`. Before, every run
  started from pi copied the whole branch (tens of MB for a long session)
  into `pinned/origin.jsonl` and its staging snapshot, read it at admission
  and hashed it at every orchestrator start, although almost no run forks.
  Existing workflows keep their copies until they are pruned.
- `orchestratorStats.readBytes` counts the orchestrator's own reads (its
  threads' `rchar`). It used `/proc/self/io`, where Linux adds every reaped
  child's I/O to the parent: each finished call added everything its
  subagent's builds and tests had read, which looked like the orchestrator
  reading gigabytes per second.
- A workflow started without `name` is shown by its label values
  (`ipc-qa c4811f14`) in the dock, `/subagents`, the watch view and the
  completion notice, instead of by its agent name.

## 1.0.32

- `/subagents` lists working workflows first (newest first) and finished ones
  after them (most recently ended first), so running work is never buried
  under a page of finished rows. The cursor stays on its row when a workflow
  moves.
- Rows name subagents the way people know them: a workflow's only subagent by
  the workflow's name, a generated key (`tasks:0`, `chain:1`) by its agent,
  numbered when repeated (`worker 1`, `worker 2`). Applies to the list, the
  dock, the watch view and the input prompts; tools and the CLI keep the key
  as the address. A name longer than the key column is clipped so columns
  stay aligned.

## 1.0.31

- A run can be shown in the pi session it was started for, not only the one
  that sent it. pi exports `DSA_SESSION=<session id>` to the processes it
  starts, and `run` takes `--session <id>` (default: an inherited
  `$DSA_SESSION`, ignored inside a subagent). A tool or script started from a
  pi session therefore has its runs listed in that session's dock and
  `/subagents`, sorted first in `status`. Display and ownership only:
  completion notices and attention still go to the sender, quitting pi does not
  pause these runs, and `session` is not part of a request's digest. An invalid
  `--session` exits 1; the engine rejects an invalid id with `invalid-session`.

## 1.0.30

- The pi UI shows only the subagents this pi session started again: the
  dock's `elsewhere: ...` count and the `Other sessions` group from 1.0.29 are
  removed, and the `ui.otherSessions` setting is ignored. Other sessions' and
  the CLI's work remains visible through `status` and the CLI.

## 1.0.29

- The pi UI shows subagents that other sessions or the CLI started, kept apart
  from this session's: the dock's summary line adds
  `elsewhere: 4 running (cli 2, 1 session 2)` (dropped first when the line is
  narrow; shown alone when this session runs nothing), and `/subagents` ends
  with a folded `Other sessions` group listing their running workflows with
  name, origin and labels. They can be watched but not changed from here: the
  list's change keys and the watch view's input, model and stop controls
  refuse them, decided by the workflow's origin. `ui.otherSessions: false`
  turns this off.

## 1.0.28

- Lower orchestrator cost. A finished workflow's journal is closed about a
  second after its last write and reopened on demand, so finished workflows
  cost nothing while nothing touches them (before: one open file and periodic
  work per workflow ever run). Live calls now look only at session entries
  appended since the last check instead of rescanning the whole session every
  second, and the process scan indexes the process table once per pass.
  Measured in an isolated home: idle with 300 finished workflows about 0.006
  core (was 0.03); 3 live calls with 20 MB sessions about 0.03 core (was 0.07,
  growing with session size).
- `status --json` and `doctor --json` include `orchestratorStats` (workflows,
  live workflows, open journals, intake passes per second, bytes read); text
  `status` shows it on one line.
- `send kind:"notify"` tells a call a decision without disturbing it: a
  running call gets it at its next safe point (`steered`), a call waiting on
  its question gets it after the answer (`held-until-answer`), and a call that
  is not running starts nothing: the note is recorded (`noted`) and its next
  follow-up opens with every pending note, once. Restart the orchestrator after
  upgrading before using it; an older orchestrator makes the client refuse it.
- `to` may list several calls for `steer`, `notify`, `follow-up` and `model`
  (CLI: repeated `--to`); each target is decided on its own and the reply has
  one entry per target. A retry with the same request id and list is
  idempotent; another list under that id is a `request-conflict`.
- `hold <name> --slots N -- <cmd>` is a counted lease: at most N holders at a
  time, FIFO, with the same release and visibility as other leases;
  `leases`, `status` and restart refusals show `held k/N`. A granted ticket is
  never treated as blocked afterwards.
- `pi-durable-subagents drill failover` rehearses pool failover in an isolated
  home with a scripted provider (about 30 s, offline): a call moves from a
  used-up provider to the next candidate, new calls avoid the provider, and it
  is used again after a probe. Interrupting it cleans up.
- `events <wid>` names the target model of a model switch, and `failover:` the
  provider it left when the switch was a failover.
- `run`: with `tasks`/`chain`, a top-level `agent` is the default agent of
  every step. A run reply names calls that start queued behind another call's
  writer lock (`writerWait`).
- `status`: run labels show on each workflow line and in the list.
  `status <wid>` takes `tail: N` and `grep: "<regex>"` (CLI `--tail`,
  `--grep`) to return just the last or matching lines of each call's result.

## 1.0.27

- `hold --no-wait` (or `--max-wait 0`) takes the lease at once or exits 75
  without ever being queued: the decision is made under the resource's lock
  and a refused request writes nothing, so `leases`, `status` and other
  waiters never see it. Before, `--max-wait 0` queued a ticket, checked, and
  removed it. A no-wait request also no longer ends processes left by a
  killed holder (a queued waiter still does); it is refused while they remain.
- Release check: `pack:smoke` waits for its orchestrator to exit before
  removing its temporary directory, and a failed removal is a warning. The
  1.0.26 release stopped at this step on macOS (`ENOTEMPTY` after
  `pack-smoke ok`), so 1.0.26 was never published; 1.0.27 includes its
  changes.

## 1.0.26

- A daily quota message in Chinese ("remaining quota is 0, resets at 00:00 the
  next day") is a used-up usage window: a pool call moves to its next candidate
  and a single-model call waits, instead of failing at once as a balance error
  (the word for "balance" occurs inside "remaining quota"). Checked against the 7,941 provider errors
  recorded on a working machine: this was the only usage-window text misread,
  and no rate limit or transient error is read as one.
- `answered.by` is `call:<wid>/<key>` for a subagent answering through the CLI
  (the CLI now sends its `DSA_CALL` as `caller`). The caller is provenance and
  not part of `spec_digest`: retrying a request id with or without it is the
  same request. A pi session still running an older extension computes the
  digest with the caller included and would see such a retry as a conflict.
- Tests: an end-to-end pool failover through the CLI and a detached
  orchestrator; the effects fixtures use a unique workflow id, since gate
  processes are found by tag across the whole machine and parallel test files
  shared one; the CI runner also reruns files reported in nested tests.

## 1.0.25

- `restart` refusals show what a fence would cut short: each lease a running
  call holds, with its mode, how long it has been held, its command and note.
  Leases held outside those executions (a shell, a `systemd-run` unit) are
  listed apart, since a restart leaves them held.
- The waiting/moving check period is configured as `k.waitCheckMs` (was
  `k.r7Ms` in 1.0.24; the old key is not accepted).
- README: deduplicate events by `id`, not cursor; a call with no next
  execution has no `fenced`; an open question keeps the orchestrator from its
  idle exit (compact the event log now with a non-force `restart`); leases
  outside calls survive restarts; why a restart cannot hand running
  executions to the new orchestrator.

## 1.0.24

- `events --all [--since <cursor>] [--limit <n>]`: one durable log of
  milestones across all workflows (`submitted`, `started`, `asking` with the
  full question, `answered` without the text, `sealed` with status and data,
  `fenced` with the reason of an interruption, `workflow-done`), read with an
  `<epoch>:<seq>` cursor in pages of at most 1000. Delivery is at least once
  without gaps, also across `kill -9` and restarts (re-derived events keep
  their `id`); events are kept at least 7 days and never while their workflow
  is unfinished or asking; an older cursor gets `cursor-expired` (exit 4). A
  prune whose events cannot be logged first is rejected (`event-log: …`).
- `run --labels <json>` (tool: `labels`): caller labels, part of the spec
  digest, returned by `describe` and echoed on every event of the run.
- Why a call does not move: `describe` adds `reason`, `detail` and
  `since` to each waiting call, and the event log gets `waiting`/`moving`
  when the reason changes: `unconfirmed-stop`, `provider-exhausted`,
  `writer-lock`, `lease`, `slot`, `silent`.
- README: the subagent force-restart guard is a rail against accidents, not a
  security boundary.

## 1.0.23

- An asker cut off by a restart (also `restart --force`) now hibernates and
  resumes with the answer, as documented. A graceful shutdown let its `ask`
  end with its own "Session shut down" (or "Ask aborted") error before the
  process exited; recovery took that for an answered ask, recorded a loss and
  ran the call again, so the model asked a second time, `describe` showed a
  `lastFence` and the stale question stayed listed. Only a killed process (no
  result at all) was recognised before.

## 1.0.22

- The installed CLI runs `run`, `send` and `stop` again: 1.0.21 loaded the
  optional pi peer package from the tool schema and failed with
  `ERR_MODULE_NOT_FOUND` where it does not resolve (pi's own npm prefix,
  `npm i -g`). The schema lives apart now; the import check rejects any pi
  import reachable from the CLI, orchestrator or evaluator, and `pack:smoke`
  drives a run by request id from a package directory that cannot see pi.
- `describe` reports `lastFence` only for an execution that was cut off; an
  execution that ended its turn, hibernated, or was stopped, timed out or
  over budget, or hibernated on its question (also when recovery finds only its
  `ask` was running) is not an interruption. A `once` call sealed `unknown` and a call
  sealed after repeated losses still name their fence.
- With `--json`, a `run`/`send`/`stop` refused before submission (unknown
  agent, invalid spec, usage) answers `{request, applied: false, reason,
  spec_digest?}` instead of plain text; exit code 1 as before. A failure after
  submission, and a retry of a recorded run whose agent has since gone, are
  pending (75), never a refusal; other content under a recorded id is a
  `request-conflict` (3) before any agent check.
- The import check parses with TypeScript, follows the executor, which the
  orchestrator loads through `import(new URL(…))`, and treats only
  `import type` as erased (`import { type X }` still loads the module).

## 1.0.21

1.0.20 was not published; its changes ship in this release.

- Programs can name requests: `run`, `send` and `stop` take `--request <id>`
  (CLI) or `request` (the `subagents` tool). A retry with the same id and the
  same content gets the first outcome and never starts a second workflow or
  follow-up; other content under the id is a `request-conflict` and sends
  nothing. Exit codes: 0 applied, 1 rejected, 3 conflict, 75 not decided yet
  (retry with the same id). `describe --key <id>` (or a wid) reports the
  state, open questions and every call's output in full, what live calls
  wait for and why their last execution was fenced. A pruned workflow leaves
  a tombstone with its final status, request id and digest. See "Driving dsa
  from a program" in the README.
- A forced restart needs the user's approval in a checkable form: a refused
  `restart` lists the running executions grouped by session (with held
  leases) and a token; `restart --force <token> --reason <text>` fences
  exactly that set and is refused again if it changed. A subagent cannot
  force a restart. The ledger records who forced it and why, and `status`
  shows it for 24 hours.
- An asker cut off by a restart or crash before its planned hibernation no
  longer loses its question: it hibernates and resumes with the answer
  (also an answer given while dsa restarted), and a `once` step waiting for
  an answer no longer ends as `unknown`.
- A workflow's done notice names a follow-up still going (queued or running)
  instead of calling it `unknown`.
- Orchestrator starts are fast again. Each start re-parsed every workflow's
  staged snapshot (tens of megabytes each when it holds a forked parent
  session) before handling any request, so a restart stalled all work for
  over a minute. A verified `pins.json` record per revision now replaces that
  work: on a copy of a home with 117 workflows, recovery takes about 6 s
  instead of 80 s. The first start after the update builds the records once.
  A record that does not verify falls back to the snapshot, so a changed
  pinned file is still reported as a conflict.
- `restart` no longer reports a failure while the orchestrator is still
  recovering: it says the request is submitted and keeps waiting (up to 10
  minutes), then exits 75 with "still pending — do not resubmit" if no
  orchestrator reached it. After the restart it waits for the orchestrator
  that actually decided it.

## 1.0.19

- The orchestrator no longer keeps every workflow's pinned origin branch (the
  parent session copied for `context: "fork"`) and input bytes in memory; they
  are read from the pinned files when needed. With about 110 workflows of
  history, the orchestrator heap had grown to 3.7 GB; on a copy of that
  history it now stays near 120 MB.

## 1.0.18

- The orchestrator uses far less CPU. Running calls share one process-table
  scan instead of each rescanning `/proc` whenever its call directory
  changed, streamed output no longer triggers whole-journal checks for every
  event, and status/idle checks reuse cached journal views. In a benchmark
  with four streaming calls and 200 other processes, CPU fell from about
  1.9 cores to 0.07; with 100 workflows of history, from about 1.1 cores to
  0.03.
- `pi-durable-subagents restart [--force]` (and the `restart` tool action)
  replaces the orchestrator with the installed version. It refuses while an
  execution is running and lists them (`<wid>/<key>`, age, origin); calls
  waiting for a slot or an answer do not block it. `--force` fences the
  running executions, which resume on the new orchestrator. No execution
  starts between the check and the restart. Against an orchestrator from
  1.0.17 or earlier, the CLI checks the journals itself and then stops the
  old process. Use it instead of killing the orchestrator.
- One writer call per worktree is now enforced. A call whose tools include
  `edit` or `write` holds its git worktree from its first execution until it
  ends, also while waiting for an answer and across orchestrator restarts.
  Another writer in that worktree waits in order; its status line shows
  `(waiting for writer lock: <root> held by <wid>/<key>)` and its origin gets
  one `conflict` notice. `writer:false` on a call, `isolation:"worktree"`, or
  `writerLock: "off"` in config.json opt out.
- `pi-durable-subagents hold <resource> [--shared] [--max-wait s] -- <cmd>`
  runs a command under a resource lease, such as `machine` for benchmarks:
  exclusive holders run one at a time, shared holders together, strictly in
  request order. The lease lasts as long as the command, even if the `hold`
  process is killed, and the command's leftover processes end before it is
  released. Subagents find the command on their PATH; it also works from
  your own shell without an orchestrator. `leases` and status show holders
  and waiters, and a call's status line shows the lease it holds or waits for.

## 1.0.17

- A silent subagent shows one warning instead of separate activity and
  progress warnings. The message now says that no new output or tool
  progress has been received and that the model may still be processing;
  the ten-minute thresholds are unchanged.
- Warning cards update in place to `recovered` when activity resumes, or
  `ended` when the execution ends. They refresh even when the status line
  does not change or the dock is turned off.
- Execution checkpoints and warnings record the latest received stream
  update's time and type for diagnosis, without recording its content.

## 1.0.16

- A used-up usage window is found while pi is still retrying: at the second
  quota refusal in a row (`No available accounts`, usage limit, quota
  exceeded), not after pi's retries end. A call from a pool moves to the
  pool's next model that is not used up and has a free slot, in the same
  execution and session, within pi's next retry or two (refused requests use
  no quota); one with a single model waits for its provider. Before, a call kept retrying the used-up provider for as
  long as pi's retry settings allowed (over ten minutes with ten retries).
- `send kind:"model"` and a follow-up's `model` accept a pool's name: the
  first model of the pool that is not used up (for a running call, also with
  a free slot). The reply names the model picked; a call from that pool stays
  in it, so a later used-up window still moves it on. A follow-up naming a
  pool starts its generation from the pool's order.

## 1.0.15

- The changes listed under 1.0.14, which was tagged but never published:
  its macOS CI failed because two test files compared worktree roots (real
  paths) with temporary paths under the `/var` symlink. Only those tests
  changed.

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
