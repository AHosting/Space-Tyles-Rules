// Declarative page drivers.
//
// A driver is DATA, not code. It parameterises one first-party harvest engine (harvest.js) that scrolls a
// page and collects what appears, so a rule can read a whole X thread rather than the handful of tweets that
// happen to be on screen.
//
// WHY DATA AND NOT CODE. Everything the registry's safety model rests on comes from rules being decidable:
// validateRule proves there are no mutations, no cross-origin requests, no catastrophic regexes. No equivalent
// function can exist for arbitrary code, so a code driver would have to be reviewed by a human, and its
// consent screen would be a claim its author typed rather than a fact derived from the thing itself. A
// driver's description below is COMPUTED from its own fields, exactly as describeRule is, so it cannot lie.
// MV3 also forbids remotely-hosted code outright; data sidesteps that entirely.
//
// WHAT A HARVEST ACTUALLY NEEDS turns out to be four things -- what to collect, what makes one item distinct,
// what to scroll, and when to stop -- plus an optional bounded click. That covers X, Reddit, Hacker News and
// most virtualised or paginated pages, because the shape of the problem is the same everywhere and only the
// selectors differ.
//
// Loaded by the side panel (lists and installs), the content script (runs them) and the registry.
const CHDrivers = (() => {
  const KEY = "drivers";
  const ID = /^[a-z0-9.-]+\/[a-z0-9-]+$/;

  // Bounds the engine enforces whatever a driver asks for. A driver moves someone's page: it must not be able
  // to scroll forever, click a hundred things, or sit there for a minute.
  const LIMITS = {
    maxPasses: 200,
    maxItems: 5000,
    maxMs: 120000,
    maxClicks: 100,
    maxSettleMs: 5000,
    maxSelector: 300,
    maxDriverBytes: 8000
  };

  const DEFAULTS = {
    scroll: "window",
    maxPasses: 40,
    settleMs: 450,
    stopAfterQuietPasses: 2,
    maxItems: 500,
    maxMs: 45000
  };

  const store = () => chrome.storage.local;
  const obj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const safeRegex = (p) => (typeof CHRuleEngine !== "undefined" ? CHRuleEngine.isSafeRegex(p) : typeof p === "string");

  // ─── Validation ────────────────────────────────────────────────────────────

  const TOP_LEVEL = ["schemaVersion", "id", "version", "minEngine", "name", "description", "author", "domains", "tags", "match", "harvest"];

  function validateDriver(input) {
    const errors = [];
    const err = (m) => errors.push(m);
    if (!obj(input)) return ["driver must be an object"];
    const d = input;

    Object.keys(d).forEach((k) => { if (!TOP_LEVEL.includes(k)) err(`unknown field "${k}"`); });
    if (JSON.stringify(d).length > LIMITS.maxDriverBytes) err(`driver is larger than ${LIMITS.maxDriverBytes} bytes`);
    if (d.schemaVersion !== 1) err("schemaVersion must be 1");
    if (typeof d.id !== "string" || !ID.test(d.id)) err('id must look like "site/slug"');
    if (!Number.isInteger(d.version) || d.version < 1) err("version must be a positive integer");
    if (!Number.isInteger(d.minEngine) || d.minEngine < 1) err("minEngine must be a positive integer");
    if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 80) err("name is required (max 80 characters)");
    if (typeof d.description !== "string" || !d.description.trim() || d.description.length > 400) err("description is required (max 400 characters)");
    if (d.author !== undefined && (typeof d.author !== "string" || d.author.length > 80)) err("author must be a string (max 80 characters)");
    if (!Array.isArray(d.domains) || !d.domains.length || d.domains.length > 20 ||
        !d.domains.every((x) => x === "*" || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(x))) {
      err('domains must be a non-empty list of host names such as "x.com"');
    }
    if (d.tags !== undefined && (!Array.isArray(d.tags) || d.tags.length > 10 || !d.tags.every((t) => typeof t === "string" && /^[a-z0-9-]{1,30}$/.test(t)))) {
      err("tags must be up to 10 lowercase words");
    }

    if (d.match !== undefined) {
      if (!obj(d.match)) err("match must be an object");
      else {
        if (d.match.pathRegex !== undefined && !safeRegex(d.match.pathRegex)) err("match.pathRegex is invalid, too long, or unsafe");
        if (d.match.hint !== undefined && typeof d.match.hint !== "string") err("match.hint must be a string");
      }
    }

    const h = d.harvest;
    if (!obj(h)) return errors.concat("harvest is required and must be an object");

    const sel = (v, where) => {
      if (typeof v !== "string" || !v.trim() || v.length > LIMITS.maxSelector) err(`${where} must be a CSS selector (max ${LIMITS.maxSelector} characters)`);
    };
    const num = (v, where, min, max, required) => {
      if (v === undefined) { if (required) err(`${where} is required`); return; }
      if (!Number.isInteger(v) || v < min || v > max) err(`${where} must be a whole number between ${min} and ${max}`);
    };

    Object.keys(h).forEach((k) => {
      if (!["item", "key", "scroll", "maxPasses", "settleMs", "stopAfterQuietPasses", "maxItems", "maxMs", "expand"].includes(k)) {
        err(`unknown field "harvest.${k}"`);
      }
    });

    sel(h.item, "harvest.item");
    if (h.scroll !== undefined && h.scroll !== "window") sel(h.scroll, "harvest.scroll");

    if (h.key !== undefined) {
      if (!obj(h.key)) err("harvest.key must be an object");
      else {
        Object.keys(h.key).forEach((k) => {
          if (!["selector", "attr", "regex"].includes(k)) err(`unknown field "harvest.key.${k}"`);
        });
        if (h.key.selector !== undefined) sel(h.key.selector, "harvest.key.selector");
        if (h.key.attr !== undefined && (typeof h.key.attr !== "string" || !h.key.attr)) err("harvest.key.attr must be an attribute name");
        if (h.key.regex !== undefined && !safeRegex(h.key.regex)) err("harvest.key.regex is invalid, too long, or unsafe");
      }
    }

    num(h.maxPasses, "harvest.maxPasses", 1, LIMITS.maxPasses);
    num(h.settleMs, "harvest.settleMs", 0, LIMITS.maxSettleMs);
    num(h.stopAfterQuietPasses, "harvest.stopAfterQuietPasses", 1, 10);
    num(h.maxItems, "harvest.maxItems", 1, LIMITS.maxItems);
    num(h.maxMs, "harvest.maxMs", 1000, LIMITS.maxMs);

    if (h.expand !== undefined) {
      if (!obj(h.expand)) err("harvest.expand must be an object");
      else {
        Object.keys(h.expand).forEach((k) => {
          if (!["selector", "textMatches", "maxClicks", "within"].includes(k)) err(`unknown field "harvest.expand.${k}"`);
        });
        sel(h.expand.selector, "harvest.expand.selector");
        if (h.expand.within !== undefined) sel(h.expand.within, "harvest.expand.within");
        // REQUIRED, not optional. A click with no constraint on what it lands on is the one thing in this
        // schema that could do something irreversible, so a driver has to say in words what it is clicking.
        if (typeof h.expand.textMatches !== "string" || !h.expand.textMatches.trim()) {
          err("harvest.expand.textMatches is required: a click must say what text it will only ever click");
        } else if (!safeRegex(h.expand.textMatches)) {
          err("harvest.expand.textMatches is invalid, too long, or unsafe");
        }
        num(h.expand.maxClicks, "harvest.expand.maxClicks", 1, LIMITS.maxClicks);
      }
    }

    return Array.from(new Set(errors));
  }

  // Fills in the defaults and clamps everything to LIMITS, so the runner can trust what it is handed.
  function settings(driver) {
    const h = (driver && driver.harvest) || {};
    const clamp = (v, d, max) => Math.min(Number.isInteger(v) ? v : d, max);
    return {
      item: h.item,
      key: obj(h.key) ? h.key : null,
      scroll: h.scroll || DEFAULTS.scroll,
      maxPasses: clamp(h.maxPasses, DEFAULTS.maxPasses, LIMITS.maxPasses),
      settleMs: clamp(h.settleMs, DEFAULTS.settleMs, LIMITS.maxSettleMs),
      stopAfterQuietPasses: clamp(h.stopAfterQuietPasses, DEFAULTS.stopAfterQuietPasses, 10),
      maxItems: clamp(h.maxItems, DEFAULTS.maxItems, LIMITS.maxItems),
      maxMs: clamp(h.maxMs, DEFAULTS.maxMs, LIMITS.maxMs),
      expand: obj(h.expand) ? {
        selector: h.expand.selector,
        textMatches: h.expand.textMatches,
        within: h.expand.within || "",
        maxClicks: clamp(h.expand.maxClicks, 10, LIMITS.maxClicks)
      } : null
    };
  }

  // ─── What it will do, in English, derived from the driver itself ───────────
  //
  // Every noun here is read out of the driver. Nothing is a claim its author typed, which is the property a
  // code driver could not have and the reason this is worth the constraint.
  function describeDriver(driver) {
    const s = settings(driver);
    const lines = [
      `Collect everything matching ${s.item} on the page.`,
      s.scroll === "window"
        ? `Scroll the page down up to ${s.maxPasses} times, pausing ${s.settleMs}ms each time for more to load.`
        : `Scroll ${s.scroll} down up to ${s.maxPasses} times, pausing ${s.settleMs}ms each time for more to load.`,
      `Stop early once ${s.stopAfterQuietPasses} scrolls in a row add nothing new, at ${s.maxItems} items, or after ${Math.round(s.maxMs / 1000)} seconds.`,
      "Put the scroll position back where it was."
    ];
    if (s.expand) {
      const where = s.expand.within
        ? `inside ${s.expand.within}`
        : (s.scroll === "window" ? "anywhere on the page" : `inside ${s.scroll}`);
      lines.push(`Click up to ${s.expand.maxClicks} elements matching ${s.expand.selector} ${where}, but only ones whose text matches /${s.expand.textMatches}/i, which are not links to another site, and are not inside a form.`);
    }
    return {
      domains: driver.domains || [],
      hint: driver.match && driver.match.hint,
      reads: s.item,
      clicks: s.expand ? s.expand.textMatches : "",
      lines
    };
  }

  // ─── Store ─────────────────────────────────────────────────────────────────

  const load = async () => {
    try {
      const got = (await store().get(KEY))[KEY];
      return Array.isArray(got) ? got : [];
    } catch (e) {
      return [];
    }
  };

  // The driver ITSELF, without the store's bookkeeping.
  //
  // install() records where a driver came from and when, by spreading those onto the driver object. That
  // is convenient for the library, which wants to show both -- and it quietly made every installed
  // driver unrunnable, because validateDriver whitelists the schema's fields and rightly refuses
  // anything it does not recognise. The error read "That driver is not valid: unknown field installedAt",
  // which is true, unhelpful, and describes a file the extension wrote itself.
  //
  // The validator stays strict: refusing unknown fields is how a driver cannot smuggle anything past
  // review. It is the caller's job to hand it a driver rather than a database row.
  const bare = (driver) => {
    const out = {};
    TOP_LEVEL.forEach((k) => { if (driver && driver[k] !== undefined) out[k] = driver[k]; });
    return out;
  };

  async function install(driver, source) {
    const kept = (await load()).filter((d) => d.id !== driver.id);
    kept.push({ ...driver, source: source || { registry: "pasted" }, installedAt: Date.now() });
    await store().set({ [KEY]: kept });
  }

  const remove = async (id) => store().set({ [KEY]: (await load()).filter((d) => d.id !== id) });
  const byId = (list, id) => (list || []).find((d) => d.id === id) || null;

  function matchesHost(driver, host) {
    if (typeof CHRuleEngine === "undefined") return true;
    const list = Array.isArray(driver.domains) && driver.domains.length ? driver.domains : ["*"];
    return list.some((d) => CHRuleEngine.hostMatches(d, host));
  }

  // The driver ids a rule needs, read off its harvest sources.
  function requiredBy(rule) {
    const out = [];
    Object.values((rule && rule.variables) || {}).forEach((spec) => {
      (spec.sources || []).forEach((src) => {
        if (src && src.from === "harvest" && typeof src.driver === "string" && !out.includes(src.driver)) out.push(src.driver);
      });
    });
    return out;
  }

  // WHETHER PRESSING RUN SHOULD GATHER FIRST.
  //
  // Gathering is explicit because it moves someone's page for up to a minute, and because extraction
  // has to stay cheap -- it runs on every keystroke of the preview, so a harvest can never live inside
  // it. Neither of those argues for making the user press TWO buttons when they have already said what
  // they want: Run means "do what it takes".
  //
  // It gathers only when all four are true, because each one is a way of being wrong otherwise:
  //   the rule needs a driver            - nothing to gather for
  //   the driver is installed            - gathering is impossible, and the panel already says so
  //   nothing has been gathered yet      - re-scrolling a page we already read is pure cost
  //   something is actually missing      - if the user pasted the text by hand, leave their page alone
  //
  // Returns the driver id to gather, or "".
  function wantedBy(rule, extraction, harvested, installedDrivers) {
    const ids = requiredBy(rule);
    if (!ids.length) return "";
    const id = ids[0];
    if (!byId(installedDrivers || [], id)) return "";
    if (harvested && harvested[id]) return "";

    // No extraction yet means nothing has been compiled, so there is nothing to say it is unnecessary.
    if (!extraction) return id;

    const missing = new Set([
      ...(extraction.needed || []).map((f) => f.name),
      ...(extraction.missing || [])
    ]);
    const wanted = Object.entries((rule && rule.variables) || {}).some(([name, spec]) =>
      missing.has(name) && (spec.sources || []).some((s) => s && s.from === "harvest" && s.driver === id));
    return wanted ? id : "";
  }

  return { KEY, LIMITS, DEFAULTS, TOP_LEVEL, validateDriver, settings, describeDriver, bare, load, install, remove, byId, matchesHost, requiredBy, wantedBy };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CHDrivers;
