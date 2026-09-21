const test = require("node:test");
const assert = require("node:assert/strict");
const { engine, listRuleFiles, readRule } = require("../scripts/lib");
const { loadRule } = require("./helpers");

const base = () => JSON.parse(JSON.stringify(loadRule("leetcode.com/complexity-brief")));
const problems = (rule) => engine.validateRule(rule);
const mentions = (rule, needle) => problems(rule).some(p => p.includes(needle));

test("every rule in rules/ passes the engine validator", () => {
  for (const f of listRuleFiles()) {
    const { rule } = readRule(f);
    assert.deepEqual(problems(rule), [], f);
  }
});

test("rejects GraphQL mutations and subscriptions (requests carry the user's cookies)", () => {
  for (const q of ["mutation { deleteAccount }", "query a { x } mutation b { y }", "subscription { x }", "fragment F on X { y }"]) {
    const r = base(); r.requests.question.query = q;
    assert.ok(mentions(r, "read-only GraphQL"), q);
  }
});

test("rejects requests to another origin", () => {
  for (const endpoint of ["https://evil.example/graphql", "//evil.example/x", "graphql"]) {
    const r = base(); r.requests.question.endpoint = endpoint;
    assert.ok(mentions(r, "endpoint"), endpoint);
  }
});

test("rejects regexes that can hang the tab", () => {
  for (const regex of ["(a+)+$", "(.*)*x", "(a|b+)*c", "a".repeat(400), "(unclosed"]) {
    const r = base(); r.variables.title.sources[1].regex = regex;
    assert.ok(mentions(r, "regex"), regex);
  }
  const r = base(); r.match.pathRegex = "(x+)+y";
  assert.ok(mentions(r, "pathRegex"));
});

test("rejects unknown fields (nothing can be smuggled in)", () => {
  const r = base(); r.script = "alert(1)";
  assert.ok(mentions(r, 'unknown field "script"'));
});

test("the JSON Schema rejects unknown keys at every level, not just the top", () => {
  const Ajv = require("ajv");
  const fs = require("fs");
  const path = require("path");
  const validate = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schema", "rule.schema.json"), "utf8")));
  assert.equal(validate(base()), true);
  const inSource = base(); inSource.variables.code.sources[0].eval = "1";
  assert.equal(validate(inSource), false);
  const inVariable = base(); inVariable.variables.code.onload = "x";
  assert.equal(validate(inVariable), false);
  const inRequest = base(); inRequest.requests.question.headers = { a: "b" };
  assert.equal(validate(inRequest), false);
  const inInput = loadRule("leetcode.com/complexity-manual"); inInput.inputs[0].script = "x";
  assert.equal(validate(inInput), false);
});

test("rejects unknown source types and transforms (no code hooks)", () => {
  const r = base(); r.variables.code.sources[0].from = "js";
  assert.ok(mentions(r, "from must be one of"));
  const t = base(); t.variables.code.transform = "eval";
  assert.ok(mentions(t, "transform must be one of"));
});

test("rejects templates that use unknown or hidden variables", () => {
  const r = base(); r.text = r.text.replace("{{code_block}}", "{{code}}");
  assert.ok(mentions(r, "{{code}}"));
  const u = base(); u.text += "\n{{nope}}";
  assert.ok(mentions(u, "{{nope}}"));
});

test("rejects references to things that do not exist", () => {
  const r = base(); r.variables.code.sources[0].request = "missing";
  assert.ok(mentions(r, 'request "missing"'));
  const v = base(); v.variables.statement.sources[0].name = "ghost";
  assert.ok(mentions(v, 'unknown variable "ghost"'));
  const m = loadRule("leetcode.com/complexity-manual"); m.variables.title.sources[0].name = "ghost";
  assert.ok(mentions(m, 'not a declared input'));
});

test("rejects variable cycles", () => {
  const r = base();
  r.variables.a = { hidden: true, sources: [{ from: "var", name: "b" }] };
  r.variables.b = { hidden: true, sources: [{ from: "var", name: "a" }] };
  assert.ok(mentions(r, "cycle"));
});

test("rejects bad identity and metadata", () => {
  for (const [field, value, needle] of [["id", "Bad ID", "id must"], ["version", 0, "version"], ["minEngine", "1", "minEngine"], ["domains", [], "domains"], ["domains", ["not a host"], "domains"], ["name", "", "name"], ["schemaVersion", 2, "schemaVersion"]]) {
    const r = base(); r[field] = value;
    assert.ok(mentions(r, needle), `${field}=${JSON.stringify(value)}`);
  }
});

test("rejects a rule that is too large", () => {
  const r = base(); r.description = "x".repeat(300); r.text += "y".repeat(70000);
  assert.ok(mentions(r, "larger than"));
});

test("engine limits still cap what a rule can pull in, whatever it asks for", async () => {
  const { makeEnv } = require("./helpers");
  const rule = { schemaVersion: 1, id: "test/big", version: 1, minEngine: 1, name: "t", description: "t", domains: ["*"], text: "{{all}}",
    variables: { all: { maxChars: 49999, sources: [{ from: "css", selector: "body" }] } } };
  const r = await engine.extract(rule, makeEnv({ url: "https://example.com/", fetchImpl: async () => {}, bodyHtml: "x".repeat(80000) }));
  assert.ok(r.values.all.length <= 50000 + 20);
  const noCap = { ...rule, variables: { all: { sources: [{ from: "css", selector: "body" }] } } };
  const r2 = await engine.extract(noCap, makeEnv({ url: "https://example.com/", fetchImpl: async () => {}, bodyHtml: "x".repeat(80000) }));
  assert.ok(r2.values.all.length <= engine.LIMITS.defaultVariableChars + 20);
});

test("engine refuses a mutation at run time even if validation was skipped", async () => {
  const { makeEnv } = require("./helpers");
  const rule = base(); rule.requests.question.query = "mutation { deleteAccount }";
  const sent = [];
  const r = await engine.extract(rule, makeEnv({ url: "https://leetcode.com/submissions/detail/1/", fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body).query); return { ok: true, json: async () => ({ data: {} }) }; } }));
  assert.ok(!sent.some(q => q.includes("mutation")), "the mutation must never be sent");
  assert.ok(r.errors.some(e => e.includes("read-only GraphQL")));
});

test("engine refuses an unsafe regex at run time", async () => {
  const { makeEnv } = require("./helpers");
  const rule = { schemaVersion: 1, id: "test/redos", version: 1, minEngine: 1, name: "t", description: "t", domains: ["*"], text: "{{x}}",
    variables: { x: { sources: [{ from: "css", selector: "body", regex: "(a+)+$" }] } } };
  const r = await engine.extract(rule, makeEnv({ url: "https://example.com/", fetchImpl: async () => {}, bodyHtml: "a".repeat(40) + "!" }));
  assert.ok(r.errors.some(e => e.includes("regex rejected")));
});
