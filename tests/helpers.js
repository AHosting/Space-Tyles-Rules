const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { RULES_DIR, engine } = require("../scripts/lib");

const loadRule = (id) => engine.normalizeRule(JSON.parse(fs.readFileSync(path.join(RULES_DIR, id + ".json"), "utf8")));

// chrome.storage returns object keys in a different order than they were written; rules must not depend on it.
const sortKeys = (o, cmp) => Array.isArray(o) ? o.map(x => sortKeys(x, cmp))
  : (o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort(cmp).map(k => [k, sortKeys(o[k], cmp)])) : o);

function makeEnv({ url, fetchImpl, bodyHtml = "", inputs }) {
  const dom = new JSDOM(`<body>${bodyHtml}</body>`, { url });
  dom.window.document.cookie = "csrftoken=abc123";
  return { location: dom.window.location, document: dom.window.document, fetch: fetchImpl, DOMParser: dom.window.DOMParser, inputs };
}

const QUESTION_HTML = `<p>Given an array of <code>n</code> integers <code>nums</code>, a <strong>132 pattern</strong> is a subsequence of three integers such that <code>i &lt; j &lt; k</code>.</p>
<p>&nbsp;</p>
<p><strong class="example">Example 1:</strong></p>
<pre><strong>Input:</strong> nums = [1,2,3,4]
<strong>Output:</strong> false
</pre>
<p>&nbsp;</p>
<p><strong>Constraints:</strong></p>
<ul>
<li><code>n == nums.length</code></li>
<li><code>1 &lt;= n &lt;= 2 * 10<sup>5</sup></code></li>
</ul>`;
const CODE = "var find132pattern = function(nums) {\n    if (nums.length<3) return false;\n    return true;\n};";

// A stand-in for leetcode.com/graphql that behaves like the real one where we verified it:
// an empty id/slug is an error / null, submissionId is an Int, validation errors come back as HTTP 400.
function fakeLeetCode({ anonymous = false, failAll = false, failQuestion = false, failStats = false, log = [] } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    log.push({ url, headers: opts.headers, query: body.query, variables: body.variables });
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    const bad = (status, message) => ({ ok: false, status, json: async () => ({ errors: [{ message }] }) });
    if (failAll) return { ok: false, status: 403, json: async () => ({ detail: "forbidden" }) };
    if (body.query.includes("submissionDetails")) {
      if (body.variables.submissionId === "") return bad(400, "could not convert string to float: ''");
      if (anonymous) return ok({ submissionDetails: null });
      if (body.query.includes("statusCode")) {
        if (failStats) return bad(400, 'Cannot query field "runtimeDisplay"');
        return ok({ submissionDetails: { statusCode: 10, runtimeDisplay: "38 ms", runtimePercentile: 5.8123, memoryDisplay: "66.87 MB", memoryPercentile: 100 } });
      }
      return ok({ submissionDetails: { code: CODE, lang: { name: "javascript", verboseName: "JavaScript" }, question: { titleSlug: "132-pattern" } } });
    }
    if (body.query.includes("question(")) {
      if (!body.variables.titleSlug) return ok({ question: null });
      if (failQuestion) return bad(400, 'Cannot query field "questionFrontendId"');
      return ok({ question: { questionFrontendId: "456", title: "132 Pattern", difficulty: "Medium", content: QUESTION_HTML } });
    }
    return bad(400, "unknown query");
  };
}

module.exports = { loadRule, sortKeys, makeEnv, fakeLeetCode, CODE };
