### Quota notices returned as successful responses

Some gateways answer with HTTP 200 and an assistant message saying that the usage
window is used up. Configure `exhaustedPatterns` on that provider in
`$DSA_HOME/config.json` to treat these messages as quota failures:

```json
{
  "providers": {
    "primary": {
      "slots": 3,
      "exhaustedPatterns": ["额度已使用完毕"]
    }
  },
  "pools": {
    "writer": ["primary/model", "backup/model"]
  }
}
```

Each string is a JavaScript regular expression, matched case-insensitively against
an assistant message's combined text. A message containing any tool call is never
matched. Invalid expressions reject the configuration with an error naming the
provider; a pattern that still reaches a child is skipped there instead of
breaking the child. Omitting the field or using an empty list keeps the existing
behavior.
Choose patterns specific to the gateway's quota notice: a broad pattern can also
match an ordinary answer quoting that notice. Patterns are snapshotted when an
execution starts; configuration changes apply to later executions.

A match marks the provider `exhausted` using the existing quota/probe mechanism.
The response cannot make the call succeed, and the rejected assistant turn is
excluded from the next model's context. The call continues through normal slot
admission on another usable provider in its pool. If there is no remaining model,
including a call that names a concrete model without a pool, it fails with
`model-unavailable:` followed by the matched response text clipped to 200
characters. A pool whose only other model sits on a provider whose window is
used up therefore ends the turn at once with `model-unavailable:`, where a
quota-class error on the same provider waits for that provider's probe instead.
Slot capacity and delayed pool entries retain their normal admission
rules. The provider stays avoided until its next probe (15 minutes by default,
configurable through `k.probeMs`).

The quota receipt survives an orchestrator restart. It is not a lost execution,
so it does not consume the loss bound or make a `once` call unknown. Usage already
reported by the provider is still counted.
