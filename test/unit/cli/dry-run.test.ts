import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageService, serviceFiles } from '../../../src/cli/service.ts';
import { main } from '../../../src/cli/main.ts';

test('service dry-run renders both platforms without filesystem or runner effects', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-cli-dry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let calls = 0;
  const runner = async () => { calls++; };
  for (const platform of ['linux', 'darwin']) for (const install of [true, false]) {
    const files = serviceFiles(home, join(home, 'state'), '/cli.ts', platform), output: string[] = [];
    await manageService(files, install, { platform, uid: 123, dryRun: true, runner, write: line => output.push(line) });
    for (const file of files) assert.ok(output.includes(`${file.path}\n${file.content}`));
    assert.ok(output.some(line => line.startsWith(platform === 'linux' ? 'systemctl --user ' : 'launchctl ')));
    assert.deepEqual(await readdir(home), []);
  }
  for (const command of ['install-service', 'uninstall-service']) {
    const output: string[] = [];
    assert.equal(await main([command, '--dry-run'], { env: { HOME: home, DSA_HOME: join(home, 'state') }, serviceRunner: runner, write: line => output.push(line) }), 0);
    assert.ok(output.some(line => / start\n|<string>start<\/string>/.test(line)));
    assert.ok(!output.some(line => line.includes('resume')));
    assert.deepEqual(await readdir(home), []);
  }
  assert.equal(calls, 0);
});
