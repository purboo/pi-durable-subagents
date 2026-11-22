// Probe the Windows command-job route end to end: the framework compiler discovered by absolute path, the per-launch
// compile of the embedded owner, its direct detached spawn (no PowerShell anywhere) and the kernel group it owns.
// Synthetic data only: a temporary attempt directory with a wrapper that reports its own status.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_END, JOB_GROUP, JOB_HOST_EXE, JOB_HOST_PREFIX, frameworkCompiler, spawnInJob } from '../src/platform/job.ts';

const dir = await mkdtemp(join(tmpdir(), 'dsa-job-probe-'));
try {
  const compiler = frameworkCompiler();
  if (!existsSync(compiler)) throw new Error(`the resolved compiler does not exist: ${compiler}`);
  console.log('Framework compiler:', compiler);
  const program = join(dir, 'probe.mjs');
  await writeFile(program, "console.log('probe-alive'); setTimeout(() => process.exit(17), 1200);\n");
  // The real start: bounded foreground compile, then one detached winexe that owns the group.
  const spawned = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, 'output.log'), env: { ...process.env }, exec: 'command:probe#1' }, { timeoutMs: 60_000 });
  if (!spawned) throw new Error('the probe start was refused (no process was started)');
  const hosts = readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX));
  console.log('started', JSON.stringify({ pid: spawned.pid, start: spawned.start !== '', group: spawned.group ?? null,
    hostDirs: hosts.length, hostExe: hosts.length === 1 && existsSync(join(dir, hosts[0], JOB_HOST_EXE)) }));
  console.log('group', readFileSync(join(dir, JOB_GROUP), 'utf8').trim());
  await spawned.exited;
  const end = readFileSync(join(dir, JOB_END), 'utf8').trim();
  const output = readFileSync(join(dir, 'output.log'), 'utf8').trim();
  console.log('group-end', end);
  console.log('output', JSON.stringify(output));
  if (!output.includes('probe-alive') || !/"status":17/.test(end)) throw new Error('the compiled owner did not report its wrapper');
  console.log('Detached compiled owner ran the wrapper in a Job Object and reported exit 17');
} catch (error) {
  // Fail-closed evidence: what the compiler or the owner recorded, bounded.
  for (const name of ['start-error', 'host.log', 'host-exit']) {
    try { console.log(name, readFileSync(join(dir, name), 'utf8').slice(0, 1500)); } catch { /* absent */ }
  }
  throw error;
} finally { await rm(dir, { recursive: true, force: true }); }
