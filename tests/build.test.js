const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { build, DIST } = require("../scripts/build");
const { sha256, engine, drivers } = require("../scripts/lib");

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

test("the catalogue lists every driver with a hash that matches the published file", () => {
  const index = build();
  assert.ok(Array.isArray(index.drivers), "the catalogue always has a drivers array, even when empty");
  const ids = index.drivers.map(d => d.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), "sorted by id");
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (const entry of index.drivers) {
    const bytes = fs.readFileSync(path.join(DIST, entry.path));
    assert.equal(sha256(bytes), entry.sha256, entry.id);
    const driver = JSON.parse(bytes.toString("utf8"));
    assert.equal(driver.id, entry.id);
    assert.equal(driver.version, entry.version);
    assert.deepEqual(drivers.validateDriver(driver), [], entry.id);
    assert.ok(entry.minEngine <= engine.ENGINE_VERSION, "the copy of the engine in this repo must support every driver");
    assert.ok(entry.path.startsWith("drivers/"), "driver paths live under drivers/");
    // A driver that clicks must say what text it will click. Enforced here as well as in the validator,
    // because this is the one property whose loss would not be obvious from reading a diff.
    if (driver.harvest && driver.harvest.expand) {
      assert.ok(typeof driver.harvest.expand.textMatches === "string" && driver.harvest.expand.textMatches.trim(),
        entry.id + ": a driver that clicks must declare textMatches");
    }
  }
});

test("every driver a rule asks for is actually published", () => {
  const index = build();
  const published = new Set(index.drivers.map(d => d.id));
  for (const entry of index.rules) {
    const rule = JSON.parse(fs.readFileSync(path.join(DIST, entry.path), "utf8"));
    for (const id of drivers.requiredBy(rule)) {
      assert.ok(published.has(id), entry.id + " needs driver " + id + ", which this catalogue does not publish");
    }
  }
});

test("the browse site is published next to the catalogue", () => {
  build();
  assert.ok(fs.existsSync(path.join(DIST, "index.html")));
  assert.ok(fs.existsSync(path.join(DIST, ".nojekyll")));
});
