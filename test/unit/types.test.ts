import { test } from "node:test";
import assert from "node:assert/strict";
import { CT, ENV } from "../../src/types.ts";

test("pinned custom entry types are unique", () => {
  const v = Object.values(CT);
  assert.equal(new Set(v).size, v.length);
  assert.ok(Object.values(ENV).every(x => x.startsWith("DSA_")));
});
