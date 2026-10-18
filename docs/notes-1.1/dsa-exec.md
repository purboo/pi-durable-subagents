# Execution lifecycle (1.1)

## Processes of an agent call

Every agent execution's derived system prompt now ends with a lifecycle reminder,
in both `append` and `replace` system-prompt modes. The pinned agent definition is
unchanged. Background processes started by an agent belong to that execution:
dsa stops them when its turn ends and the call seals, and also fences interrupted
executions before continuing them. Moving a process into another process group
or session does not remove an inherited execution tag.

For a build, test suite or measurement that must outlive the current agent turn,
start a durable **command call**, then end the turn:

```sh
pi-durable-subagents run --request <unique-id> --wake caller -- <program> [args…]
```

The command keeps running after the agent turn. When it finishes, caller wake
provides a follow-up with its exit status and output tail. Caller-wake admission
and delivery are documented separately; the lifecycle reminder itself does not
submit or restart work.

## Ended-process diagnostics

Before an agent execution's fence sends SIGKILL to processes other than its
direct pi child, it appends an `ended` workflow-journal entry:

```json
{"type":"ended","exec":"<execution-id>","call":"<full-call-id>","procs":[{"pid":123,"command":"sleep 300"}],"more":2}
```

There is one entry per fence round with such targets. An entry lists at most 20
processes; optional `more` counts further targets in that round. `command` is the
command line clipped to 200 characters, or an empty string when it cannot be
read. Linux reads `/proc/<pid>/cmdline` with NUL separators replaced by spaces;
macOS reads `ps -o command= -p <pid>`. The direct pi child is excluded using both
its pid and start token, including during recovery. Newly launched children have
an optional `child:true` marker on their existing `tracked` journal entry; older
journals retain their original first-tracked-child interpretation.

If dsa crashes after spawn but before any child identity is persisted, recovery
has no identity to exclude by pid and start. In this window it lists only fence
targets whose parent is also a target. The direct pi child is a root of this
forest (its parent is the orchestrator, init or a subreaper, not a tagged target),
so it is never listed. An orphaned descendant is a root too and is also omitted;
this diagnostic under-reporting is intentional (R-11-3). All targets are still
fenced, including omitted roots. A lone unpersisted direct child produces no
`ended` entry.

`ended` records **dsa sending SIGKILL to these processes**, not proof that dsa
caused their death. A process can exit or a pid can be reused between recording
and signalling; the identity recheck avoids signalling a reused pid, so an entry
is not a process-death receipt. Diagnostics are best effort and have a total 500 ms budget per fence;
failed or timed-out recording never prevents the fence from killing processes.
A read that finishes after the budget expires does not start a stale append.
An append already in progress cannot be cancelled and may finish later. Retirement
still requires the existing empty process-table rescan, not an `ended` entry.
Command-call and gate fences do not produce these diagnostics.

The existing containment limit is unchanged: a process that clears its execution
tag **and** leaves the process tree before the tracker observes it can escape.
Command lines may contain arguments that should be treated as sensitive, like
other workflow diagnostics. Describe's per-generation `endedAtSeal` projection
is supplied by the wake/describe change.

## Command-call PATH

Command calls now get `$DSA_HOME/bin` as the last entry of `PATH`, after merging
`spec.env`. The effective starting path is `spec.env.PATH` when supplied,
otherwise the orchestrator's `PATH`, otherwise empty. Empty entries are omitted;
existing copies of `$DSA_HOME/bin` are removed before adding one final copy.
User-supplied and inherited tools therefore keep precedence, while
`command -v pi-durable-subagents` can find the orchestrator's CLI shim even with a
custom PATH. An explicitly empty PATH produces only the shim directory; it does
not implicitly search the current directory or add system tools.

Agent-call PATH is unchanged: the shim directory remains first, followed by the
orchestrator's node directory and inherited PATH.

## Existing-test changes

