import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems, validate } from "../../../src/agent/child/schema.ts";

test("T4: supported vocabulary has no problems and still validates", () => {
  const schema = { title: "R", description: "d", type: "object", required: ["items"], additionalProperties: false,
    properties: { items: { type: "array", items: { type: ["string", "null"], enum: ["yes", null] } }, extra: true, map: { type: "object", additionalProperties: { type: "integer" } } } };
  assert.deepEqual(schemaProblems(schema), []);
  for (const s of [true, false, {}]) assert.deepEqual(schemaProblems(s), []);
  assert.deepEqual(validate(schema, { items: ["yes", null] }), []);
  assert.deepEqual(validate(schema, { items: ["no"], other: 1 }), ["$.items[0]: not in enum", "$.other: additional property"]);
  assert.deepEqual(validate(schema, { map: { a: 1.5 } }), ["$.items: required", "$.map.a: expected integer"]);
});

test("T4: unsupported keywords and malformed shapes are reported with their path", () => {
  assert.deepEqual(schemaProblems({ type: "string", minLength: 1, pattern: "x" }), ['$: unsupported keyword "minLength"', '$: unsupported keyword "pattern"']);
  assert.deepEqual(schemaProblems({ properties: { a: { $ref: "#" } }, items: { oneOf: [] }, additionalProperties: { format: "uri" } }, "schema"),
    ['schema.properties.a: unsupported keyword "$ref"', 'schema.items: unsupported keyword "oneOf"', 'schema.additionalProperties: unsupported keyword "format"']);
  const types = "must be one of null, boolean, object, array, number, integer, string or a nonempty array of them";
  assert.deepEqual(schemaProblems({ type: "text" }), [`$.type: ${types}`]);
  assert.deepEqual(schemaProblems({ type: [] }), [`$.type: ${types}`]);
  assert.deepEqual(schemaProblems({ enum: "a" }), ["$.enum: must be an array"]);
  assert.deepEqual(schemaProblems({ items: [{ type: "string" }] }), ["$.items: must be an object or boolean"]);
  assert.deepEqual(schemaProblems({ properties: [] }), ["$.properties: must be an object of schemas"]);
  assert.deepEqual(schemaProblems({ required: "a" }), ["$.required: must be an array of strings"]);
  assert.deepEqual(schemaProblems({ required: [1] }), ["$.required: must be an array of strings"]);
  assert.deepEqual(schemaProblems({ title: 1, description: null }), ["$.title: must be a string", "$.description: must be a string"]);
  for (const s of [null, 1, "object", []]) assert.deepEqual(schemaProblems(s), ["$: must be an object or boolean"]);
});
