# Fork context follows compaction (FC1)

`context: "fork"` now pins the parent's *effective* context, the one pi itself sends to the model, rather than every
message on the session branch.

- **Compacted branch.** When the branch up to the pinned leaf contains a `compaction` entry, the fork pins the latest
  compaction (its summary, shown as pi presents it, plus its `systemMessage` when it has one). It also pins the entries
  kept from its `firstKeptEntryId` on and every entry after it, exactly as pi's session-context builder selects them.
  Raw messages from before the compaction are not copied. System messages inside the kept range and older compactions
  are dropped, as pi drops them. On a compacted branch, branch summaries, custom messages of other extensions and
  context edits are kept as pi treats them: a summary or custom message is sent, and an edit applies to an entry the
  fork also pins. The child's session therefore starts with the same messages that the parent's next request would send.
- **Uncompacted branch.** Nothing changes from 1.2: the fork pins the `message` and `model_change` entries of the branch,
  byte for byte. As in 1.2, this also drops branch summaries and custom messages.
- **Receipts.** dsa's own `dsa-*` entries are never pinned, on either kind of branch.
- **Not copied** (as in 1.2): thinking-level changes, labels, session info and other entries that pi does not send to
  the model. The child keeps its own thinking level.

The pin is taken at admission, as before. Compactions in the parent after admission do not change a pinned run, and
follow-up generations reuse the child's own session.

## How the rule is implemented

FC1 asks dsa to use pi's exported session-context builder when it is available, and otherwise to implement the same
rule and test it against pi's builder. The orchestrator must not load the optional pi peer packages at run time (see
`scripts/check-imports.mjs`), so it cannot call the exported builder. dsa therefore implements the rule
(`src/orchestrator/origin.ts`). Its tests check that pi's exported `buildSessionContext`, run on the published fork
session, returns the same messages and model as on the origin with receipts removed. The fixtures cover nested
compactions, a kept marker that is not on the branch, and a compaction with no kept entries. If a future pi changes
its compaction projection, these tests fail.
