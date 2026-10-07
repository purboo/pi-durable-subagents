import { test } from "node:test";
import assert from "node:assert/strict";
import { modelRid, requestedModel } from "../../../../src/orchestrator/executor/index.ts";
import { refusedByProvider } from "../../../../src/orchestrator/executor/session.ts";
import { snapshotFromEntries } from "../../../../src/orchestrator/snapshot.ts";
import type { Entry, JournalHandle } from "../../../../src/types.ts";

const call = "w@1/a@1";
function journal(...items: Record<string, unknown>[]) {
  const entries = items.map((e, i) => ({ seq: i + 1, ts: i + 1, ...e })) as unknown as Entry[];
  return { entries: () => entries } as unknown as JournalHandle;
}
const exec = (n: number) => ({ type: "exec", call, exec: `${call}#${n}` });
const selected = (n: number, id: string) => ({ type: "selected", exec: `${call}#${n}`, model: { provider: "p", id } });
const used = (n: number, id: string) => ({ type: "model-used", exec: `${call}#${n}`, model: { provider: "p", id } });
const forward = (rid2: string, id: string) => ({ type: "forward", rid: rid2, rid2, dest: call, envelope: { to: call, kind: "model", body: { provider: "p", model: id } } });

test("P12: a model request stands until the call uses it; then the session's model and the pool rule again", () => {
  // Waiting call asked for B: its next launch uses B.
  assert.equal(requestedModel(journal(exec(1), forward("r1", "b")), call)?.id, "b");
  // Launched on B, later fell back to C (pool skip): B no longer forces the launch.
  assert.equal(requestedModel(journal(exec(1), forward("r1", "b"), exec(2), selected(2, "b"), used(2, "c")), call), undefined);
  // Applied by the running child (delivered without a reason): the session holds it.
  assert.equal(requestedModel(journal(exec(1), selected(1, "a"), forward("r1", "b"), { type: "forward-delivered", call, rid2: "r1" }), call), undefined);
  // Withdrawn, or refused by the child: does not count; an earlier unused one does not come back either.
  assert.equal(requestedModel(journal(exec(1), forward("r1", "b"), { type: "forward-delivered", call, rid2: "r1", reason: "unknown-model" }), call), undefined);
  assert.equal(requestedModel(journal(exec(1), forward("r1", "b"), { type: "forward", rid2: "w1", dest: call, envelope: { kind: "withdraw", body: { rids: ["r1"] } } }), call), undefined);
  // A follow-up's model counts until an execution of the generation answers with it.
  assert.equal(requestedModel(journal(), call, "p/b")?.id, "b");
  assert.equal(requestedModel(journal(exec(1), selected(1, "b"), used(1, "c")), call, "p/b"), undefined);
  // A failover's switch is no request: undelivered when its execution ended, the pool decides the next launch.
  assert.equal(requestedModel(journal(exec(1), selected(1, "a"), { ...forward("f1", "b"), failover: "p" }), call), undefined);
  assert.equal(requestedModel(journal(exec(1), forward("r1", "c"), { ...forward("f1", "b"), failover: "p" }), call)?.id, "c");
  assert.notEqual(modelRid("r"), "r");
});

test("P12: a retired call shows no pending switch", () => {
  const entries = journal(
    { type: "call", key: "a", gen: 1, pos: 0, spec: { agent: "x", model: "p/a" } },
    exec(1), selected(1, "a"), { type: "tracked", exec: `${call}#1` },
    forward("r1", "b"), { type: "forward-delivered", call, rid: "r1", rid2: "r1" },
    { type: "retired", call },
  ).entries();
  const c = snapshotFromEntries("w", entries).calls[0]!;
  assert.equal(c.switching, undefined);
});

test("P12: content refusals fail at once; a content filter that is down is retried", () => {
  assert.ok(refusedByProvider("This request was blocked as it seems to violate Anthropic's Terms of Service restrictions"));
  assert.ok(refusedByProvider("Output blocked by content filtering policy"));
  assert.ok(!refusedByProvider("503 Content filter service temporarily unavailable; please retry"));
  assert.ok(!refusedByProvider("Request timed out."));
});
