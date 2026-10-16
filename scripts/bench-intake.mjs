// Real-home intake probe. Run on an isolated host with pi disabled:
// node scripts/bench-intake.mjs BASELINE_SOURCE NEW_SOURCE ORIGINAL_HOME OUTPUT_DIR
// Copies ORIGINAL_HOME to sibling h-intake-before/after; removes only those copies when done.
import { fork, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
async function command(bin, args, options = {}, limitMs = 180_000) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', bytes => { stdout += bytes; }); child.stderr?.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  try {
    const result = await new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, signal) => res({ code, signal })); });
    return { ...result, stdout, stderr };
  } finally { clearTimeout(timer); }
}
function isolated(home) {
  const env = { ...process.env, DSA_HOME: home, DSA_PI_BIN: '/usr/bin/false' };
  for (const key of ['DSA_EXEC', 'DSA_CALL', 'DSA_JOURNAL', 'DSA_INBOX', 'DSA_MODEL', 'DSA_SESSION', 'NODE_OPTIONS']) delete env[key];
  return env;
}
if (process.argv[2] === '--runner') {
  const [src, home, tag, mode] = process.argv.slice(3), load = path => import(pathToFileURL(join(src, path)).href);
  const { Engine } = await load('src/orchestrator/engine.ts'), { main } = await load('src/orchestrator/main.ts');
  const { publishRequest } = await load('src/kernel/mailbox.ts'), { orchInbox } = await load('src/paths.ts');
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort(signal));
  let engine, seq = 0, probing = false, decisionMs = 0;
  const send = async () => {
    const sseq = ++seq;
    await publishRequest(orchInbox(home), { rid: `bench-${tag}-${sseq}`, from: `bench:${tag}`, sseq, to: 'orch', kind: 'send', body: { to: 'absent-probe/key', kind: 'steer', message: 'probe' } });
  };
  const decide = Engine.prototype.decide;
  Engine.prototype.decide = async function (...args) {
    const start = performance.now();
    try { return await decide.apply(this, args); } finally { if (probing) decisionMs += performance.now() - start; }
  };
  const recover = Engine.prototype.recover;
  Engine.prototype.recover = async function (...args) {
    engine = this;
    const result = await recover.apply(this, args);
    const passes = [];
    if (mode === 'measure') {
      for (const kind of ['empty', 'request']) for (let i = 0; i < 5; i++) {
        if (kind === 'request') await send();
        decisionMs = 0; probing = true;
        const start = performance.now(); await this.intake();
        const totalMs = performance.now() - start; probing = false;
        passes.push({ kind, totalMs, decisionMs, intakeMs: totalMs - decisionMs });
      }
    }
    process.send({ type: 'ready', passes, recovery: result });
    return result;
  };
  process.on('message', async message => {
    if (message === 'stop') controller.abort('SIGTERM');
    if (message === 'stream') {
      try {
        const cpu = process.cpuUsage(), start = performance.now();
        for (let i = 0; i < 12; i++) {
          await delay(Math.max(0, start + i * 5000 - performance.now()));
          await send();
        }
        await delay(Math.max(0, start + 60_000 - performance.now()));
        // Drain the serialized intake queue before recording the result.
        await engine.intake();
        const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
        process.send({ type: 'stream', requests: 12, elapsedMs, cpuSeconds: (used.user + used.system) / 1e6, cpuSecondsPerMinute: (used.user + used.system) / 1e6 * 60_000 / elapsedMs });
      } catch (error) { process.send({ type: 'error', error: String(error) }); controller.abort('probe-error'); }
    }
  });
  try { await main({ home, signal: controller.signal }); }
  finally { process.disconnect(); }
} else {
  const [baseline, current, original, output] = process.argv.slice(2).map(path => resolve(path));
  await mkdir(output, { recursive: true });
  const reports = [];
  for (const [tag, src] of [['before', baseline], ['after', current]]) {
    const home = join(dirname(original), `h-intake-${tag}`);
    if (await readFile(join(home, 'config.json')).then(() => true, () => false)) throw new Error(`Refusing an existing probe home: ${home}`);
    const copy = await command('cp', ['-a', original, home], {}, 180_000);
    if (copy.code) throw new Error(JSON.stringify(copy));
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    config.k = { ...config.k, idleExitMs: 3600000 }; await writeFile(join(home, 'config.json'), JSON.stringify(config));
    const start = mode => {
      const child = fork(script, ['--runner', src, home, tag, mode], { env: isolated(home), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let log = '';
      child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
      const messages = [], waiters = new Map();
      child.on('message', message => { messages.push(message); waiters.get(message.type)?.(message); });
      const ended = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, signal) => res({ code, signal })); });
      const wait = async (type, ms) => {
        const found = messages.find(m => m.type === type); if (found) return found;
        let timer;
        try { return await Promise.race([new Promise((res, rej) => { waiters.set(type, res); timer = setTimeout(() => rej(new Error(`${tag}/${mode}: ${type} timed out`)), ms); }), ended.then(result => { throw new Error(`Exited before ${type}: ${JSON.stringify(result)}\n${log}`); })]); }
        finally { clearTimeout(timer); waiters.delete(type); }
      };
      return { child, wait, ended, log: () => log };
    };
    let active;
    try {
      active = start('warm'); await active.wait('ready', 180_000); active.child.send('stop');
      const warmExit = await Promise.race([active.ended, delay(30_000).then(() => { throw new Error('Warm shutdown timed out'); })]);
      await writeFile(join(output, `${tag}-warm.log`), active.log());
      if (warmExit.code) throw new Error(JSON.stringify(warmExit));
      active = start('measure'); const ready = await active.wait('ready', 180_000);
      await delay(1000);
      const cli = await command('/usr/bin/time', ['-f', '%U %S %e', '-o', join(output, `${tag}-cli.time`), process.execPath, join(src, 'src/cli/main.ts'), 'send', '--request', `bench-${tag}-cli`, '--to', 'absent-probe/key', '--kind', 'steer', '--message', 'probe', '--json', '--wait-ms', '60000'], { env: isolated(home) }, 90_000);
      await writeFile(join(output, `${tag}-cli.log`), JSON.stringify(cli, null, 2));
      if (cli.code !== 1 || !cli.stdout.includes('unknown-call')) throw new Error(`Unexpected CLI result: ${JSON.stringify(cli)}`);
      active.child.send('stream'); const stream = await active.wait('stream', 90_000);
      active.child.send('stop');
      const exit = await Promise.race([active.ended, delay(30_000).then(() => { throw new Error('Measurement shutdown timed out'); })]);
      await writeFile(join(output, `${tag}.log`), active.log());
      const report = { tag, src, original, warmExit, exit, ...ready, stream, cli, cliTime: await readFile(join(output, `${tag}-cli.time`), 'utf8') };
      reports.push(report); await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
      console.log(JSON.stringify(report));
      if (exit.code) throw new Error(JSON.stringify(exit));
    } finally {
      if (active && active.child.exitCode === null && active.child.signalCode === null) {
        active.child.kill('SIGTERM');
        const exited = await Promise.race([active.ended, delay(10_000).then(() => undefined)]);
        if (!exited) { active.child.kill('SIGKILL'); await active.ended; }
      }
      await rm(home, { recursive: true, force: true });
    }
  }
}
