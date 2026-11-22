// Compare direct and detached helper startup with synthetic data only.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_HELPER, JOB_SCRIPT, JOB_SPEC, jobSpecText } from '../src/platform/job.ts';
import { helperEnv, powershellPath } from '../src/platform/windows.ts';

const probeDir = await mkdtemp(join(tmpdir(), 'dsa-compiled-holder-'));
try {
  const source = join(probeDir, 'Holder.cs'), exe = join(probeDir, 'Holder.exe');
  await writeFile(source, 'using System.IO; class Holder { static int Main(string[] args) { File.WriteAllText(args[0], "alive"); return 17; } }');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/out:' + exe, source], { timeout: 30000, windowsHide: true });
  const mark = join(probeDir, 'alive');
  const holder = spawn(exe, [mark], { detached: true, windowsHide: true, stdio: 'ignore', env: helperEnv() });
  const [code] = await once(holder, 'exit');
  if (code !== 17 || await readFile(mark, 'utf8') !== 'alive') throw new Error('compiled detached holder failed with exit ' + code);
  console.log('Detached compiled holder executed and reported exit 17');
} finally { await rm(probeDir, { recursive: true, force: true }); }

for (const detached of [false, true]) {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-launch-probe-'));
  try {
    const script = join(dir, JOB_SCRIPT);
    await writeFile(script, JOB_HELPER);
    await writeFile(join(dir, JOB_SPEC), jobSpecText({ exe: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, log: join(dir, 'output.log'), env: { SystemRoot: process.env.SystemRoot } }));
    const capture = await open(join(dir, 'probe.log'), 'a');
    try {
      const proc = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        detached, windowsHide: true, env: helperEnv(), stdio: ['ignore', capture.fd, capture.fd], timeout: 45_000,
      });
      const [code, signal] = await once(proc, 'exit');
      console.log(JSON.stringify({ detached, code, signal }));
    } finally { await capture.close(); }
    for (const name of ['probe.log', 'start-error', 'group-end']) {
      const data = await readFile(join(dir, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (data) console.log(name, data.toString(data[0] === 0xff && data[1] === 0xfe ? 'utf16le' : 'utf8').slice(0, 1500));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
