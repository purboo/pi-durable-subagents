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
test expectation was changed. All other new tests are in the two requested
`ended.test.ts` files.
