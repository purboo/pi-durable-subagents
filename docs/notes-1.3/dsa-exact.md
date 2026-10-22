# The exact fork: a child that continues the parent's request (EX1–EX7)

`context: "exact"` runs a call as a continuation of the *calling* pi session's last provider request: the parent
capture supplies every field of the request byte for byte, and the child's own conversation is appended to the parent's
conversation. The child's system prompt, context files and skills never reach the provider.

This is the third context value next to `"fresh"` (a call with no context of its own) and `"fork"` (a call that
inherits the parent's effective context as pi sends it). The fork copies the parent's *messages*; the exact fork copies
the parent's *whole request* and adds the child's turns to it.

## The three pieces

1. **The capture (EX1).** The dsa extension, loaded in a top-level pi session (a session that is not inside a dsa
   call: `DSA_CALL`/`DSA_EXEC` are unset), observes every provider request the session makes. The payload is not
   changed — the handler returns nothing. The latest request is kept in memory and written to
   `<dsa home>/exact/<sessionId>.json` (mode 0600, atomic replace). The write happens off the request path: it is
   never awaited by the request, and a failed write neither fails nor delays the request. The file holds the
   serialized provider payload and the request's identity (provider, model, api, thinking, time) — never headers,
   never credentials. The orchestrator removes the capture files that were not modified for 7 days when it starts.
   The configuration key `exactCapture` (boolean, default true) turns the capture off: no file is written and an
   exact run falls back (`no-capture`).

2. **The admission (EX2).** A run that can ask for `context: "exact"` pins the capture of its origin session at
   admission: the bytes are copied into the run's pinned files (`exact.json`) and the sha256, size, time, provider,
   model, api and thinking are recorded. A later capture never changes a pinned run. The pinned capture is delivery
   metadata like the fork's pinned origin (P33): it is not hashed into the request digest.
   The origin is the calling session (as for a fork). The CLI takes it from the new run flag
   `--origin-session <pi session id>`, which is accepted only for `context: "exact"` calls; the session's file is
   found in the pi agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`).
   A call with `context: "exact"` that also names a `model` is refused at admission: an exact call runs on the
   origin's model (remove the `model`). A run that asks for the exact context without an origin is refused too: the
   capture comes from the origin session, and a rebuilt exact call forks it.
   The exact context of a run is read from its *specs* (the call, the tasks, the chain), not from a word in its
   source: a task that happens to name the word is not an exact call. A script run (its specs are built while it runs)
   is read from its source.

3. **The splice (EX3, EX4).** The exact child is a normal dsa child that loads the extensions a top-level session in
   the call's directory would load, plus the dsa child extension. It launches on the captured provider, model and
   thinking: it holds that provider's slot and waits for it like any launch, and it has no pool failover — a provider
   that is used up makes the call fail as a concrete model would.
   Every provider request the child makes is replaced: the capture supplies every top-level field (system or
   instructions, tools, tool choice, model, thinking, max tokens, prompt cache key, metadata and every other field)
   byte for byte, and only the conversation differs — the parent's conversation followed by the child's own (the
   child's payload conversation from its first user message on). The supported apis are `anthropic-messages` and
   `openai-responses`.
   * **Cache breakpoints (anthropic).** The parent's conversation keeps its own `cache_control` markers. The child's
     markers are kept only while the request stays within the provider's limit of four; the child's earliest marker
     is dropped first.
   * **A mismatch.** A request on another provider, model or api than the capture is not sent: the call fails with
     `exact-mismatch: <detail>`. The child detects the mismatch in the `context` hook, which runs before the request,
     and aborts the turn there: pi's extension runner swallows a handler's error and sends the request unchanged, so
     an error would not stop it. The child's receipt (`dsa-exact-mismatch`) names its execution like every other child
     receipt, so the orchestrator ends the call with the mismatch instead of losing it.
   * **Tools.** The tools the model sees are the parent's. The call's own tools (the spec's tools, or the agent's,
     plus the protocol tools) are the allow-list, enforced when the model calls a tool: a tool outside the
     allow-list, a tool the capture lists but the exact child cannot execute, and always `subagents` (no recursion)
     are refused with a result that starts with `tool refused in exact fork:`. The child continues.
   * **Follow-ups.** A follow-up of an exact call reuses the same pinned capture.

## The fallback (EX5)

A call that cannot be exact at launch runs as `context: "fork"` (with FC1) and records why:

| reason | when |
|---|---|
| `no-capture` | the origin session has no capture (the capture is off, or the session made no request yet) |
| `api:<name>` | the capture's api cannot be spliced (only `anthropic-messages` and `openai-responses` can) |
| `model-unknown` | the captured provider is not configured for the orchestrator |
| `no-payload-hook` | the child transport never offers the payload hook (detected at the first request) |

The decision is taken once per call and recorded in the journal: a rebuilt call never retries exact later. The
child's receipt (`dsa-exact-rebuilt`) names its execution, so the orchestrator sees the rebuild.

## The report (EX6)

Every exact or rebuilt call records the usage of each of its provider requests (`input`, `cacheRead`, `cacheWrite`,
`output`, `costUsd`) from the response usage. The `describe` output of such a call has an `exact` field with the
mode, the reason of a rebuilt call, the identity of the pinned capture (sha256, size, time), the provider and model,
the age of the capture at the launch and the requests. The finished-call notice and the status text show one line:

```
exact: cache 97% (148.2K/152.6K) · $0.031 · age 41s
```

The cache share is that of the first request (`cacheRead / (input + cacheRead)`); a rebuilt call shows its reason
and what it cost instead (`exact: rebuilt (no-capture) · $0.031`).

## How it is implemented

| piece | where |
|---|---|
| the capture (write, read, retention, the configuration key) | `src/agent/exact/capture.ts`, `src/agent/exact/session.ts` |
| the splice (the fields, the conversation, the cache breakpoints) | `src/agent/exact/splice.ts` |
| the exact child (the splice, the mismatch guard, the tool refusals, the hook detection) | `src/agent/exact/child.ts` |
| the admission (the pinned capture, the refusals) | `src/orchestrator/store.ts` (`prepareRun`), `src/orchestrator/exact.ts` |
| the launch (the captured model, the fallback, the rebuilt call) | `src/orchestrator/executor/index.ts` |
| the report (the `exact` field, the line) | `src/orchestrator/snapshot.ts` |
| the CLI (`--origin-session`) | `src/cli/requests.ts`, `src/compat/pi-session.ts` |

The capture's own module keeps the payload only; the orchestrator never loads the pi peer packages
(`scripts/check-imports.mjs`), so the provider payload is read and spliced as plain JSON.

## Limits

* The exact fork splices the payload of a request. A provider that rejects a request whose conversation does not
  start at the beginning of a conversation (some providers require the first turn to be a user turn) refuses it; the
  call fails with the provider's own error.
* The exact fork is one conversation deep: the child's own conversation grows with its turns, and the parent's
  conversation stays the one the capture holds. A capture of a session that has compacted its context carries the
  compacted conversation.
* The `model-unknown` fallback compares the captured provider with the providers the orchestrator's configuration
  names: its `providers` map, its pools and its default model (a provider named by any of them is configured). A
  configuration that names no provider at all configures every provider.
* The captures of the sessions that are not written any more (and the temporary file of a write that never finished)
  go with the retention, when the orchestrator starts.
* A rebuilt call that is rebuilt *after* its first request (the `no-payload-hook` case) continues in its own session:
  the fork's parent context cannot be published into a session the exact child already wrote.
