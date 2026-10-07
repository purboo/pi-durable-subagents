import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLedger, emptyLedger, foldLedger, holdings, settingsOf, type LedgerState } from "../../../src/orchestrator/ledger.ts";
import type { Entry } from "../../../src/types.ts";

function randomLedger(n: number, seed: number): Entry[] {
  let x = seed;
  const rnd = (k: number) => { x = (x * 1103515245 + 12345) % 2 ** 31; return x % k; };
  const out: Entry[] = [];
  for (let i = 1; i <= n; i++) {
    const pool = ["p", "q", "memory"][rnd(3)]!, slot = rnd(3), exec = `e${rnd(4)}`;
    const kinds: Record<string, unknown>[] = [
      { type: "hold", pool, slot, exec }, { type: "release", pool, slot, exec },
      { type: "config", hash: `h${i}`, config: { providers: { p: { slots: rnd(3) } } } }, { type: "config-rejected", error: `bad ${i}` },
      { type: "skip", pool: "pool", model: `p/m${rnd(2)}`, until: i * 10 }, { type: "switch-observed", exec, rid: `r${rnd(3)}` },
      { type: "provider-exhausted", provider: pool, exec, since: i, nextTry: i + 5, error: "used up" }, { type: "provider-available", provider: pool, exec },
    ];
    out.push(Object.freeze({ seq: i, ts: i, ...kinds[rnd(kinds.length)]! }) as Entry);
  }
  return out;
}
const view = (s: LedgerState) => JSON.stringify({ held: [...s.held].sort(), observed: [...s.observed].sort(), skips: [...s.skips].sort(), exhausted: [...s.exhausted].sort(), config: s.config, rejected: s.rejected });

test("A1 the orchestrator ledger fold extended as the ledger grows equals one fold of the whole ledger", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const all = randomLedger(120, seed), whole = emptyLedger();
    for (const e of all) applyLedger(whole, e);
    const grown = emptyLedger();
    for (let end = 0; end <= all.length; end += 1 + (seed % 7)) foldLedger(grown, all.slice(0, end));
    foldLedger(grown, all);
    assert.equal(view(grown), view(whole), `seed ${seed}`);
    assert.equal(grown.seen, all.length);
  }
});

test("A1 another ledger (not a continuation of the one folded) is folded from the start", () => {
  const a = randomLedger(40, 3), b = randomLedger(60, 4), state = foldLedger(emptyLedger(), a);
  foldLedger(state, b);
  assert.equal(view(state), view(foldLedger(emptyLedger(), b)));
  foldLedger(state, b.slice(0, 10)); // shorter: a rewritten ledger
  assert.equal(view(state), view(foldLedger(emptyLedger(), b.slice(0, 10))));
});

test("A4 settings in effect are the last recorded ones, a rejection keeps them, and a release frees only its holder", () => {
  const e = (seq: number, fields: Record<string, unknown>) => ({ seq, ts: seq, ...fields }) as Entry;
  const given = { providers: { p: { slots: 9 } } };
  const state = foldLedger(emptyLedger(), []);
  assert.equal(settingsOf(state, given), given, "nothing recorded: the given settings");
  foldLedger(state, [e(1, { type: "config", hash: "a", config: { providers: { p: { slots: 1 } } } }), e(2, { type: "config-rejected", error: "bad" }),
    e(3, { type: "hold", pool: "p", slot: 0, exec: "x" }), e(4, { type: "release", pool: "p", slot: 0, exec: "y" })]);
  assert.deepEqual(settingsOf(state, given), { providers: { p: { slots: 1 } } });
  assert.equal(state.rejected?.error, "bad");
  assert.deepEqual(holdings(state).map(h => h.exec), ["x"], "a release by another execution frees nothing");
});
