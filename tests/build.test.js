const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { build, DIST } = require("../scripts/build");
const { sha256, engine } = require("../scripts/lib");

test("the catalogue lists every rule with a hash that matches the published file", () => {
  const index = build();
  assert.equal(index.schemaVersion, 1);
  assert.ok(index.rules.length >= 4);
  const ids = index.rules.map(r => r.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), "sorted by id");
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (const entry of index.rules) {
    const bytes = fs.readFileSync(path.join(DIST, entry.path));
    assert.equal(sha256(bytes), entry.sha256, entry.id);
    const rule = JSON.parse(bytes.toString("utf8"));
    assert.equal(rule.id, entry.id);
    assert.equal(rule.version, entry.version);
    assert.equal(typeof rule.text, "string", "published rules have a single-string template");
    assert.deepEqual(engine.validateRule(rule), [], entry.id);
    assert.ok(entry.minEngine <= engine.ENGINE_VERSION, "the copy of the engine in this repo must support every rule");
    assert.ok(!entry.path.startsWith("/") && !/^[a-z]+:/.test(entry.path), "paths are relative");
  }
});

test("the browse site is published next to the catalogue", () => {
  build();
  assert.ok(fs.existsSync(path.join(DIST, "index.html")));
  assert.ok(fs.existsSync(path.join(DIST, ".nojekyll")));
});
