# 1.2 model switching integration notes

## Behavior for README / release notes

An accepted manual `send kind:model` becomes the logical call's choice for later follow-up generations (g+1, g+2, …), including calls initially launched from a pool. Another accepted manual model switch or a follow-up specifying `model` replaces it. A refused, withdrawn or replaced request does not become a choice; automatic failover never becomes one.

A concrete `provider/id[:thinking]` remains concrete. A pool name remains a pool name and is resolved again at each generation's launch, using the current pool configuration. The existing 1.1 explicit-model launch path still governs availability: a concrete generation has no pool to widen into, so an exhausted provider waits for availability/probing and provider slots; it does not invent a fallback pool. A pool choice uses that pool's existing availability, slot, skip and failover rules. Capacity admission and reservations for live switches are unchanged.

`send kind:model` to a sealed call records the choice and replies with `model` and `effect: "next-generation"`; it creates no generation, starts no child and reserves no provider slot. Send a follow-up to continue. Until then, `status` retains the last actual `model` and shows the pending choice as `switching`. Opening the next generation consumes that pending indicator while retaining its choice for later generations.

Parent rulings **R-12-MP-1 / R-12-MP-2** clarify contract MP2: model requests to sealed calls follow the existing sealed follow-up acceptance path. This includes done workflows and stopped workflows, because today's manual follow-up accepts both. No new terminal gate is introduced. Existing address, stale-revision, command-call and pin-validation refusals still apply. Tests cover done, running (an unfinished parallel sibling) and stopped workflows. Whether stopped workflows should reject manual follow-ups is a separate backlog/product question, outside this leaf.

## Persistence / compatibility

- New live manual model `forward` records have optional `choice`, retaining the original pool name or concrete model before live-switch resolution. Existing forwards without this field retain their 1.1 execution-only semantics. A live forward committed before its applied reply is replayed as that same forward after a crash: if it has already sealed, intake acknowledges the original outcome without converting a refused switch into a new sealed choice.
- New `model-choice {rid, call, model}` records persist a sealed choice before the applied reply. Replay finds the committed choice by request id, including when a generation has since opened, and repairs a missing reply note without recording another choice.
- New `generation` records carry optional `choice`; the choice is also written into `spec.model`, and concrete choices use the existing generation `model` override. This preserves an explicit model even if a copied session still names an earlier model. Legacy generations remain unchanged. Revision-scoped entries and the exact call id prevent cross-revision/key leakage.
- Generation opening and sealed choice writes share the engine's per-workflow opening queue. A seal racing a live model forward causes intake to retry through the sealed branch. Live-forward recording and provider admission retain the executor's serial queue.

## P28 test tail

Only complete JSONL lines are parsed by the three helpers polling mutable sessions in `test/pi/executor/executor.test.ts`: `revisions()` in `reaskedBeforeFence`, `rows()` in the P28 receipt-before-crash test, and `receipts()` in P7 recovery. An incomplete final write is ignored until its newline arrives; a malformed complete line still throws. Other settled-session assertions are unchanged. `test/unit/harness/session-lines.test.ts` checks every character boundary of a partial tail and malformed complete records.

## Verification

Baseline behavioral red evidence: `/tmp/dsa-110/logs/dsa-dsa-model-1-2476469-192954.log` runs the new sticky-model unit file against product code at `5ad9ee3`; exit 1, 5 pass / 6 fail, all failures are model-behavior assertions (no timeouts). All checks run on bench through `/tmp/dsa-110/run-dsa.sh`; final successful check receipts are provided in the leaf handoff.
