import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PI_BIN, REPO } from '../../harness/pi.ts';

test('real CLI smoke reports execution and degraded UI; missing pi exits nonzero', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-cli-smoke-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, DSA_HOME: join(home, 'state'), PI_CODING_AGENT_DIR: join(home, 'agent'), DSA_PI_BIN: PI_BIN };
  const entry = join(home, 'pi-durable-subagents');
  await symlink(join(REPO, 'src/cli/main.ts'), entry);
  const args = [entry, 'smoke'];
  const { stdout } = await promisify(execFile)(process.execPath, args, { env, timeout: 20000 });
  t.diagnostic(stdout.trim());
  for (const capability of ['process-table', 'spawn/tag/fence', 'lock', 'publishFile', 'pi-version']) assert.match(stdout, new RegExp(`execution ok: ${capability}`));
  assert.match(stdout, /UI degraded:/); assert.match(stdout, /1\.0\.2/); assert.match(stdout, /clears its tag/);
  await assert.rejects(promisify(execFile)(process.execPath, args, { env: { ...env, DSA_PI_BIN: join(home, 'missing-pi') }, timeout: 20000 }), (error: unknown) => {
    const result = error as { code: number; stdout: string };
    assert.equal(result.code, 1); assert.match(result.stdout, /execution FAILED: pi-version/); assert.match(result.stdout, /UI degraded:/); return true;
  });
});
