// Exercise production entry points with the same minimal environment as an isolated orchestrator.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { winStart, winStartSync, winProcessRows, winSnapshotSync } from '../src/platform/windows.ts';

if (process.platform !== 'win32') process.exit(0);
process.env = { PATH: process.env.PATH, HOME: process.env.HOME ?? process.env.USERPROFILE };
const before = performance.now();
const row = (await winProcessRows()).find(p => p.pid === process.pid);
assert.ok(row?.start && /^\d+$/.test(row.start));
assert.equal(row.ppid, process.ppid);
assert.ok(row.command?.includes('probe-win-observer.mjs'));
assert.ok(row.cpuMs >= 0);
assert.equal(await winStart(process.pid), row.start);
assert.equal(winStartSync(process.pid), row.start);
assert.equal(winSnapshotSync(0).get(process.pid)?.start, row.start);
console.log('Verified isolated Windows table, command, CPU and creation time in %d ms', Math.round(performance.now() - before));
