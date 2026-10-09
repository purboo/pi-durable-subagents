import test from "node:test";
import assert from "node:assert/strict";
import { foldExhaustion, type Exhaustion } from "../../../src/orchestrator/providers.ts";
import { fatalProviderError, quotaExhausted, sessionModel, type SessionEntry } from "../../../src/orchestrator/executor/session.ts";
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
  m = fold([{ type: "provider-exhausted", provider: "a", exec: "x#1.1", since: 1, nextTry: 10, error: "e" }, { type: "provider-probe", provider: "a", exec: "y#1.1" }, { type: "provider-exhausted", provider: "a", exec: "z#1.1", since: 1, nextTry: 20, error: "e" }]);
  assert.equal(m.get("a")!.probe, "y#1.1", "another execution's refusal does not end the probe");
  m = fold([{ type: "provider-exhausted", provider: "a", exec: "x#1.1", since: 1, nextTry: 10, error: "e" }, { type: "provider-probe", provider: "a", exec: "y#1.1" }, { type: "provider-exhausted", provider: "a", exec: "y#1.1", since: 1, nextTry: 20, error: "e" }]);
  assert.equal(m.get("a")!.probe, undefined, "the probe's refusal ends it");
});

test("quota-class errors are told apart from billing errors and transient ones", () => {
  for (const text of ['503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"}}', "You have reached your usage limit; it resets at 19:00", "quota exceeded", "\u989d\u5ea6\u5df2\u7528\u5b8c"])
    assert.ok(quotaExhausted(text) && !fatalProviderError(text), text);
  for (const text of ["402 Payment Required", "insufficient_quota", "insufficient balance", "\u4f59\u989d\u4e0d\u8db3"])
    assert.ok(fatalProviderError(text) && !quotaExhausted(text), text);
  for (const text of ["Request timed out.", "Anthropic stream ended without a stop reason", "503 Service Unavailable", "429 Too Many Requests", "429 rate limit exceeded; resets in 1 second", "429 request limit reached; reset in 10 seconds", "Quota exceeded for quota metric 'requests per minute'", "usage limit exceeded, resets in 30 seconds"])
    assert.ok(!quotaExhausted(text) && !fatalProviderError(text), text);
});

// Texts real providers returned on the maintainer's machine (ids redacted).
test("real provider errors: daily windows fail over, rate and concurrency limits do not", () => {
  for (const text of [
    '503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"},"type":"error"}',
    // A daily window, not a balance: "remaining quota" contains the word for "balance", but the quota resets at midnight.
    '{"error":{"message":"\u60a8\u76842026-10-02\u989d\u5ea6\u5df2\u4f7f\u7528\u5b8c\u6bd5\uff0c\u5f53\u524d\u5269\u4f59\u989d\u5ea6\u4e3a 0\u3002\u989d\u5ea6\u5c06\u4e8e\u6b21\u65e5 00:00:00\u81ea\u52a8\u91cd\u7f6e\u3002\u5982\u9700\u7533\u8bf7\u63d0\u989d\uff1ahttps://credit.example/apply","type":"payment_required"},"type":"error"}',
  ]) assert.ok(quotaExhausted(text) && !fatalProviderError(text), text);
  assert.ok(fatalProviderError("\u8d26\u6237\u4f59\u989d\u4e0d\u8db3") && fatalProviderError("\u4f59\u989d\u4e0d\u8db3\uff0c\u5f53\u524d\u5269\u4f59\u989d\u5ea6\u4e3a 0"), "a balance is still terminal");
  for (const text of [
    "rate_limit_exceeded: \u60a8\u7684\u8d26\u6237\u5df2\u8fbe\u5230\u901f\u7387\u9650\u5236\uff0c\u8bf7\u60a8\u63a7\u5236\u8bf7\u6c42\u9891\u7387[0123456789abcdef]",
    "rate_limit_exceeded: App:**0000\u5728\u6a21\u578b:deepseek-v4-flash\u6bcf\u5206\u949f\u8bf7\u6c42\u6b21\u6570\u8d85\u8fc7\u9650\u5236",
    "gateway_concurrency_limit: Concurrency limit exceeded for user, please retry later (rate limit)",
    'friday API error (429): {"message":"Too many concurrent responses create requests; global concurrency limit reached (96/96)","type":"rate_limit_error","param":null,"code":"request_rate_limited"}',
    '429 {"error":{"message":"Upstream rate limit exceeded, please retry later","type":"rate_limit_error"},"type":"error"}',
    'sota API error (404): {"message":"Model \\"gpt-6-astra-fast\\" is not supported by any configured account in this group","type":"model_not_found"}',
    'sota API error (503): {"message":"Service temporarily unavailable","type":"api_error"}',
    "server_error: Scheduler unavailable",
  ]) assert.ok(!quotaExhausted(text) && !fatalProviderError(text), text);
});

test("the session's model is pi's: the last model change or assistant message", () => {
  const change = { type: "model_change", provider: "qa", modelId: "m" };
  const answer = (provider: string) => ({ type: "message", message: { role: "assistant", provider, model: "m" } });
  assert.deepEqual(sessionModel([change] as SessionEntry[]), { provider: "qa", id: "m" });
  assert.deepEqual(sessionModel([change, answer("qa"), answer("qb")] as SessionEntry[]), { provider: "qb", id: "m" }, "a relaunch with --model records no model change");
  assert.deepEqual(sessionModel([answer("qb"), { ...change }] as SessionEntry[]), { provider: "qa", id: "m" });
  assert.equal(sessionModel([{ type: "message", message: { role: "user" } }] as SessionEntry[]), undefined);
});
