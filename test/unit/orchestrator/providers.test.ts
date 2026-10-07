import test from "node:test";
import assert from "node:assert/strict";
import { foldExhaustion, type Exhaustion } from "../../../src/orchestrator/providers.ts";
import { fatalProviderError, quotaExhausted } from "../../../src/orchestrator/executor/session.ts";
import type { Entry } from "../../../src/types.ts";

const fold = (entries: Record<string, unknown>[]) => { const m = new Map<string, Exhaustion>(); for (const e of entries) foldExhaustion(m, e as unknown as Entry); return m; };

test("used-up providers: exhausted until an answer; one probe, freed by its release", () => {
  let m = fold([{ type: "provider-exhausted", provider: "a", exec: "x#1.1", since: 1, nextTry: 10, error: "503 No available accounts" }]);
  assert.deepEqual(m.get("a"), { since: 1, nextTry: 10, error: "503 No available accounts" });
  m = fold([{ type: "provider-exhausted", provider: "a", exec: "x#1.1", since: 1, nextTry: 10, error: "e" }, { type: "provider-probe", provider: "a", exec: "y#1.1" }]);
  assert.equal(m.get("a")!.probe, "y#1.1");
  m = fold([{ type: "provider-exhausted", provider: "a", since: 1, nextTry: 10, error: "e" }, { type: "provider-probe", provider: "a", exec: "y#1.1" }, { type: "release", pool: "memory", exec: "y#1.1" }]);
  assert.equal(m.get("a")!.probe, "y#1.1", "only the release of the provider's own slot frees the probe");
  m = fold([{ type: "provider-exhausted", provider: "a", since: 1, nextTry: 10, error: "e" }, { type: "provider-probe", provider: "a", exec: "y#1.1" }, { type: "release", pool: "a", exec: "y#1.1" }]);
  assert.equal(m.get("a")!.probe, undefined);
  m = fold([{ type: "provider-exhausted", provider: "a", since: 1, nextTry: 10, error: "e" }, { type: "provider-probe", provider: "a", exec: "y#1.1" }, { type: "provider-available", provider: "a", exec: "y#1.1" }]);
  assert.equal(m.size, 0);
});

test("quota-class errors are told apart from billing errors and transient ones", () => {
  for (const text of ['503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"}}', "You have reached your usage limit; it resets at 19:00", "quota exceeded", "额度已用完"])
    assert.ok(quotaExhausted(text) && !fatalProviderError(text), text);
  for (const text of ["402 Payment Required", "insufficient_quota", "insufficient balance", "余额不足"])
    assert.ok(fatalProviderError(text) && !quotaExhausted(text), text);
  for (const text of ["Request timed out.", "Anthropic stream ended without a stop reason", "503 Service Unavailable", "429 Too Many Requests"])
    assert.ok(!quotaExhausted(text) && !fatalProviderError(text), text);
});
