import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual V1–V8 removed-predicate source mutants each fail the guard suite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-guard-mutants-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await readFile(new URL('../../../src/kernel/guards.ts', import.meta.url), 'utf8');
  const suite = await readFile(new URL('./guards.test.ts', import.meta.url), 'utf8');
  const names = ['capacity', 'seal', 'currency', 'openness', 'dependency', 'monotoneTime', 'singlePresentation', 'budgets'];
  for (const [index, name] of names.entries()) {
    const mutant = join(dir, `v${index + 1}.ts`), testPath = join(dir, `v${index + 1}.test.ts`);
    await writeFile(mutant, source.replace(`export function ${name}(`, `function removed_${name}(`) + `\nexport const ${name} = () => true;\n`);
    await writeFile(testPath, suite.replace('../../../src/kernel/guards.ts', mutant));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', testPath], { env, encoding: 'utf8', timeout: 10000, cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
    assert.equal(result.status, 1, `V${index + 1} mutant must fail: ${result.stderr}`);
    assert.match(result.stdout, /forbidden transition committed/);
    t.diagnostic(`V${index + 1} ${name}: removed guard killed (exit ${result.status})`);
    if (name === 'dependency') {
      const lifecycle = await readFile(new URL('../../../src/kernel/lifecycle.ts', import.meta.url), 'utf8');
      const lifecycleSuite = await readFile(new URL('./lifecycle.test.ts', import.meta.url), 'utf8');
      const lifecyclePath = join(dir, 'lifecycle.ts'), lifecycleTestPath = join(dir, 'lifecycle.test.ts');
      const idsPath = fileURLToPath(new URL('../../../src/kernel/ids.ts', import.meta.url));
      await writeFile(lifecyclePath, lifecycle.replace('./guards.ts', mutant).replace('./ids.ts', idsPath));
      await writeFile(lifecycleTestPath, lifecycleSuite.replaceAll('../../../src/kernel/lifecycle.ts', lifecyclePath));
      const integration = spawnSync(process.execPath, ['--test', '--test-name-pattern=V5 withdrawal', lifecycleTestPath], { env, encoding: 'utf8', timeout: 10000 });
      assert.equal(integration.status, 1, `V5 lifecycle mutant must fail: ${integration.stderr}`);
      assert.match(integration.stdout, /V5 withdrawal rejects unknown/);
      assert.match(integration.stdout, /V5 withdrawal leaves targets untouched/);
      assert.match(integration.stdout, /AssertionError/);
      t.diagnostic('V5 real lifecycle withdrawal path: removed guard killed (exit 1)');
    }
  }
});
