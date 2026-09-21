const test = require("node:test");
const assert = require("node:assert/strict");
const { engine } = require("../scripts/lib");
const { loadRule, sortKeys, makeEnv, fakeLeetCode, CODE } = require("./helpers");

const URL_OK = "https://leetcode.com/submissions/detail/2145983977/";
const canon = (o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));

for (const id of ["leetcode.com/complexity-brief", "leetcode.com/complexity-explained"]) {
  const rule = loadRule(id);

  test(`${id}: extracts everything from a submission page`, async () => {
    const log = [];
    const r = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ log }) }));
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.values.problem_header, "132 Pattern (LeetCode #456, Medium)");
    assert.match(r.values.problem_details, /132 pattern/);
    assert.doesNotMatch(r.values.problem_details, /Example 1/);
    assert.match(r.values.problem_details, /1 <= n <= 2 \* 10\^5/);
    assert.match(r.values.submission_header, /JavaScript · Accepted · runtime 38 ms, beats 5.81% · memory 66.87 MB, beats 100%/);
    assert.ok(r.values.code_block.startsWith("```JavaScript\nvar find132pattern"));
    assert.equal(log[0].variables.submissionId, 2145983977, "the id is sent as a number");
    assert.equal(log[0].headers["x-csrftoken"], "abc123");
    assert.ok(log.every(l => l.url === "https://leetcode.com/graphql"));
    assert.equal(log.length, 3, "one request per query, no duplicates");
  });

  test(`${id}: does not depend on the order of keys (chrome.storage reorders them)`, async () => {
    const baseline = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode() }));
    for (const cmp of [undefined, (a, b) => (a < b ? 1 : -1)]) {
      const log = [];
      const r = await engine.extract(JSON.parse(JSON.stringify(sortKeys(rule, cmp))), makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ log }) }));
      assert.equal(canon(r.values), canon(baseline.values));
      assert.ok(log.some(l => l.variables.submissionId === 2145983977));
      assert.ok(log.some(l => l.variables.titleSlug === "132-pattern"));
    }
  });

  test(`${id}: signed out - explicit error, name from the page heading, no guessing`, async () => {
    const log = [];
    const html = `<a href="/problems/find-x-value-of-array-i/">Daily question</a>\n<h1>Submissions Detail - 132 Pattern</h1>\n<pre><code>var x = 1;</code></pre>`;
    const r = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ anonymous: true, log }), bodyHtml: html }));
    assert.ok(r.errors.some(e => e.includes("returned null")));
    assert.ok(!log.some(l => JSON.stringify(l.variables).includes("find-x-value")), "must not borrow another problem's slug from a stray link");
    assert.equal(r.values.problem_header, "132 Pattern");
    assert.ok(r.missing.includes("problem_details"));
    assert.ok(r.values.code_block.includes("var x = 1;"));
  });

  test(`${id}: question request fails - the problem name falls back to the slug`, async () => {
    const r = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ failQuestion: true }), bodyHtml: "<div>nothing</div>" }));
    assert.equal(r.values.problem_header, "132 Pattern");
    assert.ok(r.errors.some(e => e.includes('"question"')));
    assert.ok(r.values.code_block.includes("find132pattern"));
  });

  test(`${id}: stats failing degrades the header but keeps the code`, async () => {
    const r = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ failStats: true }) }));
    assert.equal(r.values.submission_header, "My submission (JavaScript):");
    assert.deepEqual(r.missing, []);
  });

  test(`${id}: a page heading with any dash still gives the name when the API is blocked`, async () => {
    for (const heading of ["Submissions Detail – 132 Pattern", "Submissions Detail ‑ 132 Pattern", "Submissions Detail - 132 Pattern   "]) {
      const r = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ failAll: true }), bodyHtml: `<h1>${heading}</h1>\n<pre>c</pre>` }));
      assert.equal(r.values.problem_header, "132 Pattern", heading);
    }
  });

  test(`${id}: code copied from the page loses its line numbers`, async () => {
    const numbered = "1/**\n2 * @param {number[]} nums\n3 */\n4var f = function(nums) {\n5    return a&lt;b;\n6};";
    const r = await engine.extract(rule, makeEnv({ url: URL_OK, fetchImpl: fakeLeetCode({ failAll: true }), bodyHtml: `<pre>${numbered}</pre>` }));
    assert.ok(r.values.code_block.includes("/**\n * @param {number[]} nums\n */\nvar f = function(nums) {\n    return a<b;\n};"));
  });

  test(`${id}: on the wrong page it warns and sends nothing`, async () => {
    let called = false;
    const r = await engine.extract(rule, makeEnv({ url: "https://leetcode.com/problemset/", fetchImpl: async () => { called = true; } }));
    assert.match(r.warning, /Open one of your submissions/);
    assert.equal(called, false);
  });

  test(`${id}: works on the /problems/<slug>/submissions/detail/<id> address too`, async () => {
    const r = await engine.extract(rule, makeEnv({ url: "https://leetcode.com/problems/132-pattern/submissions/detail/2145983977/", fetchImpl: fakeLeetCode() }));
    assert.equal(r.warning, "");
    assert.deepEqual(r.missing, []);
  });
}

test("leetcode.com/complexity-manual: builds the prompt from what the user typed", async () => {
  const rule = loadRule("leetcode.com/complexity-manual");
  const inputs = { title: "132 Pattern", number: "#456", description: "Given nums ...\nConstraints: n <= 2e5", code: CODE, style: "brief" };
  const r = await engine.extract(rule, makeEnv({ url: "https://leetcode.com/problems/132-pattern/", fetchImpl: async () => { throw new Error("no network expected"); }, inputs }));
  assert.equal(r.values.problem_header, "132 Pattern (LeetCode #456)");
  assert.ok(r.values.code_block.includes(CODE));
  assert.match(r.values.instructions, /No explanation/);
  const detailed = await engine.extract(rule, makeEnv({ url: "https://leetcode.com/", fetchImpl: async () => {}, inputs: { ...inputs, style: "detailed" } }));
  assert.match(detailed.values.instructions, /Please answer/);
  const blank = await engine.extract(rule, makeEnv({ url: "https://leetcode.com/", fetchImpl: async () => {}, inputs: { code: "x" } }));
  assert.equal(blank.values.problem_header, "(not provided)");
});

test("general/basic-test: a plain prompt with nothing to extract", () => {
  const rule = loadRule("general/basic-test");
  assert.equal(rule.variables, undefined);
  assert.match(rule.text, /47 multiplied by 83/);
});
