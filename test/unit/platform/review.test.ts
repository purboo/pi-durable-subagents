import test from "node:test";
import assert from "node:assert/strict";
import { text } from "node:stream/consumers";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProcessTable, captureStart } from "../../../src/platform/proctable.ts";
import { Containment } from "../../../src/platform/containment.ts";

const row = (command: string) => `  43210 1 Sun Oct  4 01:02:03 2026 0:00.12 S ${command}\n`;

test("macOS ps accepts only known ids, including argv-like and nested environment tokens", async () => {
  const cases = [
    // An unknown argv token must not become a newly discovered execution.
    { command: "/bin/tool DSA_EXEC=argv-id PATH=/bin", known: ["real"], tag: undefined, ambiguous: undefined },
    { command: "/bin/tool DSA_EXEC=argv-id DSA_EXEC=real", known: ["real"], tag: "real", ambiguous: undefined },
    // ps loses environment value boundaries: unknown nested tokens cannot override a known tag.
    { command: "/bin/tool DSA_EXEC=real NOTE=contains DSA_EXEC=wrong", known: ["real"], tag: "real", ambiguous: undefined },
    { command: "/bin/tool DSA_EXEC=real NOTE=contains DSA_EXEC=wrong", known: ["real", "wrong"], tag: undefined, ambiguous: true },
    { command: "/bin/tool DSA_EXEC=argv-id DSA_EXEC=real", known: ["argv-id", "real"], tag: undefined, ambiguous: true },
    { command: "/bin/tool DSA_EXEC=real DSA_EXEC=real", known: ["real"], tag: "real", ambiguous: undefined },
    { command: "/bin/tool DSA_EXEC=real", known: [], tag: undefined, ambiguous: undefined },
  ];
  for (const fixture of cases) {
    const table = new ProcessTable({ platform: "darwin", ps: async () => row(fixture.command) });
    const [p] = await table.list(new Set(fixture.known));
    assert.equal(p?.tag, fixture.tag, fixture.command);
    assert.equal(p?.ambiguous, fixture.ambiguous, fixture.command);
    assert.equal(p?.cpuMs, 120);
    assert.equal(p?.start, "Sun Oct 4 01:02:03 2026");
  }
});

test("Containment forwards caller exec ids to macOS ps filtering", async () => {
  const table = new ProcessTable({ platform: "darwin", ps: async () => row("/bin/tool DSA_EXEC=real") });
  const c = new Containment(table);
  assert.equal((await c.scan(new Map([["real", []]]))).get("real")?.[0]?.tag, "real");
  assert.equal((await c.scan(new Map())).size, 0);
});

test("fast true and exit 3 preserve output and status without scanning the table", { timeout: 10000 }, async () => {
  const table = new ProcessTable();
  for (const fixture of [
    { command: "/bin/true", args: [], code: 0, stdout: "", stderr: "" },
    { command: "/bin/sh", args: ["-c", "printf 'fast output'; printf 'fast error' >&2; exit 3"], code: 3, stdout: "fast output", stderr: "fast error" },
  ]) {
    const tag = randomUUID();
    let scanned = false;
    const c = new Containment({ list: async known => {
      scanned = true;
      return table.list(known);
    } });
    try {
      const child = await c.spawn({ exec: tag, ...fixture, cwd: tmpdir(), env: {} });
      assert.equal(scanned, false, "spawn must only inspect its own pid");
      const [out, err, exit] = await Promise.all([text(child.stdout), text(child.stderr), child.exited]);
      assert.equal(out, fixture.stdout); assert.equal(err, fixture.stderr);
      assert.deepEqual(exit, { code: fixture.code, signal: null });
      assert.equal(await captureStart(child.pid), "", "exited child has no identity to fence");
      await c.fence(tag, [{ pid: child.pid, ppid: process.pid, start: "" }]);
    } finally { await c.fence(tag, []); }
  }
});

test("fence treats empty start records as retired even if pid matches a live process", async () => {
  // If an empty token were matched, fence would SIGKILL this test runner.
  const c = new Containment({ list: async () => [{ pid: process.pid, ppid: process.ppid, start: "" }] });
  await c.fence("retired", [{ pid: process.pid, ppid: process.ppid, start: "" }]);
});
