### Hardening of the 1.3 leaves

Four findings deferred from the 1.3 reviews are fixed here. None of them
changes what a caller configures or how a call succeeds; they make failures
legible and contained.

#### A pool that does not resolve fails its own call

A pool that cannot be expanded (it names itself, it is empty, or one of its
entries is not a model) is a configuration error of that call, not of the
orchestrator. The call that names the pool is now sealed `failed` with a
message that names the pool:

```
model-unavailable: pool "writer" does not resolve: Cyclic model pool: writer
```

Before this, the error escaped the executor: the call was never sealed, the
orchestrator's run promise rejected, and the error surfaced as an unhandled
failure of the whole orchestrator start instead of of the one call. The same
holds when the pool stops resolving while a call is running (a configuration
change between two executions of one call).

#### A used-up provider ends a quota-notice call at once

When a provider answers with its quota notice, the call ends immediately with
`model-unavailable:` and the notice text (clipped to 200 characters) when the
pool has no other usable model left — including the case where the pool's only
other model sits on a provider whose window is already used up. A quota-class
*error* on the same provider waits for that provider's probe instead; the
notice path does not wait, because the notice already says the window is used
up. This is now stated in `docs/notes-1.3/dsa-exhausted.md`.

#### An invalid quota pattern never reaches a child

`exhaustedPatterns` entries are regular expressions. An invalid one is
rejected when the configuration is loaded, with an error naming its provider.
The orchestrator hands a child only the patterns that compile, and a child
that receives an invalid pattern anyway skips it instead of failing to start.
A provider with no valid pattern behaves as it did before the field existed.

#### The origin pin drops a dsa receipt on every branch

A fork pins the parent's effective context. An entry that names a dsa custom
type is a receipt and is never pinned, whether the custom type sits in the
entry's message or on the entry itself. The two rules that decide this now
share one predicate, so an uncompacted branch, a compacted branch and the
published fork session agree.
