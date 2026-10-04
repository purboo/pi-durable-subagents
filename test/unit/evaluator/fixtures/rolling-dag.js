// Sanitized rolling-DAG executor: synthetic names, tasks and model identifiers only.
const LEAVES = [
  { key: 'a', deps: [] }, { key: 'b', deps: [] }, { key: 'c', deps: [] },
  { key: 'd', deps: ['a'] }, { key: 'e', deps: ['b', 'c'] },
  { key: 'f', deps: ['d', 'e'] },
];
const CONC = 2;
const admitted = new Set();
const running = new Map();
const done = [];
const failed = [];
let counter = 0;
let integration = Promise.resolve();
while (true) {
  for (const leaf of LEAVES) {
    if (running.size >= CONC) break;
    if (admitted.has(leaf.key)) continue;
    if (leaf.deps.some(key => failed.includes(key))) {
      admitted.add(leaf.key);
      failed.push(leaf.key);
      continue;
    }
    if (!leaf.deps.every(key => done.includes(key))) continue;
    admitted.add(leaf.key);
    const model = counter++ % 2 ? 'test/model-b' : 'test/model-a';
    const promise = runs.run(leaf.key, { agent: 'builder', task: leaf.key, model })
      .then(async result => {
        if (!result.ok) { failed.push(leaf.key); return; }
        const review = await runs.run('review-' + leaf.key, {
          agent: 'reviewer', task: result.output, model: counter++ % 2 ? 'test/model-b' : 'test/model-a',
        });
        if (!review.ok) { failed.push(leaf.key); return; }
        integration = integration.then(async () => {
          const merged = await runs.run('integrate-' + leaf.key, { agent: 'integrator', task: leaf.key });
          (merged.ok ? done : failed).push(leaf.key);
        });
        await integration;
      }).then(() => running.delete(leaf.key));
    running.set(leaf.key, promise);
  }
  if (!running.size) break;
  await Promise.race(Array.from(running.values()));
}
await integration;
return { done, failed };
