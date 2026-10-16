# Incremental request intake

Implementation revision: `dc94d693bcbe5662b15d64b1b26453da50f408a2`.
Baseline: `c63ff88` (1.0.42). Source tree: `81c52a9cff624e20c6c9a4a2ac98286ce735b262`.

## Contract

- `LifecycleFold.apply` preserves the lifecycle left fold. `reduceLifecycle` still returns the same maps and set.
  Frozen journal decisions are shared; mutable decision inputs are defensively cloned.
- Planning applies emitted decisions to a temporary fold. Its copy uses overlays over history and copies the open
  frontier. The source must remain unchanged until the copy is discarded. Deciders receive a request copy and a
  read-only lifecycle view valid during the synchronous call.
- The engine folds committed ledger entries after an entries-length watermark, retains only unresolved request
  envelopes, and indexes historical sends for withdrawal forwarding in journal order. Rejected and withdrawn stages
  are cleaned after commitment; failed cleanup remains pending. Polling reads the journal count without a snapshot.
- CLI lookups retain the first applied/rejected decision, excluding identity-conflict rejections. Only pending sender
  IDs are acknowledged, in ledger resolution order. Resolution/outcome polling uses the existing compact journal fold
  to decode only appended bytes; the shared snapshot reader already decoded tails but copied its entries array.
- `mailbox.ts` only gains `Outbox.pendingRids()`, a snapshot of pending identities without envelope clones. This
  accessor is the integration point with other outbox changes. Store pins and executor sweep code are untouched.
- No ledger format or recorded decision changes. Child planning continues to accept decision arrays.

## Regression evidence

The randomized equivalence test checks 300 seeds with 12 passes per seed against an independent copy of the baseline
reducer and planner. Histories cover several senders, duplicate envelopes, identity conflicts, withdrawals, missing
or invalid dependencies, rejected decisions and deferrals. Additional tests cover resolution before admission,
duplicate admissions, mutable/frozen records and planning without resolved-history iteration.

The engine test compares every ledger entry except its timestamp after ten passes against a copied baseline consumer.
It covers retained envelopes, sender gaps, dependencies, withdrawals, conflicting retries and asynchronous decisions.
A second test forbids reading any ledger position before the watermark after catch-up. CLI tests cover appended
resolution, ledger replacement, first-resolution precedence and acknowledgements limited to pending sender IDs.

The existing mutating-decider test now checks request isolation and the current view. Its old attempt to mutate the
view was removed because the explicit contract makes the view read-only during the call. The guard-mutation fixture
also resolves the new overlay dependency when it copies lifecycle source into a temporary directory. These are the
only two existing tests changed.

Two focused cost regressions were also run on the baseline and both failed as expected (exit 1): the engine requested
a full snapshot, and the sender tried to acknowledge 30 unrelated resolved IDs.

```sh
node --test --test-name-pattern='only acknowledges|caught-up intake' \
  test/unit/cli/intake-incremental.test.ts \
  test/unit/orchestrator/engine/intake-incremental.test.ts
```

## Measurements

Measured on an isolated Linux host with Node 24, using separate copies of a 2084-workflow home with a 34 MiB ledger.
Each copy was warmed once before the measured second start. Pi was `/bin/false`. Copies were deleted after both runs;
all four warm/measured orchestrator processes exited 0. Each CLI send intentionally rejected an unknown call (exit 1).

| Measure | Baseline | Incremental |
| --- | ---: | ---: |
| Empty consume, median of 5 | 264.468 ms | 0.523 ms |
| Empty consume range | 254.256-290.372 ms | 0.127-0.567 ms |
| One new request, median of 5, excluding decision work | 538.444 ms | 28.490 ms |
| One new request range, excluding decision work | 526.542-626.219 ms | 3.345-38.292 ms |
| Orchestrator CPU seconds/minute, one request every 5 s | 26.641 | 1.662 |
| CLI send CPU, user + system | 3.53 + 0.52 = 4.05 s | 3.48 + 0.54 = 4.02 s |
| CLI send wall time | 3.63 s | 3.17 s |

Exact measurement entry point (source directories and immutable original home supplied as absolute paths):

