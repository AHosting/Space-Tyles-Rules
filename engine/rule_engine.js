// Context Hypervisor - Declarative Rule Engine (content script)
//
// Rules are plain data (no code) so they can be shared/downloaded safely later.
// A rule with a `variables` map is resolved into { name: text } values that fill
// the {{placeholders}} in the rule's prompt template.
//
// variable  = { sources: [source, ...], transform?, map?, maxChars?, hidden?, fallback? }
//   - sources are tried in order; the first non-empty result wins.
//   - hidden variables are helpers: usable by other variables, never sent or reported.
//   - variables resolve on demand, so declaration order does not matter (chrome.storage reorders keys).
//   - fallback { label, type?, rows?, placeholder?, hint? } makes the variable degrade instead of failing:
//     when no source produced anything, it is reported in `needed` and the panel asks for it by hand. One
//     stale selector then costs one paste box rather than the whole rule, and a rule whose every visible
//     variable can fall back works on any site (see isPortable).
// source    = { from: "url" | "css" | "graphql" | "var" | "format" | "literal", regex?, ... }
//   url     { regex }                       regex over location.href (capture group 1)
//   css     { selector, attr?, regex?, frames? }  text (or attribute) of matching elements
//             frames: true searches this page's same-origin iframe documents instead of the page itself,
//             for sites that load their real content into a frame. Cross-origin frames are unreachable.
//   graphql { request, path }               value at `path` in a same-origin request's JSON
//   var     { name, regex? }                another variable
//   format  { template }                    "{{a}} {{b}}"; empty if any referenced var is empty
//   input   { name, regex? }                a value the user typed into the rule's form (see rule.inputs)
//   harvest { driver, regex? }        what a declarative driver collected (see drivers.js)
//   pdf     { pages?, regex? }        the text of the PDF open in the tab (see pdftext.js);
//                                     pages is "1-3,9,20-" and defaults to the whole document
//   literal { value }
// rule.inputs   = [{ key, label, type: "text" | "textarea" | "select", required?, placeholder?, rows?, default?, options? }]
//   - a rule with inputs shows a form in the modal; the values are read by `input` sources.
// rule.requests = { name: { endpoint?, query: string | [string], variables?, numericVars? } }
//   - `query` may list alternates; they are tried in order until one succeeds.
//   - requests are POSTed as JSON and only ever to the current page's own origin.
(function (root) {
  // Bumped when the engine gains a capability rules can rely on. Rules declare `minEngine`; an extension whose
  // engine is older than that must not run (or install) the rule.
  //   2 - variables may declare a `fallback`, so a rule can be written to survive a selector going stale.
  //   3 - css sources may set `frames: true` to read same-origin iframe documents.
  //   4 - `harvest` sources, which read what a declarative driver collected (see drivers.js, harvest.js).
  //   5 - `pdf` sources, which read the text of a PDF the panel has parsed (see pdftext.js).
  //   6 - an input may declare `grab`: where to read its value from the page, so a value that is ON the
  //       page does not have to be copied out of it by hand. See readSources below.
  //   7 - a variable may declare `timeSlice`: keep only the part of a timestamped text between two
  //       times. See applyTimeSlice.
  const ENGINE_VERSION = 7;

  // Sources that read the page the user is on. A variable built only from these is tied to one site; one with
  // a fallback is not, because it can be filled in by hand anywhere. Reading the URL counts: a rule that pulls
  // an id out of the address depends on the shape of that site's addresses, whatever its `domains` say.
  const PAGE_SOURCES = ["css", "url", "graphql", "harvest", "pdf"];

  // Rules can come from a public registry, so the engine enforces its own limits regardless of what a rule says.
  //
  // maxVariableChars is the ceiling on one extracted value, raised to 500,000 so a whole long-form essay can be
  // carried in one variable -- a 7,000-word piece reads as about 47,000 characters, and the old 50,000 ceiling
  // was close enough to truncate a longer one. defaultVariableChars is deliberately left at 20,000: a rule only
  // gets the big ceiling by asking for it with maxChars, so nothing already installed grows its prompts.
  //
  // What still bounds things, because this limit no longer does:
  //   - maxRegexInput caps what a REGEX is run over, not what a source may return. A regex cannot be
  //     interrupted once started, so that bound stays at 300,000: a source combining a regex with a value
  //     larger than that matches against the first 300,000 characters only.
  //   - usage.js truncates a stored transcript to 20,000 characters per field, and deferrals.js to 16,000, so
  //     neither store can be filled by one large prompt.
  //   - The engine a prompt is run on is now the real constraint. 500,000 characters is roughly 125,000
  //     tokens, which an API call will accept and charge for, and which pasting into a logged-in chat tab
  //     will almost certainly not survive.
  const LIMITS = {
    maxRegexLength: 300,
    maxRegexInput: 300000,
    defaultVariableChars: 20000,
    maxVariableChars: 500000,
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

  // ─── Keeping only part of a timestamped text ───────────────────────────────
  //
  // A transcript is the case this exists for. A rule that asks about ninety seconds of an eighty-four
  // minute video was sending all 100,000 characters of it and telling the model which part to read --
  // which works, and costs about 25,000 tokens a question to have the model do the discarding.
  //
  // A regex cannot do this: the bounds come from what the user typed at runtime and a rule's regexes
  // are fixed strings. So it is a declared property of the variable, resolved like any other.
  //
  //   timeSlice: { from, to?, before?, after?, stamp?, separator? }
  //
  // `from` and `to` name OTHER VARIABLES rather than carrying times themselves, so all the ordinary
  // machinery applies to them: an input the user typed, falling back to one read off the page, falling
  // back to a literal. The rule expresses "where I am now, unless I said otherwise" with sources, and
  // this just reads the answer.

  const TIME_IN_TEXT = "(\\d{1,2}:\\d{2}(?::\\d{2})?)";

  // "12:34" -> 754. "1:24:35" -> 5075. Anything else -> null, which means "no bound".
  function toSeconds(text) {
    // Three digits for the first group: a transcript of a two-hour talk may write 150:00 rather than
    // 2:30:00, and \d{1,2} would match from the "5" and place it fifty minutes in.
    const m = /(\d{1,3}):(\d{2})(?::(\d{2}))?/.exec(String(text || ""));
    if (!m) return null;
    return m[3] === undefined
      ? Number(m[1]) * 60 + Number(m[2])
      : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  const asClock = (sec) => {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
  };

  // Returns { text, kept, total, from, to } so the caller can report what it did. A chunk with no
  // readable time inherits the previous chunk's, because a wrapped transcript line is a continuation
  // of the one above it and dropping it would lose words from the middle of a sentence.
  function applyTimeSlice(value, cfg, fromText, toText_) {
    const sep = typeof cfg.separator === "string" && cfg.separator ? cfg.separator : "\n\n";
    const stampRe = new RegExp(cfg.stamp || TIME_IN_TEXT.replace(/\\\\/g, "\\"));
    const chunks = String(value || "").split(sep);

    const before = Number.isFinite(Number(cfg.before)) ? Number(cfg.before) : 0;
    const after = Number.isFinite(Number(cfg.after)) ? Number(cfg.after) : 0;

    let start = toSeconds(fromText);
    let end = toSeconds(toText_);

    // Only an end given: read from the beginning up to it. Only a start: a window after it, which is
    // what `after` is for -- without it, "from 12:30" would mean the whole rest of the video.
    if (start === null && end === null) return { text: value, kept: chunks.length, total: chunks.length, from: null, to: null };

    // Typed the wrong way round, or an end that lands before a start inherited from the player's
    // clock. Either way the user meant the stretch between the two numbers. Swapped BEFORE the
    // padding is applied -- doing it after turns a transposed pair into a sliver instead of the
    // stretch they asked for, which is a subtler wrong answer than an empty one.
    if (start !== null && end !== null && start > end) { const t = start; start = end; end = t; }

    if (start === null) start = 0;
    else start = Math.max(0, start - before);
    if (end === null) end = start + before + (after || 180);
    else end = end + after;

    let last = null;
    const kept = [];
    for (const chunk of chunks) {
      const m = stampRe.exec(chunk);
      const at = m ? toSeconds(m[1] !== undefined ? m[1] : m[0]) : null;
      if (at !== null) last = at;
      const when = at !== null ? at : last;
      // A chunk before the first readable timestamp has no time at all; it is page furniture, not
      // content, so it is left out rather than guessed at.
      if (when === null) continue;
      if (when >= start && when <= end) kept.push(chunk);
    }
    return { text: kept.join(sep).trim(), kept: kept.length, total: chunks.length, from: start, to: end };
  }

  function fillVars(str, ctx) {
    return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] || "");
  }

  // "3", "2-7", "1-3,9,20-", "" or "all" for the whole document. One-based and inclusive, because that is how
  // a reader numbers pages and a rule is written by a reader.
  //
  // Asking for pages a document does not have is not an error. A rule that says "the first twenty pages" is
  // expressing a budget, not an assertion, and a four page document should satisfy it with four pages rather
  // than failing and sending the user to a paste box.
  //
  // Pages come back IN THE ORDER THEY WERE ASKED FOR, not in document order. "12,1-3" is a rule author
  // putting the conclusion before the introduction on purpose, and silently re-sorting it would be the
  // engine overruling a decision it cannot see the reason for. Duplicates are dropped, because asking for
  // the same page twice is a typo in every case anyone has.
  const PAGES_SPEC = /^(all|\s*\d*\s*-?\s*\d*\s*(,\s*\d*\s*-?\s*\d*\s*)*)$/;

  function selectPdfPages(pages, spec) {
    const s = String(spec === undefined || spec === null ? "" : spec).trim();
    if (!s || s === "all") return pages.slice();
    const out = [];
    const seen = new Set();
    for (const part of s.split(",")) {
      const m = /^\s*(\d+)?\s*(-)?\s*(\d+)?\s*$/.exec(part);
      if (!m || (!m[1] && !m[3])) continue;
      const from = m[1] ? parseInt(m[1], 10) : 1;
      const to = m[2] ? (m[3] ? parseInt(m[3], 10) : pages.length) : from;
      for (let i = Math.max(1, from); i <= Math.min(to, pages.length); i++) {
        if (!seen.has(i)) {
          seen.add(i);
          out.push(pages[i - 1]);
        }
      }
    }
    return out;
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

  // A value typed or pasted by the user is already text, so two of the conversions must not run on it:
  // htmlToText would strip anything that looks like a tag out of pasted code, and `map` would blank the value
  // whenever it is not one of the enumerated keys, silently making the fallback useless. The length cap and
  // the text-tidying transforms still apply -- stripLineNumbers in particular, since code pasted out of a
  // rendered editor arrives with the gutter attached.
  function postProcessManual(value, spec, env) {
    const text = Object.assign({}, spec);
    if (text.transform === "htmlToText") delete text.transform;
    delete text.map;
    return postProcess(value, text, env);
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

  // The documents of this page's same-origin iframes.
  //
  // THE ORIGIN CHECK IS THE BROWSER'S, NOT OURS. contentDocument is null for a cross-origin frame, and in some
  // engines reading it throws; either way there is nothing to collect. So a rule cannot reach across an origin
  // however it is written, and reading a same-origin frame is no more access than the content script already
  // has over that origin's top document.
  //
  // One level only. Nesting is rare, the depth would be unbounded, and a reader shell frames its content once.
  function frameDocuments(env) {
    const docs = [];
    let frames;
    try {
      frames = Array.from(env.document.querySelectorAll("iframe"));
    } catch (e) {
      return docs;
    }
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument;
        if (doc && typeof doc.querySelectorAll === "function") docs.push(doc);
      } catch (e) {
        // Cross-origin, or a frame that has not finished loading. Neither is an error worth reporting.
      }
    }
    return docs;
  }

  async function resolveSource(src, scope, rule, env, cache) {
    switch (src.from) {
      case "url":
        return applyRegex(env.location.href, src.regex);
      case "css": {
        const parts = [];
        // `frames: true` looks inside same-origin iframes INSTEAD of this document, which is what makes a
        // reader shell readable: a page that loads its real content into a frame has nothing in the top
        // document to match. Searching instead of also-searching keeps it composable -- put the framed source
        // first and the plain one after it, and one rule covers both the shell and the standalone page.
        const docs = src.frames ? frameDocuments(env) : [env.document];
        for (const doc of docs) {
          // A selector list like "pre code, pre" matches nested elements; keep only the outermost so text
          // isn't duplicated. Done per document, since contains() does not reach across one.
          const matches = Array.from(doc.querySelectorAll(src.selector));
          matches.filter(el => !matches.some(other => other !== el && other.contains(el))).forEach(el => {
            const t = src.attr ? el.getAttribute(src.attr) : (el.innerText !== undefined ? el.innerText : el.textContent);
            if (t) parts.push(t);
          });
        }
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
      case "harvest": {
        // Reads what a driver ALREADY collected. It never starts one: a harvest scrolls the page and takes
        // seconds, and extraction runs on every keystroke of the preview. So the panel gathers on an explicit
        // press and hands the result in here, the same way it hands in text the user pasted. Empty until
        // then, which makes the variable missing, which is what puts the Gather button on screen.
        const v = env.harvested && env.harvested[src.driver];
        return applyRegex(v === undefined || v === null ? "" : String(v), src.regex);
      }
      case "pdf": {
        // Reads the PDF the panel has ALREADY parsed, for the same reason harvest reads an existing harvest:
        // parsing a 300 page document takes seconds and extraction runs on every keystroke of the preview.
        // Empty until the user presses Read, which is what puts that button on screen.
        const doc = env.pdf;
        if (!doc || !Array.isArray(doc.pages)) return "";
        const chosen = selectPdfPages(doc.pages, src.pages);
        return applyRegex(chosen.join("\n\n").trim(), src.regex);
      }
      case "literal":
        return src.value;
      default:
        throw new Error(`unknown source type "${src.from}"`);
    }
  }

  // A SHORT LIST OF SOURCES, resolved in order, first non-empty wins. This is what a variable does,
  // minus the transform, the cap and the fallback -- and it is exactly what an input's `grab` needs.
  //
  // Exported because the alternative was the panel reaching into resolveSource, or reimplementing the
  // order-and-first-non-empty rule next to the one here. Two implementations of "try these in order"
  // is how they come to disagree about what empty means.
  //
  // Never throws. A source that fails is skipped, which is the same thing a variable does with it.
  async function readSources(sources, env) {
    const scope = { ctx: Object.create(null), get: async () => "" };
    for (const src of sources || []) {
      try {
        const v = toText(await resolveSource(src, scope, { variables: {} }, env, {}));
        if (v && v.trim()) return v.trim();
      } catch (e) {
        // Try the next one. A grab offers several because the first is usually the readable one and
        // the readable one is usually the one that breaks.
      }
    }
    return "";
  }

  // Resolve every variable of `rule`. Never throws; problems are reported in the result.
  //   values   - visible variables that resolved to text (what gets sent to the prompt)
  //   found    - names of those variables
  //   missing  - visible variables that resolved to nothing
  //   needed   - the subset of `missing` the user can supply by hand, with the field to show for each
  //   supplied - visible variables that were filled from env.manual rather than from the page
  //   errors   - source-level failures (e.g. a GraphQL request that failed)
  //   warning  - set when the rule does not apply to the current page
  //
  // env.manual = { name: text } carries values the user has already typed into a fallback field.
  async function extract(rule, env) {
    env = env || defaultEnv();
    const result = {
      values: {}, found: [], missing: [], needed: [], supplied: [],
      errors: [], warning: "", trace: [], href: env.location.href
    };
    const vars = rule && rule.variables;
    if (!vars) return result;

    const visible = Object.keys(vars).filter(n => !vars[n].hidden);
    const fallbacks = visible.filter(n => vars[n].fallback);

    // The rule was not written for this page. Before fallbacks existed that was the end of it; now, if the
    // rule can be filled in by hand, we carry on with the page sources switched off -- which is what makes a
    // rule usable away from the site it was written for. Page sources are skipped rather than attempted so a
    // foreign page is not pointlessly queried or POSTed to.
    const offPage = !pathMatches(rule, env);
    if (offPage) {
      result.warning = (rule.match && rule.match.hint) || "This rule is not designed for the current page.";
      if (!fallbacks.length) {
        result.missing = visible;
        return result;
      }
    }

    // Variables are resolved on demand: a variable that needs another one (via var/format/a request's variables)
    // resolves it first. Declaration order is irrelevant - chrome.storage does not preserve object key order.
    const ctx = Object.create(null);
    const cache = {};
    const active = new Set();
    const seenErrors = new Set();
    const manualNames = new Set();
    const scope = { ctx, get: getVar };

    async function getVar(name) {
      if (name in ctx) return ctx[name];
      const spec = vars[name];
      if (!spec || active.has(name)) return ""; // unknown variable, or a dependency cycle
      active.add(name);
      try {
        let value = "";
        let manual = false;
        const attempts = [];
        for (const src of spec.sources || []) {
          const label = `${src.from}${src.request || src.selector || src.name ? ":" + (src.request || src.selector || src.name) : ""}`;
          if (offPage && PAGE_SOURCES.includes(src.from)) {
            attempts.push(`${label} skipped (other site)`);
            continue;
          }
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

        // THE SLICE HAPPENS BEFORE EVERYTHING ELSE, and before maxChars in particular. Capping first
        // would keep the first 200,000 characters and then look for a window inside them -- so asking
        // about minute 70 of a long video would find nothing, having already thrown minute 70 away.
        const sliceOf = async (text) => {
          if (!spec.timeSlice || !text.trim()) return text;
          const cfg = spec.timeSlice;
          const bound = async (which) => (which ? String(await scope.get(which) || "") : "");
          const got = applyTimeSlice(text, cfg, await bound(cfg.from), await bound(cfg.to));
          if (got.from === null && got.to === null) {
            attempts.push("timeSlice: no bounds given, kept all");
            return text;
          }
          // Said in the attempts log either way: a slice that kept nothing and one that was never
          // applied look identical in the output, and only one of them is a mistake.
          attempts.push(`timeSlice ${asClock(got.from)}-${asClock(got.to)}: kept ${got.kept} of ${got.total}`);
          return got.text;
        };

        try {
          value = await sliceOf(value);
        } catch (e) {
          // A bad stamp pattern must cost the slice, not the transcript.
          attempts.push("timeSlice failed");
          result.errors.push(`${name}: timeSlice failed: ${e.message}`);
        }

        const failed = (what, e) => {
          const msg = `${name}: ${what} failed: ${e.message}`;
          if (!seenErrors.has(msg)) {
            seenErrors.add(msg);
            result.errors.push(msg);
          }
          attempts.push("transform error");
        };

        // POST-PROCESSING COMES BEFORE THE FALLBACK, so the fallback is judged on the final value rather than
        // on whatever a source happened to return. A transform can empty a value a source filled: `map` does
        // it deliberately when nothing matches, and a transform can do it accidentally by throwing -- which
        // htmlToText will whenever DOMParser is unavailable. Judged the other way round, such a field was
        // reported as needed and then ignored everything the user pasted, because the source kept succeeding
        // and the transform kept failing on every later pass.
        //
        // The try also restores the contract above: a transform used to run outside any catch, so one failing
        // transform escaped extract entirely and took every other variable with it.
        try {
          value = postProcess(value, spec, env);
        } catch (e) {
          failed(spec.transform || "post-processing", e);
          value = "";
        }

        // Nothing survived and the rule says this one can be given by hand. A value the user has already
        // supplied is used; otherwise the field goes into `needed` below and the panel asks for it.
        if (!value.trim() && spec.fallback) {
          const typed = env.manual ? env.manual[name] : "";
          if (typed !== undefined && typed !== null && String(typed).trim()) {
            manual = true;
            attempts.push(`fallback ${String(typed).length} chars`);
            try {
              value = postProcessManual(await sliceOf(String(typed)), spec, env);
            } catch (e) {
              // Cannot realistically happen -- postProcessManual drops the only transform that throws -- but
              // a pasted value must never be lost to bookkeeping, so keep it and apply just the length cap.
              failed("post-processing a pasted value", e);
              value = postProcess(String(typed), { maxChars: spec.maxChars }, env);
            }
          } else {
            attempts.push("fallback empty");
          }
        }

        if (manual) manualNames.add(name);
        ctx[name] = value;
        result.trace.push({
          name, hidden: !!spec.hidden, manual, attempts,
          preview: value.replace(/\s+/g, " ").slice(0, 50)
        });
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
        if (manualNames.has(name)) result.supplied.push(name);
      } else {
        result.missing.push(name);
        const fb = vars[name].fallback;
        if (fb) {
          result.needed.push({
            name,
            label: fb.label || name,
            type: fb.type === "text" ? "text" : "textarea",
            rows: Number.isInteger(fb.rows) ? fb.rows : 5,
            placeholder: fb.placeholder || "",
            hint: fb.hint || ""
          });
        }
      }
    }

    // A rule that asked for nothing it could not get is not really off-page, whatever its pathRegex thinks.
    if (offPage && !result.missing.length) result.warning = "";
    return result;
  }

  // ---------- rule validation (used by the registry's CI and by the extension before it installs anything) ----------
  const SOURCE_TYPES = ["url", "css", "graphql", "var", "format", "input", "literal", "harvest", "pdf"];
  const TRANSFORMS = ["htmlToText", "round2", "slugToTitle", "trim", "stripLineNumbers"];
  const INPUT_TYPES = ["text", "textarea", "select"];
  const FALLBACK_TYPES = ["text", "textarea"];
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
  // ONE DEFINITION OF WHAT A SOURCE MAY BE, used by variables and by an input's `grab`.
  //
  // These checks were written inline inside the variables loop, which was fine while variables were the
  // only thing that had sources. A grab has sources too, and a second copy of "is this a valid css
  // source" is a second opinion that drifts: the day the engine gains a source type, one of the two
  // copies learns about it.
  //
  // `onDep` is how a var or format source reports what it depends on; a grab has no dependency graph to
  // contribute to, so it passes nothing and those sources are rejected for it below.
  function checkSource(src, where, rule, inputKeys, requests, onDep) {
    const errors = [];
    const err = (m) => errors.push(m);
    const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    const dep = typeof onDep === "function" ? onDep : null;

    if (!isObj(src) || !SOURCE_TYPES.includes(src.from)) {
      err(`${where}.from must be one of ${SOURCE_TYPES.join(", ")}`);
      return errors;
    }
    if (src.regex !== undefined && !isSafeRegex(src.regex)) err(`${where}.regex is invalid, too long, or prone to catastrophic backtracking`);
    if (src.from === "css" && (typeof src.selector !== "string" || !src.selector || src.selector.length > 300)) err(`${where}.selector is required (max 300 characters)`);
    if (src.frames !== undefined) {
      if (src.from !== "css") err(`${where}.frames only applies to css sources`);
      else if (typeof src.frames !== "boolean") err(`${where}.frames must be true or false`);
      else if (src.frames && Number.isInteger(rule.minEngine) && rule.minEngine < 3) err(`${where} reads frames, so minEngine must be at least 3`);
    }
    if (src.from === "graphql") {
      if (!isObj(requests) || !requests[src.request]) err(`${where}.request "${src.request}" is not defined in requests`);
      else if (dep) Object.values(requests[src.request].variables || {}).forEach(v => placeholders(v).forEach(n => dep(n)));
      if (typeof src.path !== "string" || !src.path) err(`${where}.path is required`);
    }
    if (src.from === "var") {
      if (!dep) err(`${where}: a var source cannot be used here`);
      else dep(src.name);
    }
    if (src.from === "format") {
      if (typeof src.template !== "string") err(`${where}.template is required`);
      else if (!dep) err(`${where}: a format source cannot be used here`);
      else placeholders(src.template).forEach(n => dep(n));
    }
    if (src.from === "input" && !inputKeys.includes(src.name)) err(`${where}.name "${src.name}" is not a declared input`);
    if (src.from === "literal" && typeof src.value !== "string") err(`${where}.value must be a string`);
    if (src.from === "harvest") {
      if (typeof src.driver !== "string" || !/^[a-z0-9.-]+\/[a-z0-9-]+$/.test(src.driver)) err(`${where}.driver must be a driver id like "x.com/thread"`);
      if (Number.isInteger(rule.minEngine) && rule.minEngine < 4) err(`${where} is a harvest source, so minEngine must be at least 4`);
    }
    if (src.from === "pdf") {
      if (src.pages !== undefined) {
        if (typeof src.pages !== "string") err(`${where}.pages must be a string like "1-20"`);
        else if (!PAGES_SPEC.test(src.pages)) err(`${where}.pages must look like "3", "2-7", "1-3,9,20-" or "all"`);
      }
      if (Number.isInteger(rule.minEngine) && rule.minEngine < 5) err(`${where} is a pdf source, so minEngine must be at least 5`);
    }
    return errors;
  }

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

        // GRAB: where this input's value can be read from the page, so a value that is already on the
        // page is not copied out of it by hand. A grab's sources are ordinary sources and are checked
        // by the ordinary source validator -- it is the same machinery, not a parallel one.
        if (f.grab !== undefined) {
          const g = f.grab;
          const at = `inputs[${f.key}].grab`;
          // Read off the rule directly: `requests` and `variables` are declared further down, and a
          // grab is checked up here because it belongs to the input it is attached to.
          const reqs = isObj(rule.requests) ? rule.requests : {};
          if (!isObj(g)) err(`${at} must be an object`);
          else {
            Object.keys(g).forEach(k => {
              if (!["label", "sources", "hover"].includes(k)) err(`unknown field "${at}.${k}"`);
            });
            if (g.label !== undefined && (typeof g.label !== "string" || g.label.length > 40)) err(`${at}.label must be a short string`);
            if (!Array.isArray(g.sources) || !g.sources.length || g.sources.length > 6) err(`${at}.sources must be a list of 1 to 6 sources`);
            else g.sources.forEach((src, j) => checkSource(src, `${at}.sources[${j}]`, rule, inputKeys, reqs).forEach(err));

            // HOVER: the same read, but taken while the pointer is somewhere rather than now. It is for
            // a value that only exists under the pointer -- a scrub bar's tooltip is the case this was
            // built for, where seeking to the end of a range to capture it moves you away from where
            // you were. `over` is the region that arms it; the sources are read at the click.
            if (g.hover !== undefined) {
              const h = g.hover;
              const hat = `${at}.hover`;
              if (!isObj(h)) err(`${hat} must be an object`);
              else {
                Object.keys(h).forEach(k => {
                  if (!["label", "over", "sources"].includes(k)) err(`unknown field "${hat}.${k}"`);
                });
                if (h.label !== undefined && (typeof h.label !== "string" || h.label.length > 40)) err(`${hat}.label must be a short string`);
                if (typeof h.over !== "string" || !h.over.trim() || h.over.length > 300) err(`${hat}.over must be a CSS selector for the area to hover over`);
                if (!Array.isArray(h.sources) || !h.sources.length || h.sources.length > 6) err(`${hat}.sources must be a list of 1 to 6 sources`);
                else h.sources.forEach((src, j) => checkSource(src, `${hat}.sources[${j}]`, rule, inputKeys, reqs).forEach(err));
              }
            }
            if (Number.isInteger(rule.minEngine) && rule.minEngine < 6) err(`${at} needs minEngine 6 or newer`);
          }
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
        if (spec.timeSlice !== undefined) {
          const t = spec.timeSlice;
          const at = `variables.${name}.timeSlice`;
          if (!isObj(t)) err(`${at} must be an object`);
          else {
            Object.keys(t).forEach(k => {
              if (!["from", "to", "before", "after", "stamp", "separator"].includes(k)) err(`unknown field "${at}.${k}"`);
            });
            if (typeof t.from !== "string" || !t.from) err(`${at}.from must name the variable holding the start time`);
            if (t.to !== undefined && typeof t.to !== "string") err(`${at}.to must name a variable`);
            ["before", "after"].forEach(k => {
              if (t[k] !== undefined && (!Number.isInteger(t[k]) || t[k] < 0 || t[k] > 7200)) err(`${at}.${k} must be a whole number of seconds (0-7200)`);
            });
            if (t.stamp !== undefined && !isSafeRegex(t.stamp)) err(`${at}.stamp is invalid, too long, or unsafe`);
            if (t.separator !== undefined && (typeof t.separator !== "string" || !t.separator)) err(`${at}.separator must be a string`);
            if (Number.isInteger(rule.minEngine) && rule.minEngine < 7) err(`${at} needs minEngine 7 or newer`);
            // The bounds are variables, so they are part of the dependency graph like anything else.
            // deps[name] is initialised further down this same loop; a timeSlice is checked before
            // the sources are, so it creates the list rather than assuming one.
            deps[name] = deps[name] || [];
            [t.from, t.to].forEach(d => { if (typeof d === "string" && d) deps[name].push(d); });
          }
        }
        if (spec.fallback !== undefined) {
          const fb = spec.fallback;
          if (!isObj(fb)) err(`variables.${name}.fallback must be an object`);
          else {
            if (typeof fb.label !== "string" || !fb.label.trim() || fb.label.length > 80) err(`variables.${name}.fallback.label is required (max 80 characters)`);
            if (fb.type !== undefined && !FALLBACK_TYPES.includes(fb.type)) err(`variables.${name}.fallback.type must be one of ${FALLBACK_TYPES.join(", ")}`);
            if (fb.rows !== undefined && (!Number.isInteger(fb.rows) || fb.rows < 1 || fb.rows > 30)) err(`variables.${name}.fallback.rows must be a whole number between 1 and 30`);
            ["placeholder", "hint"].forEach(k => {
              if (fb[k] !== undefined && (typeof fb[k] !== "string" || fb[k].length > 200)) err(`variables.${name}.fallback.${k} must be a string (max 200 characters)`);
            });
            // A hidden variable is a helper no one is shown, so there is no field to put in front of the user.
            if (spec.hidden) err(`variables.${name} is hidden, so it cannot have a fallback`);
            if (Number.isInteger(rule.minEngine) && rule.minEngine < 2) err(`variables.${name} has a fallback, so minEngine must be at least 2`);
          }
        }
        deps[name] = deps[name] || [];
        spec.sources.forEach((src, i) => {
          checkSource(src, `variables.${name}.sources[${i}]`, rule, inputKeys, requests, (d) => deps[name].push(d)).forEach(err);
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

  // A rule is portable when it can be used away from the site it was written for, which is what decides
  // whether the panel offers it on other hosts.
  //
  // THREE ways for a variable to qualify.
  //
  //   1. It never reads the page, so it is site-independent by construction: everything it sends comes from
  //      what the user types, from literals, or from other variables. The manual-entry rules are like this,
  //      and there is no reason they should only appear on the domains they declare -- a form asking for a
  //      problem title and some code is as usable on a tutorial site as on the site it came from.
  //   2. It declares a fallback, so it can be pasted in instead.
  //   3. Its source list ends in a non-empty literal. Sources are tried in order and the first non-empty one
  //      wins, so such a variable cannot come out empty whatever the page does -- the literal is a declared
  //      default, not a page read. This is the shape of an optional section: try the selector, otherwise say
  //      "(none shown on this page)". Without this case a rule was called unportable because of a variable
  //      that was never going to fail, which is the opposite of what the flag is for.
  //
  // Only visible variables are examined. Hidden ones are helpers reachable only through a visible variable, so
  // if every visible variable can be filled in by hand, nothing depends on the helpers resolving -- which is
  // just as well, since a hidden variable is not allowed a fallback.
  function isPortable(rule) {
    const obj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    if (!rule || !obj(rule.variables)) return false;
    const visible = Object.values(rule.variables).filter(spec => obj(spec) && !spec.hidden);
    if (!visible.length) return false;

    const hasDefault = (spec) => {
      const sources = spec.sources || [];
      const last = sources[sources.length - 1];
      return !!last && last.from === "literal" && typeof last.value === "string" && !!last.value.trim();
    };

    return visible.every(spec =>
      !!spec.fallback ||
      hasDefault(spec) ||
      (spec.sources || []).every(src => !PAGE_SOURCES.includes(src.from))
    );
  }

  // The vocabulary is exported, not just enforced. An authoring tool that hard-codes its own list of source
  // types and transforms is a second definition of the schema, and the two drift the moment the engine
  // gains a capability -- which it has done five times. A builder reads these and is right by construction.
  const api = {
    extract, htmlToText, hostMatches, ruleMatchesHost, pathMatches, isCompatible, isPortable,
    validateRule, normalizeRule, isSafeRegex, isQueryOnly, selectPdfPages, readSources, ENGINE_VERSION, LIMITS,
    SOURCE_TYPES, PAGE_SOURCES, TRANSFORMS, INPUT_TYPES, FALLBACK_TYPES
  };
  root.CHRuleEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