`test/unit/orchestrator/executor/lifecycle.test.ts`: added EX2/EX3 regression tests
and their imports; all four existing P18/P31 tests remain unchanged. No existing
expectation in that unit file was changed. All other new tests are in the two requested
`ended.test.ts` files. R-11-3 updates the multi-round/failure/abort fixture calls
to provide a known direct identity, keeping their original expectations, and
adds crash-before-tracked coverage with fake and real process tables. This
separates known-identity diagnostics from the newly approved root-omission rule.

R-11-4 changes only the two model-unavailable regexes in
`test/pi/executor/failover.test.ts`: pi can select either settings `qa/m` or
startup fallback `router/auto`. The selected missing-auth model and auth-error
checks, status, output, provider history and forbidden-request counts remain
unchanged.

R-11-7 changes only the model-change assertion in the C1 empty-reply test in
`test/pi/executor/executor.test.ts`. Pi startup can miss an extension provider
that registers late; `src/agent/child.ts`'s existing `ensureModel()` C8 correction
then reselects the held model via `pi.setModel()`. Pi's `AgentSession.setModel()`
appends a `model_change` even when restoring the same selected model. This does
not create a session: candidate and clean-trunk failure artifacts each have one
session header, two execution markers and two changes to `probe/scripted`.
The assertion now requires every model change to name the ticket's selected
model, with either one change or exactly two, the second immediately after the
second execution marker. Output `continued`, one loss, one session header, two
execution markers, exactly-once request receipts and inbox cleanup are unchanged.
No source code or other assertion in that file changed.

### R-11-7 validation and current blocker

All commands ran in the foreground through `/tmp/dsa-110/run-dsa.sh` on bench.
The tested source tree was `81f8be3fea60ef402904481cfe1c14cccc6f4652` (rebased
HEAD `930702ba646d3cf20230e5347c116a70a0232105` plus the C1 test hunk). Only this
notes update follows those checks; it does not change the tested code.

- `npm run typecheck`: exit 0.
  Log: `/tmp/dsa-110/logs/dsa-dsa-exec-1-80528-191953.log`.
- Ten sequential invocations of `node --test --test-reporter=tap
  --test-concurrency=1 --test-force-exit test/pi/executor/executor.test.ts`:
  C1 10/10 pass, zero C1 failures. Each invocation had 90 tests; overall
  898/900 pass, eight invocations exit 0 and two exit 1 (wrapper exit 1).
  Run 1 failed V1 provider-slot serialization while waiting for durable evidence
  (`executor.test.ts:889`); run 5 failed P28 receipt-before-crash while parsing
  a session (`executor.test.ts:758`, `Unexpected end of JSON input`).
  Summary log: `/tmp/dsa-110/logs/dsa-dsa-exec-1-80918-192025.log`.
  Complete failing TAP logs are preserved locally in
  `/tmp/dsa-110/r117-evidence/r117-executor-1-23ZCCi.tap` and
  `/tmp/dsa-110/r117-evidence/r117-executor-5-ap8Hk3.tap`; all ten remote TAP
  paths are recorded in the summary log.
- Full pi suite once: `node --test --test-reporter=tap --test-timeout=120000
  --test-concurrency=1 --test-force-exit 'test/pi/**/*.test.ts'`:
  224/225 pass, exit 1, no skips; C1 passed. The sole failure was the AC2/AC4
  chaos test, scenario 5, invariant `main send receipt`.
  Log: `/tmp/dsa-110/logs/dsa-dsa-exec-1-105839-194140.log`.
  Runtime evidence: `/home/user/dsa-ci/tmp/dsa-chaos-qT4Tsi/5` on bench.

The requested C1 criterion passes, but the full-suite criterion remains unmet.
The V1, P28 and chaos failures have not been proven baseline or waived; their
fixes are outside this test-only ruling. Preserve this candidate for parent
review; do not submit it as passing or rerun full suites without a new reason.
