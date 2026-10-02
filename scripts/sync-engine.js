// The rule engine lives in the extension. This repo keeps a copy so CI can validate rules and run their tests.
//   npm run sync-engine            copy ../ChrExt/rule_engine.js into engine/
//   npm run sync-engine -- --check report whether the copy is out of date (exit 1 if so)
const fs = require("fs");
const path = require("path");

// Both files are needed: the validator uses rule_engine.js for rules and drivers.js for drivers, and
// drivers.js calls into CHRuleEngine for its regex safety check.
const FILES = ["rule_engine.js", "drivers.js"];
const DIR = process.env.EXTENSION_DIR || path.resolve(__dirname, "../../ChrExt");

const missing = FILES.filter(f => !fs.existsSync(path.join(DIR, f)));
if (missing.length) {
  console.log("Extension files not found in " + DIR + ": " + missing.join(", ") + ". Set EXTENSION_DIR to its folder.");
  process.exit(process.argv.includes("--check") ? 0 : 1);
}

const state = FILES.map(f => {
  const copy = path.resolve(__dirname, "../engine", f);
  const same = fs.existsSync(copy) && fs.readFileSync(path.join(DIR, f), "utf8") === fs.readFileSync(copy, "utf8");
  return { f, copy, same };
});

if (process.argv.includes("--check")) {
  const stale = state.filter(x => !x.same);
  stale.forEach(x => console.log("\u2717 engine/" + x.f + " differs from the extension's"));
  if (!stale.length) console.log("\u2713 engine copies are up to date");
  else console.log("  run: npm run sync-engine");
  process.exit(stale.length ? 1 : 0);
}

fs.mkdirSync(path.resolve(__dirname, "../engine"), { recursive: true });
state.forEach(x => {
  fs.copyFileSync(path.join(DIR, x.f), x.copy);
  console.log(x.same ? "engine/" + x.f + " was already up to date" : "\u2713 copied " + x.f + " into engine/");
});
