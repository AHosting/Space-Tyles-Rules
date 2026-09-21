// Context Hypervisor - Declarative Rule Engine (content script)
//
// Rules are plain data (no code) so they can be shared/downloaded safely later.
// A rule with a `variables` map is resolved into { name: text } values that fill
// the {{placeholders}} in the rule's prompt template.
//
// variable  = { sources: [source, ...], transform?, map?, maxChars?, hidden? }
//   - sources are tried in order; the first non-empty result wins.
//   - hidden variables are helpers: usable by other variables, never sent or reported.
//   - variables resolve on demand, so declaration order does not matter (chrome.storage reorders keys).
// source    = { from: "url" | "css" | "graphql" | "var" | "format" | "literal", regex?, ... }
//   url     { regex }                       regex over location.href (capture group 1)
//   css     { selector, attr?, regex? }     text (or attribute) of matching elements
//   graphql { request, path }               value at `path` in a same-origin request's JSON
//   var     { name, regex? }                another variable
//   format  { template }                    "{{a}} {{b}}"; empty if any referenced var is empty
//   input   { name, regex? }                a value the user typed into the rule's form (see rule.inputs)
//   literal { value }
// rule.inputs   = [{ key, label, type: "text" | "textarea" | "select", required?, placeholder?, rows?, default?, options? }]
//   - a rule with inputs shows a form in the modal; the values are read by `input` sources.
// rule.requests = { name: { endpoint?, query: string | [string], variables?, numericVars? } }
//   - `query` may list alternates; they are tried in order until one succeeds.
//   - requests are POSTed as JSON and only ever to the current page's own origin.
(function (root) {
  // Bumped when the engine gains a capability rules can rely on. Rules declare `minEngine`; an extension whose
  // engine is older than that must not run (or install) the rule.
  const ENGINE_VERSION = 1;

  // Rules can come from a public registry, so the engine enforces its own limits regardless of what a rule says.
  const LIMITS = {
    maxRegexLength: 300,
    maxRegexInput: 300000,
    defaultVariableChars: 20000,
    maxVariableChars: 50000,
    maxQueryLength: 20000,
    maxRuleBytes: 60000
  };

  // Rejects invalid, over-long, or catastrophic-backtracking-prone patterns (a quantified group that itself contains
  // a quantifier, e.g. (a+)+ or (.*)*), because a regex cannot be interrupted once it is running.
  function isSafeRegex(pattern) {
    if (typeof pattern !== "string" || !pattern || pattern.length > LIMITS.maxRegexLength) return false;
    if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) return false;
    try { new RegExp(pattern); } catch (e) { return false; }
    return true;
  }

  // Only read-only GraphQL queries: a rule's requests carry the user's cookies, so a mutation could change data.
  function isQueryOnly(doc) {
    if (typeof doc !== "string" || !doc.trim() || doc.length > LIMITS.maxQueryLength) return false;
    const stripped = doc.replace(/"""[\s\S]*?"""/g, "").replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/#[^\n]*/g, "");
    return /^\s*(query\b|\{)/.test(stripped) && !/\b(mutation|subscription)\b/i.test(stripped);
  }

  function defaultEnv() {
    return {
      location: root.location,
      document: root.document,
      fetch: root.fetch ? root.fetch.bind(root) : undefined,
      DOMParser: root.DOMParser
    };
  }

  function hostMatches(domainMatch, host) {
    if (!domainMatch || domainMatch === "*") return true;
    const dm = String(domainMatch).toLowerCase().replace(/^www\./, "");
    const h = String(host || "").toLowerCase().replace(/^www\./, "");
    return h === dm || h.endsWith("." + dm);
  }

  function pathMatches(rule, env) {
    const pathRegex = rule && rule.match && rule.match.pathRegex;
    if (!pathRegex) return true;
    if (!isSafeRegex(pathRegex)) return false;
    return new RegExp(pathRegex).test((env || defaultEnv()).location.pathname);
  }

  // A rule applies to a host if any of its `domains` match (rules from the registry), or its `domainMatch` does
  // (rules the user wrote by hand).
  function ruleMatchesHost(rule, host) {
    const list = Array.isArray(rule && rule.domains) && rule.domains.length ? rule.domains : [rule && rule.domainMatch];
    return list.some(d => hostMatches(d, host));
  }

  function isCompatible(rule) {
    return Number.isInteger(rule && rule.minEngine) ? rule.minEngine <= ENGINE_VERSION : true;
  }

  function toText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  }

  function getByPath(obj, path) {
    return String(path || "").split(".").filter(Boolean).reduce(
      (cur, key) => (cur === null || cur === undefined ? undefined : cur[key]),
      obj
    );
  }

  function applyRegex(text, regex) {
    if (!regex) return text;
    if (!isSafeRegex(regex)) throw new Error("regex rejected (invalid, too long, or prone to catastrophic backtracking)");
    const m = new RegExp(regex).exec(text.length > LIMITS.maxRegexInput ? text.slice(0, LIMITS.maxRegexInput) : text);
    return m ? (m[1] !== undefined ? m[1] : m[0]) : "";
  }

  function fillVars(str, ctx) {
    return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] || "");
  }

  function htmlToText(html, env) {
    const Parser = (env || defaultEnv()).DOMParser;
    const doc = new Parser().parseFromString(String(html), "text/html");
    doc.querySelectorAll("script, style, img").forEach(el => el.remove());
    doc.querySelectorAll("sup").forEach(el => el.replaceWith("^" + el.textContent));
    doc.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
    doc.querySelectorAll("li").forEach(el => el.prepend("- "));
    doc.querySelectorAll("p, div, pre, ul, ol, li, h1, h2, h3, h4, h5, h6").forEach(el => el.append("\n"));
    return (doc.body.textContent || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Code copied from a rendered editor often has line numbers glued on ("1/**", "2 * @param"). Strip them only
  // when nearly every line starts with its own running line number, so real code is never touched.
  function stripLineNumbers(text) {
    const lines = text.split("\n");
    const has = (line, n) => line.startsWith(String(n)) && !/\d/.test(line.charAt(String(n).length));
    const hits = lines.filter((line, i) => has(line, i + 1)).length;
    if (lines.length < 3 || hits < Math.max(3, Math.floor(lines.length * 0.8))) return text;
    return lines.map((line, i) => (has(line, i + 1) ? line.slice(String(i + 1).length) : line)).join("\n");
  }

  function postProcess(value, spec, env) {
    let out = value;
    if (spec.transform === "htmlToText") out = htmlToText(out, env);
    else if (spec.transform === "round2") {
      const n = parseFloat(out);
      out = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "";
    } else if (spec.transform === "slugToTitle") {
      out = out.split("-").filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    } else if (spec.transform === "stripLineNumbers") out = stripLineNumbers(out);
    else if (spec.transform === "trim") out = out.trim();

    if (spec.map) out = Object.prototype.hasOwnProperty.call(spec.map, out) ? spec.map[out] : "";

    const cap = Math.min(spec.maxChars || LIMITS.defaultVariableChars, LIMITS.maxVariableChars);
    if (out.length > cap) {
      out = out.slice(0, cap).trimEnd() + "\n…[truncated]";
    }
    return out;
  }

  function csrfToken(env) {
    const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(env.document.cookie || "");
    return m ? decodeURIComponent(m[1]) : "";
  }

  function runGraphql(rule, name, scope, env, cache) {
    if (cache[name]) return cache[name];
    cache[name] = (async () => {
      const req = rule.requests && rule.requests[name];
      if (!req) throw new Error(`unknown request "${name}"`);

      const url = new URL(req.endpoint || "/graphql", env.location.origin);
      if (url.origin !== env.location.origin) throw new Error("cross-origin requests are not allowed");

      const variables = {};
      for (const [k, v] of Object.entries(req.variables || {})) {
        // Make sure every variable this request needs has been resolved (storage does not preserve key order).
        for (const m of String(v).matchAll(/\{\{(\w+)\}\}/g)) await scope.get(m[1]);
        const filled = fillVars(v, scope.ctx);
        variables[k] = (req.numericVars || []).includes(k) && /^\d+$/.test(filled) ? Number(filled) : filled;
      }

      const headers = { "Content-Type": "application/json" };
      const token = csrfToken(env);
      if (token) headers["x-csrftoken"] = token;

      const queries = Array.isArray(req.query) ? req.query : [req.query];
      if (!queries.every(isQueryOnly)) throw new Error("only read-only GraphQL queries are allowed");
      const failures = [];
      for (const query of queries) {
        try {
          const res = await env.fetch(url.href, {
            method: "POST",
            credentials: "same-origin",
            headers,
            body: JSON.stringify({ query, variables })
          });
          let json = null;
          try { json = await res.json(); } catch (e) {}
          // Keep the server's own message: e.g. LeetCode answers schema errors with HTTP 400 and the reason in the body.
          const apiMessage = json && json.errors && json.errors[0] && json.errors[0].message;
          if (!res.ok) throw new Error(`HTTP ${res.status}${apiMessage ? ": " + apiMessage : ""}`);
          if (!json) throw new Error("response was not JSON");
          if (json.errors && json.errors.length) throw new Error(apiMessage || "GraphQL error");
          // A valid query whose result is null means the server refused or found nothing (e.g. no session,
          // or not your submission). That is authoritative: trying other query variants would not change it.
          const top = json.data && typeof json.data === "object" ? Object.values(json.data) : [];
          if (top.length && top.every(v => v === null)) {
            throw Object.assign(new Error(`returned null (not signed in to this site, or no access to this item?) [sent ${JSON.stringify(variables)}]`), { final: true });
          }
          return json;
        } catch (e) {
          if (e.final) throw e;
          const msg = `${String(e.message).slice(0, 200)} [sent ${JSON.stringify(variables)}]`;
          if (!failures.includes(msg)) failures.push(msg);
        }
      }
      throw new Error(failures.join(" | ") || "no query defined");
    })();
    return cache[name];
  }

  async function resolveSource(src, scope, rule, env, cache) {
    switch (src.from) {
      case "url":
        return applyRegex(env.location.href, src.regex);
      case "css": {
        const parts = [];
        // A selector list like "pre code, pre" matches nested elements; keep only the outermost so text isn't duplicated.
        const matches = Array.from(env.document.querySelectorAll(src.selector));
        matches.filter(el => !matches.some(other => other !== el && other.contains(el))).forEach(el => {
          const t = src.attr ? el.getAttribute(src.attr) : (el.innerText !== undefined ? el.innerText : el.textContent);
          if (t) parts.push(t);
        });
        return applyRegex(parts.join("\n\n").trim(), src.regex);
      }
      case "graphql": {
        const json = await runGraphql(rule, src.request, scope, env, cache);
        return getByPath(json, src.path);
      }
      case "var":
        return applyRegex(await scope.get(src.name), src.regex);
      case "format": {
        const names = Array.from(String(src.template).matchAll(/\{\{(\w+)\}\}/g), m => m[1]);
        for (const n of names) await scope.get(n);
        if (names.some(n => !scope.ctx[n])) return "";
        return fillVars(src.template, scope.ctx);
      }
      case "input": {
        const v = env.inputs && env.inputs[src.name];
        return applyRegex(v === undefined || v === null ? "" : String(v), src.regex);
      }
      case "literal":
        return src.value;
      default:
        throw new Error(`unknown source type "${src.from}"`);
    }
  }

  // Resolve every variable of `rule`. Never throws; problems are reported in the result.
  //   values  - visible variables that resolved to text (what gets sent to the prompt)
  //   found   - names of those variables
  //   missing - visible variables that resolved to nothing
  //   errors  - source-level failures (e.g. a GraphQL request that failed)
  //   warning - set when the rule does not apply to the current page
  async function extract(rule, env) {
    env = env || defaultEnv();
    const result = { values: {}, found: [], missing: [], errors: [], warning: "", trace: [], href: env.location.href };
    const vars = rule && rule.variables;
    if (!vars) return result;

    const visible = Object.keys(vars).filter(n => !vars[n].hidden);
    if (!pathMatches(rule, env)) {
      result.warning = (rule.match && rule.match.hint) || "This rule is not designed for the current page.";
      result.missing = visible;
      return result;
    }

    // Variables are resolved on demand: a variable that needs another one (via var/format/a request's variables)
    // resolves it first. Declaration order is irrelevant - chrome.storage does not preserve object key order.
    const ctx = Object.create(null);
    const cache = {};
    const active = new Set();
    const seenErrors = new Set();
    const scope = { ctx, get: getVar };

    async function getVar(name) {
      if (name in ctx) return ctx[name];
      const spec = vars[name];
      if (!spec || active.has(name)) return ""; // unknown variable, or a dependency cycle
      active.add(name);
      try {
        let value = "";
        const attempts = [];
        for (const src of spec.sources || []) {
          const label = `${src.from}${src.request || src.selector || src.name ? ":" + (src.request || src.selector || src.name) : ""}`;
          try {
            value = toText(await resolveSource(src, scope, rule, env, cache));
            attempts.push(`${label} ${value.trim() ? value.length + " chars" : "empty"}`);
          } catch (e) {
            const msg = `${src.from}${src.request ? ` "${src.request}"` : ""}: ${e.message}`;
            if (!seenErrors.has(msg)) {
              seenErrors.add(msg);
              result.errors.push(msg);
            }
            value = "";
            attempts.push(`${label} error`);
          }
          if (value.trim()) break;
        }
        value = postProcess(value, spec, env);
        ctx[name] = value;
        result.trace.push({ name, hidden: !!spec.hidden, attempts, preview: value.replace(/\s+/g, " ").slice(0, 50) });
        return value;
      } finally {
        active.delete(name);
      }
    }

    for (const name of Object.keys(vars)) await getVar(name);

    for (const name of visible) {
      if (ctx[name]) {
        result.values[name] = ctx[name];
        result.found.push(name);
      } else {
        result.missing.push(name);
      }
    }
    return result;
  }

  // ---------- rule validation (used by the registry's CI and by the extension before it installs anything) ----------
  const SOURCE_TYPES = ["url", "css", "graphql", "var", "format", "input", "literal"];
  const TRANSFORMS = ["htmlToText", "round2", "slugToTitle", "trim", "stripLineNumbers"];
  const INPUT_TYPES = ["text", "textarea", "select"];
  const TOP_LEVEL_KEYS = ["schemaVersion", "id", "version", "minEngine", "name", "description", "author", "domains", "tags",
    "match", "inputs", "requests", "variables", "text"];
  const BUILTIN_TEMPLATE_VARS = ["CONTENT", "URL", "TITLE", "DOMAIN", "GLOBAL_CONTEXT", "HISTORY"];

  // `text` may be written as an array of lines for readability; the stored/published form is one string.
  function normalizeRule(rule) {
    const out = JSON.parse(JSON.stringify(rule));
    if (Array.isArray(out.text)) out.text = out.text.join("\n");
    return out;
  }

  const placeholders = (str) => Array.from(String(str).matchAll(/\{\{(\w+)\}\}/g), m => m[1]);

  // Returns a list of problems; an empty list means the rule is well-formed and passes the safety rules.
  function validateRule(input) {
    const errors = [];
    const err = (m) => errors.push(m);
    if (!input || typeof input !== "object" || Array.isArray(input)) return ["rule must be an object"];
    const rule = normalizeRule(input);
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

    Object.keys(rule).forEach(k => { if (!TOP_LEVEL_KEYS.includes(k)) err(`unknown field "${k}"`); });
    if (JSON.stringify(rule).length > LIMITS.maxRuleBytes) err(`rule is larger than ${LIMITS.maxRuleBytes} bytes`);
    if (rule.schemaVersion !== 1) err("schemaVersion must be 1");
    if (typeof rule.id !== "string" || !/^[a-z0-9.-]+\/[a-z0-9-]+$/.test(rule.id)) err('id must look like "site/slug" (lowercase letters, digits, "-" and "."); use "general/..." for rules that apply to every site');
    if (!Number.isInteger(rule.version) || rule.version < 1) err("version must be a positive integer");
    if (!Number.isInteger(rule.minEngine) || rule.minEngine < 1) err("minEngine must be a positive integer");
    if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 80) err("name is required (max 80 characters)");
    if (typeof rule.description !== "string" || !rule.description.trim() || rule.description.length > 400) err("description is required (max 400 characters)");
    if (rule.author !== undefined && (typeof rule.author !== "string" || rule.author.length > 80)) err("author must be a string (max 80 characters)");
    if (!Array.isArray(rule.domains) || !rule.domains.length || rule.domains.length > 20 ||
        !rule.domains.every(d => d === "*" || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d))) {
      err('domains must be a non-empty list of host names such as "leetcode.com" (or "*" for every site)');
    }
    if (rule.tags !== undefined && (!Array.isArray(rule.tags) || rule.tags.length > 10 || !rule.tags.every(t => typeof t === "string" && /^[a-z0-9-]{1,30}$/.test(t)))) {
      err("tags must be up to 10 lowercase words");
    }
    if (typeof rule.text !== "string" || !rule.text.trim()) err("text (the prompt template) is required");

    // match
    if (rule.match !== undefined) {
      if (!isObj(rule.match)) err("match must be an object");
      else {
        if (rule.match.pathRegex !== undefined && !isSafeRegex(rule.match.pathRegex)) err("match.pathRegex is invalid, too long, or unsafe");
        if (rule.match.hint !== undefined && typeof rule.match.hint !== "string") err("match.hint must be a string");
      }
    }

    // inputs
    const inputKeys = [];
    if (rule.inputs !== undefined) {
      if (!Array.isArray(rule.inputs) || rule.inputs.length > 12) err("inputs must be a list of up to 12 fields");
      else rule.inputs.forEach((f, i) => {
        if (!isObj(f) || typeof f.key !== "string" || !/^\w+$/.test(f.key)) return err(`inputs[${i}].key must be a word`);
        if (inputKeys.includes(f.key)) err(`inputs: duplicate key "${f.key}"`);
        inputKeys.push(f.key);
        if (typeof f.label !== "string" || !f.label.trim()) err(`inputs[${f.key}].label is required`);
        if (!INPUT_TYPES.includes(f.type)) err(`inputs[${f.key}].type must be one of ${INPUT_TYPES.join(", ")}`);
        if (f.type === "select" && (!Array.isArray(f.options) || !f.options.length || !f.options.every(o => isObj(o) && typeof o.value === "string" && typeof o.label === "string"))) {
          err(`inputs[${f.key}] needs options [{ value, label }]`);
        }
      });
    }

    // requests
    const requests = rule.requests === undefined ? {} : rule.requests;
    if (!isObj(requests)) err("requests must be an object");
    else Object.entries(requests).forEach(([name, req]) => {
      if (!isObj(req)) return err(`requests.${name} must be an object`);
      if (req.endpoint !== undefined && (typeof req.endpoint !== "string" || !req.endpoint.startsWith("/") || req.endpoint.startsWith("//"))) {
        err(`requests.${name}.endpoint must be a path on the page's own site, like "/graphql"`);
      }
      const queries = Array.isArray(req.query) ? req.query : [req.query];
      if (!queries.length || !queries.every(isQueryOnly)) err(`requests.${name}.query must be one or more read-only GraphQL queries (no mutations or subscriptions)`);
      if (req.variables !== undefined && (!isObj(req.variables) || !Object.values(req.variables).every(v => typeof v === "string"))) err(`requests.${name}.variables must map names to strings`);
      if (req.numericVars !== undefined && (!Array.isArray(req.numericVars) || !req.numericVars.every(v => typeof v === "string"))) err(`requests.${name}.numericVars must be a list of names`);
    });

    // variables
    const variables = rule.variables === undefined ? {} : rule.variables;
    if (!isObj(variables)) err("variables must be an object");
    const deps = {};
    if (isObj(variables)) {
      Object.entries(variables).forEach(([name, spec]) => {
        if (!/^\w+$/.test(name)) err(`variable name "${name}" must be a word`);
        if (!isObj(spec) || !Array.isArray(spec.sources) || !spec.sources.length) return err(`variables.${name}.sources must be a non-empty list`);
        if (spec.transform !== undefined && !TRANSFORMS.includes(spec.transform)) err(`variables.${name}.transform must be one of ${TRANSFORMS.join(", ")}`);
        if (spec.map !== undefined && (!isObj(spec.map) || !Object.values(spec.map).every(v => typeof v === "string"))) err(`variables.${name}.map must map strings to strings`);
        if (spec.maxChars !== undefined && (!Number.isInteger(spec.maxChars) || spec.maxChars < 1)) err(`variables.${name}.maxChars must be a positive integer`);
        deps[name] = [];
        spec.sources.forEach((src, i) => {
          const where = `variables.${name}.sources[${i}]`;
          if (!isObj(src) || !SOURCE_TYPES.includes(src.from)) return err(`${where}.from must be one of ${SOURCE_TYPES.join(", ")}`);
          if (src.regex !== undefined && !isSafeRegex(src.regex)) err(`${where}.regex is invalid, too long, or unsafe`);
          if (src.from === "url" && !src.regex) err(`${where}: url sources need a regex`);
          if (src.from === "css" && (typeof src.selector !== "string" || !src.selector || src.selector.length > 300)) err(`${where}.selector is required (max 300 characters)`);
          if (src.from === "graphql") {
            if (!isObj(requests) || !requests[src.request]) err(`${where}.request "${src.request}" is not defined in requests`);
            else Object.values(requests[src.request].variables || {}).forEach(v => placeholders(v).forEach(n => deps[name].push(n)));
            if (typeof src.path !== "string" || !src.path) err(`${where}.path is required`);
          }
          if (src.from === "var") deps[name].push(src.name);
          if (src.from === "format") {
            if (typeof src.template !== "string") err(`${where}.template is required`);
            else placeholders(src.template).forEach(n => deps[name].push(n));
          }
          if (src.from === "input" && !inputKeys.includes(src.name)) err(`${where}.name "${src.name}" is not a declared input`);
          if (src.from === "literal" && typeof src.value !== "string") err(`${where}.value must be a string`);
        });
      });
      Object.entries(deps).forEach(([name, list]) => list.forEach(d => {
        if (!variables[d]) err(`variables.${name} refers to unknown variable "${d}"`);
      }));
      // dependency cycles
      const state = {};
      const visit = (n, path) => {
        if (state[n] === 2 || !variables[n]) return;
        if (state[n] === 1) return err(`variables form a cycle: ${path.concat(n).join(" -> ")}`);
        state[n] = 1;
        (deps[n] || []).forEach(d => visit(d, path.concat(n)));
        state[n] = 2;
      };
      Object.keys(variables).forEach(n => visit(n, []));
    }

    // template: may only use visible variables (hidden ones are helpers) and the built-in placeholders
    if (typeof rule.text === "string") {
      placeholders(rule.text).forEach(n => {
        const ok = BUILTIN_TEMPLATE_VARS.includes(n) || (isObj(variables) && variables[n] && !variables[n].hidden);
        if (!ok) err(`text uses {{${n}}}, which is neither a visible variable nor a built-in placeholder`);
      });
    }
    return Array.from(new Set(errors));
  }

  const api = {
    extract, htmlToText, hostMatches, ruleMatchesHost, pathMatches, isCompatible,
    validateRule, normalizeRule, isSafeRegex, isQueryOnly, ENGINE_VERSION, LIMITS
  };
  root.CHRuleEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
