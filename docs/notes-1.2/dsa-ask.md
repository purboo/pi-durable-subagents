# Structured asks (AK1–AK4)

The child `ask` tool still accepts `{question: string}` by default. To make a parent decision actionable, add
`decision_needed` (one sentence naming the decision), then `options` with numbered labels and optional `scope`,
`cost`, `risk`, and `preferred`. At most one option may be preferred. Supply durable `facts` (commit, run id, log sha),
what you `tried`, and `classification_candidates`, each with a label and optional `evidence` and `unproven` arrays.

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

Every string is limited to 2000 characters, including `question`, decision, option members and candidate strings.
`options` and `classification_candidates` accept at most 9 items; `facts` and `tried` at most 20. Nested `evidence`
and `unproven` are arrays of strings (no additional item-count limit). Optional members and arrays remain absent
when not supplied; empty arrays are allowed. Text is preserved, not trimmed or coerced.

Any present structured field requires a nonblank `decision_needed`. Wrong types, exceeded limits, multiple preferred
options, or a missing decision produce a tool error starting `ask refused:` before any question entry, attention,
waiter or revision is created. The missing-decision message is:
`ask refused: decision_needed is required (one sentence naming the decision you need), then options`.
The child remains able to ask again after a refusal. The same validator runs before pi schema validation and at
`execute` entry, so malformed raw arguments and direct execution both use this error prefix.

To require a decision on **every** ask, set `"askRequireDecision": true` in `$DSA_HOME/config.json`.
The key is boolean, defaults to false, is validated and participates in the orchestrator config hash. It is
snapshotted into each child when its execution starts: a live config change affects executions started afterwards,
not a child already running. A resumed execution receives the current setting. `false` keeps question-only asks valid.

The native `dsa-question` entry and workflow attention retain the supplied fields next to the existing question
identity. `qid` remains the hash of execution and question text; metadata does not change that formula. Answer,
steer, hibernation and restart retain their existing semantics.

`describe --key <request> --json`, `describe <wid> --json`, and the program `describe()` API expose all supplied fields
in each `questions[]` item alongside `qid`, `rev`, `to`, `call`, and `text`. `text` stays the original question, not a
rendered summary. Full `status <wid> --json` attention items retain the metadata; compact status clips the decision
like question text. The agent tool's brief `asking[]` includes the clipped `decision_needed` and `rev` only for
structured questions. **Parent ruling R-12-AK-1:** a mixed brief keeps ordinary entries exactly as in 1.1.0 (no newly
inserted `rev` or metadata), while structured entries add `rev` and `decision_needed`. All ordinary question JSON
projections keep their previous shape and serialization; optional metadata is never filled with defaults.

Parent-facing asking notices and the agent tool's status text show the decision first, numbered option labels second
(with `(preferred)` on the preferred option), then the full original question. Structured `describe` and CLI status
text use the same order. Machine-facing tool `details` keep the JSON projection separate from rendered text.
Plain questions continue to display as before.