```sh
PATH="$NODE_BIN:$PROBE_BIN:/usr/bin:/bin" \
GIT_EXEC_PATH="$PROBE_GIT_EXEC" \
GIT_CONFIG_GLOBAL="$PROBE_GIT_CONFIG" GIT_CONFIG_NOSYSTEM=1 \
TMPDIR="$HOME/dsa-ci/tmp" timeout 900 node "$SRC/scripts/bench-intake.mjs" \
  "$BASE" "$SRC" "$HOME/dsa-ci/home.orig" "$HOME/dsa-ci/intake-measurements"
```

`bench-intake.mjs` instruments `Engine.intake`, subtracts measured time inside `decide`, measures process CPU during
12 sends over one minute, and measures a real CLI send with `/usr/bin/time -f '%U %S %e'`. Raw results and individual
process exit codes are in `ipc:~/dsa-ci/intake-measurements/results.json`; logs are in the same directory. The outer
benchmark wrapper exit code was not saved; both complete reports and all probe process exit codes were saved.

## Validation

- `npm run typecheck`: exit 0.
- `npm run lint:imports`: exit 0 (`imports ok`).
- Focused kernel, CLI and engine regressions: 19 passed, 0 failed, exit 0.
- Full pi suite: 199 passed, 0 failed, exit 0 (720.102 s).
- Full unit suite after the fixture correction: 715 passed, 0 failed, exit 0.
- The first full unit run was 713 passed / 2 failed, exit 1: the missing overlay import in the mutation fixture and
  one multi-target CLI outbox conflict. The fixture was fixed. The CLI test subsequently passed in 60 baseline and
  60 current runs (20 serial plus 40 in batches of eight per tree). No production source changed after the pi run.
- Final typecheck/import lint and the guard mutation suite pass; `git diff --check` exits 0. Added lines are ASCII.

Local commands used the shared machine lease and low priority:

```sh
env -u DSA_EXEC -u DSA_CALL -u DSA_HOME -u DSA_JOURNAL -u DSA_INBOX -u DSA_MODEL -u DSA_SESSION \
  "$CLI" hold machine --shared -- nice -n 10 timeout 180 npm run typecheck
# Same prefix for npm run lint:imports and node --test with the focused paths above.
```

Final full-suite command, after mirroring the implementation tree with `ipc-sync.sh intake "$SRC"`:

```sh
SRC="$HOME/dsa-ci/intake" OUT="$HOME/dsa-ci/intake-final.logs" \
  timeout 3900 "$HOME/dsa-ci/full.sh" 1
```

The driver runs the full pi suite with concurrency 1 and a 2400 s timeout, then the full unit suite with a 1500 s
timeout. Logs: `ipc:~/dsa-ci/intake-final.logs/{full-1,unit}.log`; exit receipts:
`ipc:~/dsa-ci/intake-final.full.out`. The unit-only recheck used the same environment and timeout, with
`node --test --test-timeout=120000 --test-force-exit 'test/unit/**/*.test.ts'`; its log is
`ipc:~/dsa-ci/intake-final.logs/unit-recheck.log` and exit receipt is `ipc:~/dsa-ci/intake-unit-recheck.out`.
The test/fixture revision is `99f279d`; the production source remains identical to `dc94d69`.

## Limits and runtime state

Initialization still folds existing history once. Candidate sorting and repeated decision passes still depend on the
open frontier. A planning copy is temporary and requires its source to remain unchanged. CLI CPU is essentially
unchanged in this workload; the CLI still performs other full request-history lookups. The measured
intake times satisfy the 20 ms empty / 50 ms one-request targets; they do not claim bounds for arbitrary decision work.

The initial CLI conflict remains an unresolved observation, not a claimed fixed regression. A deterministic
fault-injection probe reproduced an existing publication race on both baseline and current source: when a recipient
removes an inbox file between the no-replace link's EEXIST and the identity read, republishing reports
`Outbox identity conflict: pending`. Both fault probes exited 0 after asserting that identical error. The original
failure's exact trigger was not instrumented. The publication primitive was left unchanged; this is relevant to
outbox integration. Reproducer: `ipc:~/dsa-ci/intake-publication-race.mjs`, run with a source-directory argument.

The shared orchestrator was untouched. Probe copies and probe orchestrators were removed/stopped. No merge, push,
tag or publication was performed.
