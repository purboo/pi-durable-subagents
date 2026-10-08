import test from "node:test";
import assert from "node:assert/strict";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { Containment } from "../../../src/platform/containment.ts";
const row = "43210 1 Sun Oct 4 01:02:03 2026 0:00.12 S /bin/tool DSA_EXEC=real\n";
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }

test("C2 observations share work and age is measured at scan start", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const first = deferred<string>(); let calls = 0;
  const table = new ProcessTable({ platform: "darwin", ps: () => ++calls === 1 ? first.promise : Promise.resolve(row) });
  const known = new Set(["real"]), a = table.list(known), b = table.list(known);
  assert.equal(calls, 1); now = 5000; first.resolve(row);
  const [x, y] = await Promise.all([a, b]); assert.deepEqual(x, y);
  assert.deepEqual(await table.list(known, { maxAgeMs: 10000 }), x); assert.equal(calls, 1);
  await table.list(known, { maxAgeMs: 1000 }); assert.equal(calls, 2, "completion time must not extend snapshot freshness");
});

test("F1 fence waits for pre-request work then starts its own scan", async () => {
  const first = deferred<string>(), second = deferred<string>(); let calls = 0;
  const table = new ProcessTable({ platform: "darwin", ps: () => ++calls === 1 ? first.promise : second.promise });
  const observation = table.list(new Set(["real"]));
  const containment = new Containment(table);
  let retired = false; const fencing = containment.fence("real", []).then(() => { retired = true; });
  assert.equal(calls, 1); first.resolve(""); await observation;
  // Wait through the fence continuation, not through a timing-dependent process scan.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(retired, false);
  second.resolve(""); await fencing;
  await containment.fence("real", []); assert.ok(calls >= 3, "a cached empty table cannot prove a later fence");
});

test("C2 cached identity matching excludes reused pids and retains untagged descendants", async () => {
  const rows = [{ pid: 10, ppid: 1, start: "new" }, { pid: 11, ppid: 10, start: "child" }];
  const containment = new Containment({ list: async () => rows });
  const groups = await containment.scan(new Map([
    ["stale", [{ pid: 10, ppid: 1, start: "old" }]],
    ["live", [{ pid: 10, ppid: 1, start: "new" }]],
  ]));
  assert.deepEqual(groups.get("stale"), []);
  assert.deepEqual(groups.get("live")?.map(p => p.pid), [10, 11]);
});

test("C2 failed scans are shared but not cached; macOS known ids cannot contaminate each other", async () => {
  const first = deferred<string>(); let calls = 0;
  const table = new ProcessTable({ platform: "darwin", ps: () => ++calls === 1 ? first.promise : Promise.resolve(row) });
  const a = table.list(new Set(["real"])), b = table.list(new Set(["real"]));
  first.reject(new Error("transient"));
  assert.deepEqual((await Promise.allSettled([a, b])).map(x => x.status), ["rejected", "rejected"]);
  assert.equal((await table.list(new Set(["real"]), { maxAgeMs: 10000 }))[0]?.tag, "real");
  assert.equal((await table.list(new Set(["other"]), { maxAgeMs: 10000 }))[0]?.tag, undefined);
  assert.equal(calls, 2, "different macOS known-id sets reuse raw ps output, not filtered tags");
});
